#!/usr/bin/env node
// Builds resources/bin/transcribe-sidecar-<platform>-<arch>, the native host
// for transcribe.cpp GGUF models. It links against the prebuilt libtranscribe
// from the @transcribe-cpp platform package (installed as an optional npm
// dependency); the headers in resources/transcribe-sidecar/include are the
// matching v0.4.0 public headers. Linux only for now.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PLATFORM_PACKAGES = {
  "linux-x64": "linux-x64-cpu-vulkan",
  "linux-arm64": "linux-arm64-cpu-vulkan",
};
const platformArch = `${process.platform}-${process.arch}`;
const pkg = PLATFORM_PACKAGES[platformArch];

function log(message) {
  console.log(`[transcribe-sidecar] ${message}`);
}

if (!pkg) {
  log(`skipping: no transcribe.cpp sidecar for ${platformArch}`);
  process.exit(0);
}

const projectRoot = path.resolve(__dirname, "..");
const sourceDir = path.join(projectRoot, "resources", "transcribe-sidecar");
const source = path.join(sourceDir, "transcribe-sidecar.c");
const outputBinary = path.join(
  projectRoot,
  "resources",
  "bin",
  `transcribe-sidecar-${platformArch}`
);

let libDir;
try {
  libDir = path.dirname(require.resolve(`@transcribe-cpp/${pkg}/package.json`));
} catch {
  log(`skipping: @transcribe-cpp/${pkg} is not installed`);
  process.exit(0);
}

const contract = JSON.parse(fs.readFileSync(path.join(libDir, "contract.json"), "utf8"));
const headerHash = fs
  .readFileSync(path.join(sourceDir, "include", "transcribe.abihash"), "utf8")
  .trim();
if (contract.header_hash !== headerHash) {
  console.error(
    `[transcribe-sidecar] header ABI ${headerHash} does not match library ${contract.header_hash}; ` +
      "update resources/transcribe-sidecar/include from the matching transcribe.cpp tag"
  );
  process.exit(1);
}

const inputs = [source, path.join(libDir, "libtranscribe.so"), __filename];
if (fs.existsSync(outputBinary)) {
  const built = fs.statSync(outputBinary).mtimeMs;
  if (inputs.every((file) => fs.statSync(file).mtimeMs <= built)) {
    log("up to date");
    process.exit(0);
  }
}

fs.mkdirSync(path.dirname(outputBinary), { recursive: true });
const args = [
  "-std=c11",
  "-D_POSIX_C_SOURCE=200809L",
  "-O2",
  "-Wall",
  "-Wextra",
  "-I",
  path.join(sourceDir, "include"),
  source,
  "-L",
  libDir,
  "-ltranscribe",
  "-o",
  outputBinary,
];
for (const compiler of ["cc", "gcc", "clang"]) {
  const result = spawnSync(compiler, args, { stdio: "inherit" });
  if (result.error?.code === "ENOENT") continue;
  if (result.status !== 0) {
    console.error(`[transcribe-sidecar] ${compiler} failed`);
    process.exit(1);
  }
  log(
    `built ${path.relative(projectRoot, outputBinary)} against transcribe.cpp ${contract.version}`
  );
  process.exit(0);
}
console.error("[transcribe-sidecar] no C compiler found (cc, gcc or clang)");
process.exit(1);
