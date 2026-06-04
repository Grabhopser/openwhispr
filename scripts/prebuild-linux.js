#!/usr/bin/env node
const { spawnSync } = require("child_process");

const isLinuxArm64 = process.platform === "linux" && process.arch === "arm64";

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

run("download:whisper-cpp", [], {
  optional: isLinuxArm64,
});
run("download:llama-server", [], {
  optional: isLinuxArm64,
});
run("download:sherpa-onnx");
run("download:qdrant");
run("download:meeting-aec-helper", [], {
  optional: isLinuxArm64,
});
run("download:whisper-vad-model");
run("download:diarization-models", ["--", "--output-dir", "resources/bin/diarization-models"]);
