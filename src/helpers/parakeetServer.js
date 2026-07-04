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
const MAX_UNSEGMENTED_SECONDS = 25;
const MAX_UNSEGMENTED_BYTES = MAX_UNSEGMENTED_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const MAX_SEGMENT_SECONDS = 15;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SEGMENT_OVERLAP_SECONDS = 0.75;
const SEGMENT_OVERLAP_BYTES = SEGMENT_OVERLAP_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const MIN_SEGMENT_SECONDS = 0.25;
const MIN_SEGMENT_BYTES = MIN_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;
const NON_SILENT_EMPTY_RETRY_LIMIT = 1;
const EMPTY_RETRY_PADDING_SECONDS = 0.5;
const EMPTY_RETRY_PADDING_BYTES = EMPTY_RETRY_PADDING_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;

function padSamplesWithSilence(samples, paddingBytes = EMPTY_RETRY_PADDING_BYTES) {
  if (!paddingBytes) return samples;
  return Buffer.concat([Buffer.alloc(paddingBytes), samples, Buffer.alloc(paddingBytes)]);
}

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

  _getBackendDiagnosticMeta() {
    const status = this.wsServer.getStatus?.() || {};
    const backendTrace = status.backendTrace || {};
    return {
      providerAttempted: backendTrace.providerAttempted || null,
      providerUsed: backendTrace.providerUsed || null,
      fallbackUsed: Boolean(backendTrace.fallbackUsed),
      port: backendTrace.launch?.port || this.wsServer.port || null,
    };
  }

  _writeDiagnostic(event, meta = {}) {
    debugLogger.writeDiagnostic?.(event, {
      service: "parakeet",
      ...this._getBackendDiagnosticMeta(),
      ...meta,
    });
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

  async _ensureServerReady(modelName, modelDir) {
    if (!this.wsServer.ready || this.wsServer.modelName !== modelName) {
      await this.wsServer.start(modelName, modelDir);
    }
  }

  async _restartServer(modelName, modelDir, reason, meta = {}) {
    this._writeDiagnostic("parakeet_sidecar_restart", { reason, ...meta });
    debugLogger.warn("Restarting Parakeet sidecar", { reason, ...meta });
    await this.wsServer.stop();
    await this.wsServer.start(modelName, modelDir);
  }

  async _transcribeNonSilentSamples(samples, modelName, modelDir, meta = {}) {
    let lastEmptyResult = null;
    const startedAt = Date.now();

    for (let attempt = 0; attempt <= NON_SILENT_EMPTY_RETRY_LIMIT; attempt += 1) {
      const attemptSamples = attempt === 0 ? samples : padSamplesWithSilence(samples);
      const retryKind = attempt === 0 ? "initial" : "padded_silence";

      try {
        await this._ensureServerReady(modelName, modelDir);
        const result = await this.wsServer.transcribe(attemptSamples, SAMPLE_RATE);
        const textLength = result.text?.trim()?.length || 0;

        this._writeDiagnostic("parakeet_attempt_complete", {
          ...meta,
          attempt,
          retryKind,
          status: textLength > 0 ? "success" : "failure",
          errorClass: textLength > 0 ? null : "model_empty_non_silent",
          textLength,
          elapsedMs: result.elapsed || 0,
          totalWallMs: Date.now() - startedAt,
        });

        if (textLength > 0) {
          return result;
        }

        lastEmptyResult = result;
        debugLogger.warn("Parakeet returned empty text for non-silent audio", {
          ...meta,
          attempt,
          retryKind,
          retryLimit: NON_SILENT_EMPTY_RETRY_LIMIT,
        });
        this._writeDiagnostic("parakeet_empty_non_silent", {
          ...meta,
          attempt,
          retryKind,
          status: "failure",
          errorClass: "model_empty_non_silent",
          retryLimit: NON_SILENT_EMPTY_RETRY_LIMIT,
        });
      } catch (error) {
        debugLogger.warn("Parakeet transcription attempt failed", {
          ...meta,
          attempt,
          retryKind,
          error: error.message,
        });
        this._writeDiagnostic("parakeet_attempt_failed", {
          ...meta,
          attempt,
          retryKind,
          status: "failure",
          errorClass: error.message?.includes("timed out")
            ? "model_timeout"
            : "sidecar_unavailable",
          error: error.message,
        });

        if (attempt >= NON_SILENT_EMPTY_RETRY_LIMIT) {
          throw error;
        }

        await this._restartServer(modelName, modelDir, "transcription_attempt_failed", {
          ...meta,
          attempt,
          error: error.message,
        });
      }
    }

    return lastEmptyResult || { text: "", elapsed: Date.now() - startedAt };
  }

  async transcribe(audioBuffer, options = {}) {
    const { modelName = "parakeet-tdt-0.6b-v3", recordingId = null } = options;

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
      await this._ensureServerReady(modelName, modelDir);

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("Parakeet audio analysis", {
        durationSeconds,
        rms,
        wavSize: wavBuffer.length,
        samplesBytes: samples.length,
      });
      this._writeDiagnostic("parakeet_audio_analysis", {
        recordingId,
        stage: "analysis",
        status: "success",
        modelName,
        durationSeconds,
        rms,
        wavSize: wavBuffer.length,
        samplesBytes: samples.length,
        inputBytes: audioBuffer?.length || 0,
      });
      if (rms < SILENCE_RMS_THRESHOLD) {
        this._writeDiagnostic("parakeet_skip_silence", {
          recordingId,
          stage: "analysis",
          status: "skipped",
          errorClass: "backend_silence",
          modelName,
          durationSeconds,
          rms,
          samplesBytes: samples.length,
        });
        return { text: "", elapsed: 0, durationSeconds, rms };
      }

      if (samples.length <= MAX_UNSEGMENTED_BYTES) {
        const result = await this._transcribeNonSilentSamples(samples, modelName, modelDir, {
          mode: "single",
          recordingId,
          stage: "inference",
          modelName,
          durationSeconds,
          rms,
          samplesBytes: samples.length,
          maxUnsegmentedSeconds: MAX_UNSEGMENTED_SECONDS,
        });
        return { ...result, durationSeconds, rms };
      }

      const segmentStepBytes = Math.max(MAX_SEGMENT_BYTES - SEGMENT_OVERLAP_BYTES, MIN_SEGMENT_BYTES);
      const segmentCount = Math.ceil(
        Math.max(samples.length - SEGMENT_OVERLAP_BYTES, 0) / segmentStepBytes
      );

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount,
        maxUnsegmentedSeconds: MAX_UNSEGMENTED_SECONDS,
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

        const result = await this._transcribeNonSilentSamples(segment, modelName, modelDir, {
          mode: "segment",
          recordingId,
          stage: "inference",
          modelName,
          segmentIndex,
          segmentCount,
          offsetSeconds: offset / BYTES_PER_SAMPLE / SAMPLE_RATE,
          segmentDurationSeconds,
          segmentRms,
          samplesBytes: segment.length,
        });
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

      return { text, elapsed: totalElapsed, durationSeconds, rms };
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
