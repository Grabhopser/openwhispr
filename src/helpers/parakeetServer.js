const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  getFFmpegPath,
  isWavFormat,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const ParakeetWsServer = require("./parakeetWsServer");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
const MAX_SEGMENT_SECONDS = 15;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SEGMENT_OVERLAP_SECONDS = 0.75;
const SEGMENT_OVERLAP_BYTES = SEGMENT_OVERLAP_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const MIN_SEGMENT_SECONDS = 0.25;
const MIN_SEGMENT_BYTES = MIN_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;

class ParakeetServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
  }

  getBinaryPath() {
    return this.wsServer.getWsBinaryPath();
  }

  isAvailable() {
    return this.wsServer.isAvailable();
  }

  getModelsDir() {
    return getModelsDirForService("parakeet");
  }

  isModelDownloaded(modelName) {
    const modelDir = path.join(this.getModelsDir(), modelName);
    const requiredFiles = [
      "encoder.int8.onnx",
      "decoder.int8.onnx",
      "joiner.int8.onnx",
      "tokens.txt",
    ];

    if (!fs.existsSync(modelDir)) return false;

    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(modelDir, file))) {
        return false;
      }
    }

    return true;
  }

  async _ensureWav(audioBuffer) {
    const isWav = isWavFormat(audioBuffer);
    if (isWav) return { wavBuffer: audioBuffer, filesToCleanup: [] };

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `parakeet-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `parakeet-${timestamp}.wav`);

    fs.writeFileSync(tempInputPath, audioBuffer);

    const inputStats = fs.statSync(tempInputPath);
    debugLogger.debug("Converting audio to WAV", { inputSize: inputStats.size });

    await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1 });

    const wavBuffer = fs.readFileSync(tempWavPath);
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  async transcribe(audioBuffer, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3" } = options;

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      throw new Error(`Parakeet model "${modelName}" not downloaded`);
    }

    debugLogger.debug("Parakeet transcription request", {
      modelName,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer);
    try {
      if (!this.wsServer.ready || this.wsServer.modelName !== modelName) {
        await this.wsServer.start(modelName, modelDir);
      }

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", {
        durationSeconds,
        rms,
        wavSize: wavBuffer.length,
        samplesBytes: samples.length,
      });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { text: "", elapsed: 0 };
      }

      if (samples.length <= MAX_SEGMENT_BYTES) {
        const result = await this.wsServer.transcribe(samples, SAMPLE_RATE);
        if (!result.text?.trim()) {
          debugLogger.warn("Parakeet returned empty text for non-silent audio", {
            durationSeconds,
            rms,
            samplesBytes: samples.length,
          });
        }
        return result;
      }

      const segmentStepBytes = Math.max(MAX_SEGMENT_BYTES - SEGMENT_OVERLAP_BYTES, MIN_SEGMENT_BYTES);
      const segmentCount = Math.ceil(
        Math.max(samples.length - SEGMENT_OVERLAP_BYTES, 0) / segmentStepBytes
      );

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount,
        maxSegmentSeconds: MAX_SEGMENT_SECONDS,
        overlapSeconds: SEGMENT_OVERLAP_SECONDS,
      });

      const texts = [];
      let totalElapsed = 0;
      let segmentIndex = 0;

      for (let offset = 0; offset < samples.length; offset += segmentStepBytes) {
        const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
        const segment = samples.subarray(offset, end);
        const segmentDurationSeconds = segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
        if (segment.length < MIN_SEGMENT_BYTES) {
          debugLogger.debug("Skipping very short Parakeet trailing segment", {
            segmentIndex,
            segmentDurationSeconds,
          });
          break;
        }

        const segmentRms = computeFloat32RMS(segment);
        debugLogger.debug("Parakeet segment transcription starting", {
          segmentIndex,
          segmentCount,
          offsetSeconds: offset / BYTES_PER_SAMPLE / SAMPLE_RATE,
          segmentDurationSeconds,
          segmentRms,
        });

        if (segmentRms < SILENCE_RMS_THRESHOLD) {
          debugLogger.debug("Skipping silent Parakeet segment", {
            segmentIndex,
            segmentDurationSeconds,
            segmentRms,
          });
          segmentIndex += 1;
          continue;
        }

        const result = await this.wsServer.transcribe(segment, SAMPLE_RATE);
        totalElapsed += result.elapsed || 0;
        if (result.text?.trim()) {
          texts.push(result.text.trim());
          debugLogger.debug("Parakeet segment transcription complete", {
            segmentIndex,
            textLength: result.text.length,
            elapsed: result.elapsed || 0,
          });
        } else {
          debugLogger.warn("Parakeet segment returned empty text", {
            segmentIndex,
            segmentCount,
            segmentDurationSeconds,
            segmentRms,
          });
        }

        segmentIndex += 1;
      }

      const text = texts.join(" ").replace(/\s+/g, " ").trim();
      debugLogger.debug("Parakeet segmented transcription complete", {
        segmentCount: segmentIndex,
        nonEmptySegmentCount: texts.length,
        textLength: text.length,
        totalElapsed,
      });

      return { text, elapsed: totalElapsed };
    } finally {
      this._cleanupFiles(filesToCleanup);
    }
  }

  _cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        debugLogger.warn("Failed to cleanup temp audio file", {
          path: filePath,
          error: err.message,
        });
      }
    }
  }

  async startServer(modelName) {
    if (!this.wsServer.isAvailable()) {
      return { success: false, reason: "parakeet WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.wsServer.start(modelName, modelDir);
      return { success: true, port: this.wsServer.port };
    } catch (error) {
      debugLogger.error("Failed to start parakeet WS server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.wsServer.stop();
  }

  getServerStatus() {
    return this.wsServer.getStatus();
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      binaryPath: this.getBinaryPath(),
      modelsDir: this.getModelsDir(),
    };
  }
}

module.exports = ParakeetServerManager;
