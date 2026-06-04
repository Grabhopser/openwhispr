#!/usr/bin/env node
const { spawnSync } = require("child_process");

const isLinuxArm64 = process.platform === "linux" && process.arch === "arm64";
const includeOptionalLinuxArm64Sidecars =
  process.env.OPENWHISPR_LINUX_ARM64_FULL === "1" ||
  process.env.OPENWHISPR_LINUX_ARM64_FULL === "true";

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

if (isLinuxArm64 && !includeOptionalLinuxArm64Sidecars) {
  console.log(
    "[prebuild:linux] linux-arm64 minimal profile: skipping bundled whisper-server and llama-server"
  );
  console.log(
    "[prebuild:linux] Set OPENWHISPR_LINUX_ARM64_FULL=1 to attempt optional sidecar downloads"
  );
} else {
  run("download:whisper-cpp");
  run("download:llama-server");
}
run("download:sherpa-onnx");
run("download:qdrant");
run("download:meeting-aec-helper", [], {
  optional: isLinuxArm64,
});
run("download:whisper-vad-model");
run("download:diarization-models", ["--", "--output-dir", "resources/bin/diarization-models"]);
