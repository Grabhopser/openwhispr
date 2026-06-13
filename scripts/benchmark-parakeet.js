#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const ParakeetServerManager = require("../src/helpers/parakeetServer");
const { isWavFormat, wavToFloat32Samples } = require("../src/helpers/ffmpegUtils");

const DEFAULT_MODEL = "parakeet-tdt-0.6b-v3";

function usage() {
  console.log("Usage: npm run benchmark:parakeet -- <audio-file> [model]");
  console.log(`Default model: ${DEFAULT_MODEL}`);
}

function getDurationSeconds(audioBuffer) {
  if (!isWavFormat(audioBuffer)) return null;
  try {
    const samples = wavToFloat32Samples(audioBuffer);
    return samples.length / 4 / 16000;
  } catch {
    return null;
  }
}

async function main() {
  const audioPath = process.argv[2];
  const modelName = process.argv[3] || process.env.PARAKEET_MODEL || DEFAULT_MODEL;

  if (!audioPath || audioPath === "-h" || audioPath === "--help") {
    usage();
    process.exit(audioPath ? 0 : 1);
  }

  const resolvedAudioPath = path.resolve(audioPath);
  if (!fs.existsSync(resolvedAudioPath)) {
    console.error(`[benchmark:parakeet] Audio file not found: ${resolvedAudioPath}`);
    process.exit(1);
  }

  const audioBuffer = fs.readFileSync(resolvedAudioPath);
  const manager = new ParakeetServerManager();

  if (!manager.isAvailable()) {
    console.error("[benchmark:parakeet] sherpa-onnx websocket binary not found");
    process.exit(1);
  }

  if (!manager.isModelDownloaded(modelName)) {
    console.error(`[benchmark:parakeet] Model not downloaded: ${modelName}`);
    console.error(`[benchmark:parakeet] Expected under: ${manager.getModelsDir()}`);
    process.exit(1);
  }

  const durationSeconds = getDurationSeconds(audioBuffer);
  const startedAt = performance.now();

  try {
    const result = await manager.transcribe(audioBuffer, { modelName });
    const totalMs = performance.now() - startedAt;
    const realtimeFactor = durationSeconds ? totalMs / 1000 / durationSeconds : null;

    console.log(JSON.stringify(
      {
        model: modelName,
        audioPath: resolvedAudioPath,
        audioBytes: audioBuffer.length,
        durationSeconds: durationSeconds ? Number(durationSeconds.toFixed(3)) : null,
        transcriptionMs: Math.round(totalMs),
        realtimeFactor: realtimeFactor ? Number(realtimeFactor.toFixed(3)) : null,
        text: result.text || "",
      },
      null,
      2
    ));
  } finally {
    await manager.stopServer();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[benchmark:parakeet] Failed:", error?.message || error);
    process.exit(1);
  });
