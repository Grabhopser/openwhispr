#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const isLinuxArm64 = process.platform === "linux" && process.arch === "arm64";
const includeOptionalLinuxArm64Sidecars =
  process.env.OPENWHISPR_LINUX_ARM64_FULL === "1" ||
  process.env.OPENWHISPR_LINUX_ARM64_FULL === "true";
const useLinuxArm64MinimalProfile = isLinuxArm64 && !includeOptionalLinuxArm64Sidecars;

function run(script, args = [], options = {}) {
  const result = spawnSync("npm", ["run", script, ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.status === 0) return;

  if (options.optional) {
    console.warn(`[prebuild:linux] Optional step failed, continuing: ${script}`);
    return;
  }

  process.exit(result.status || 1);
}

run("compile:native");

if (useLinuxArm64MinimalProfile) {
  console.log(
    "[prebuild:linux] linux-arm64 minimal profile: skipping bundled whisper-server, llama-server, and qdrant"
  );
  console.log(
    "[prebuild:linux] Set OPENWHISPR_LINUX_ARM64_FULL=1 to attempt optional sidecar downloads"
  );
} else {
  run("download:whisper-cpp");
  run("download:llama-server");
}
run("download:sherpa-onnx");
if (useLinuxArm64MinimalProfile) {
  const qdrantArm64Path = path.join(__dirname, "..", "resources", "bin", "qdrant-linux-arm64");
  if (fs.existsSync(qdrantArm64Path)) {
    fs.unlinkSync(qdrantArm64Path);
    console.log("[prebuild:linux] Removed qdrant-linux-arm64 from minimal package resources");
  }
} else {
  run("download:qdrant");
}
run("download:meeting-aec-helper", [], {
  optional: isLinuxArm64,
});
run("download:whisper-vad-model");
run("download:diarization-models", ["--", "--output-dir", "resources/bin/diarization-models"]);
