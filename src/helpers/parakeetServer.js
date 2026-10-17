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
const MIN_STANDALONE_TAIL_SECONDS = 3;
const MIN_STANDALONE_TAIL_BYTES = MIN_STANDALONE_TAIL_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;
const NON_SILENT_EMPTY_RETRY_LIMIT = 1;
const EMPTY_RETRY_PADDING_SECONDS = 0.5;
const EMPTY_RETRY_PADDING_BYTES = EMPTY_RETRY_PADDING_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const FINALIZATION_PADDING_SECONDS = 0.8;
const FINALIZATION_PADDING_BYTES = FINALIZATION_PADDING_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SUSPICIOUS_SHORT_MIN_SECONDS = 2.5;
const SUSPICIOUS_SHORT_TEXT_LENGTH = 8;
const TAIL_CONTEXT_SECONDS = 5;
const TAIL_CONTEXT_BYTES = TAIL_CONTEXT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SHORT_TAIL_SEGMENT_SECONDS = 8;
const SEGMENT_RECOVERY_CONTEXT_SECONDS = 5;
const SEGMENT_RECOVERY_CONTEXT_BYTES =
  SEGMENT_RECOVERY_CONTEXT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const DEFAULT_HEALTH_WINDOW_MS = 120000;
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3;
const DEFAULT_HEALTH_RESTART_COOLDOWN_MS = 30000;

function parsePositiveIntEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function padSamplesWithSilence(samples, paddingBytes = EMPTY_RETRY_PADDING_BYTES) {
  if (!paddingBytes) return samples;
  return Buffer.concat([Buffer.alloc(paddingBytes), samples, Buffer.alloc(paddingBytes)]);
}

function appendSamplesWithSilence(samples, paddingBytes = FINALIZATION_PADDING_BYTES) {
  if (!paddingBytes) return samples;
  return Buffer.concat([samples, Buffer.alloc(paddingBytes)]);
}

class ParakeetServerManager {
  constructor() {
    this.wsServer = new ParakeetWsServer();
    this.healthEvents = [];
    this.healthDegraded = false;
    this.lastAutoRestartAt = 0;
    this.autoRestartEnabled = parseBooleanEnv("OPENWHISPR_PARAKEET_AUTO_RESTART", true);
    this.healthWindowMs = parsePositiveIntEnv(
      "OPENWHISPR_PARAKEET_RESTART_WINDOW_MS",
      DEFAULT_HEALTH_WINDOW_MS
    );
    this.healthFailureThreshold = parsePositiveIntEnv(
      "OPENWHISPR_PARAKEET_RESTART_FAILURES",
      DEFAULT_HEALTH_FAILURE_THRESHOLD
    );
    this.healthRestartCooldownMs = parsePositiveIntEnv(
      "OPENWHISPR_PARAKEET_RESTART_COOLDOWN_MS",
      DEFAULT_HEALTH_RESTART_COOLDOWN_MS
    );
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

  _pruneHealthEvents(now = Date.now()) {
    const cutoff = now - this.healthWindowMs;
    this.healthEvents = this.healthEvents.filter((event) => event.at >= cutoff);
  }

  _getHealthSnapshot(now = Date.now()) {
    this._pruneHealthEvents(now);

    const failures = this.healthEvents.filter((event) => event.status === "failure");
    const successes = this.healthEvents.filter((event) => event.status === "success");
    const failureClassCounts = {};

    for (const event of failures) {
      failureClassCounts[event.errorClass] = (failureClassCounts[event.errorClass] || 0) + 1;
    }

    const dominantFailureClass =
      Object.entries(failureClassCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    return {
      windowMs: this.healthWindowMs,
      failureCount: failures.length,
      successCount: successes.length,
      dominantFailureClass,
      failureClassCounts,
      threshold: this.healthFailureThreshold,
      cooldownMs: this.healthRestartCooldownMs,
      autoRestartEnabled: this.autoRestartEnabled,
      degraded: failures.length >= this.healthFailureThreshold,
      sidecarPid: this.wsServer.process?.pid || null,
    };
  }

  _recordHealthSuccess(meta = {}) {
    const now = Date.now();
    this.healthEvents.push({
      at: now,
      status: "success",
      mode: meta.mode || null,
      recordingId: meta.recordingId || null,
    });

    const snapshot = this._getHealthSnapshot(now);
    this._writeDiagnostic("parakeet_health_window_update", {
      ...meta,
      status: "success",
      health: snapshot,
    });

    if (this.healthDegraded && snapshot.failureCount === 0) {
      this.healthDegraded = false;
      this._writeDiagnostic("parakeet_health_recovered", {
        ...meta,
        status: "success",
        health: snapshot,
      });
    }
  }

  async _recordHealthFailure(errorClass, modelName, modelDir, meta = {}) {
    if (
      ![
        "model_empty_non_silent",
        "model_suspicious_short",
        "model_timeout",
        "sidecar_unavailable",
      ].includes(errorClass)
    ) {
      return;
    }

    const now = Date.now();
    this.healthEvents.push({
      at: now,
      status: "failure",
      errorClass,
      mode: meta.mode || null,
      recordingId: meta.recordingId || null,
    });

    const snapshot = this._getHealthSnapshot(now);
    this._writeDiagnostic("parakeet_health_window_update", {
      ...meta,
      status: "failure",
      errorClass,
      health: snapshot,
    });

    const shouldRestartImmediately = ["model_timeout", "sidecar_unavailable"].includes(errorClass);
    const shouldRestartForCluster = snapshot.degraded;
    if (!shouldRestartImmediately && !shouldRestartForCluster) return;

    if (shouldRestartForCluster && !this.healthDegraded) {
      this.healthDegraded = true;
      this._writeDiagnostic("parakeet_health_degraded", {
        ...meta,
        status: "failure",
        errorClass,
        health: snapshot,
      });
    }

    if (!this.autoRestartEnabled) return;

    const msSinceRestart = now - this.lastAutoRestartAt;
    if (this.lastAutoRestartAt && msSinceRestart < this.healthRestartCooldownMs) {
      this._writeDiagnostic("parakeet_health_restart_skipped_cooldown", {
        ...meta,
        status: "skipped",
        errorClass,
        msSinceRestart,
        health: snapshot,
      });
      return;
    }

    const restartReason = shouldRestartImmediately
      ? "sidecar_transport_failure"
      : "clustered_non_silent_model_failures";

    this.lastAutoRestartAt = now;
    this._writeDiagnostic("parakeet_health_restart_requested", {
      ...meta,
      status: "started",
      errorClass,
      reason: restartReason,
      health: snapshot,
    });

    try {
      this._writeDiagnostic("parakeet_health_restart_started", {
        ...meta,
        status: "started",
        errorClass,
        reason: restartReason,
        oldSidecarPid: this.wsServer.process?.pid || null,
      });
      await this._restartServer(modelName, modelDir, restartReason, {
        ...meta,
        errorClass,
        failureCount: snapshot.failureCount,
        windowMs: snapshot.windowMs,
      });
      this.healthEvents = [];
      this.healthDegraded = false;
      this._writeDiagnostic("parakeet_health_restart_complete", {
        ...meta,
        status: "success",
        errorClass,
        reason: restartReason,
        newSidecarPid: this.wsServer.process?.pid || null,
      });
    } catch (error) {
      this._writeDiagnostic("parakeet_health_restart_failed", {
        ...meta,
        status: "failure",
        errorClass: "sidecar_unavailable",
        reason: restartReason,
        error: error.message,
      });
      throw error;
    }
  }

  async _transcribeNonSilentSamples(samples, modelName, modelDir, meta = {}) {
    let lastEmptyResult = null;
    let lastSuspiciousShortResult = null;
    const startedAt = Date.now();
    const originalDurationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

    for (let attempt = 0; attempt <= NON_SILENT_EMPTY_RETRY_LIMIT; attempt += 1) {
      const attemptSamples =
        attempt === 0 ? appendSamplesWithSilence(samples) : padSamplesWithSilence(samples);
      const retryKind = attempt === 0 ? "initial_trailing_silence" : "padded_silence";

      try {
        await this._ensureServerReady(modelName, modelDir);
        const result = await this.wsServer.transcribe(attemptSamples, SAMPLE_RATE);
        const textLength = result.text?.trim()?.length || 0;
        const isSuspiciousShort =
          textLength > 0 &&
          originalDurationSeconds >= SUSPICIOUS_SHORT_MIN_SECONDS &&
          textLength < SUSPICIOUS_SHORT_TEXT_LENGTH;

        this._writeDiagnostic("parakeet_attempt_complete", {
          ...meta,
          attempt,
          retryKind,
          status: textLength > 0 && !isSuspiciousShort ? "success" : "failure",
          errorClass:
            textLength === 0
              ? "model_empty_non_silent"
              : isSuspiciousShort
                ? "model_suspicious_short"
                : null,
          textLength,
          elapsedMs: result.elapsed || 0,
          totalWallMs: Date.now() - startedAt,
          finalizationPaddingSeconds: attempt === 0 ? FINALIZATION_PADDING_SECONDS : 0,
          suspiciousShortMinSeconds: SUSPICIOUS_SHORT_MIN_SECONDS,
          suspiciousShortTextLength: SUSPICIOUS_SHORT_TEXT_LENGTH,
        });

        if (textLength > 0 && !isSuspiciousShort) {
          this._recordHealthSuccess({
            ...meta,
            attempt,
            retryKind,
            textLength,
          });
          return result;
        }

        if (isSuspiciousShort) {
          lastSuspiciousShortResult = result;
          debugLogger.warn("Parakeet returned suspiciously short text for non-silent audio", {
            ...meta,
            attempt,
            retryKind,
            durationSeconds: originalDurationSeconds,
            textLength,
          });
          this._writeDiagnostic("parakeet_suspicious_short", {
            ...meta,
            attempt,
            retryKind,
            status: "failure",
            errorClass: "model_suspicious_short",
            durationSeconds: originalDurationSeconds,
            textLength,
            suspiciousShortMinSeconds: SUSPICIOUS_SHORT_MIN_SECONDS,
            suspiciousShortTextLength: SUSPICIOUS_SHORT_TEXT_LENGTH,
          });
          await this._recordHealthFailure("model_suspicious_short", modelName, modelDir, {
            ...meta,
            attempt,
            retryKind,
            durationSeconds: originalDurationSeconds,
            textLength,
          });
          continue;
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
        await this._recordHealthFailure("model_empty_non_silent", modelName, modelDir, {
          ...meta,
          attempt,
          retryKind,
          durationSeconds: originalDurationSeconds,
        });
      } catch (error) {
        const errorClass = error.message?.includes("timed out")
          ? "model_timeout"
          : "sidecar_unavailable";
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
          errorClass,
          error: error.message,
        });
        await this._recordHealthFailure(errorClass, modelName, modelDir, {
          ...meta,
          attempt,
          retryKind,
          error: error.message,
        });

        if (attempt >= NON_SILENT_EMPTY_RETRY_LIMIT) {
          throw error;
        }
      }
    }

    if (lastSuspiciousShortResult) {
      return {
        ...lastSuspiciousShortResult,
        text: "",
        errorClass: "model_suspicious_short",
      };
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
      const segments = [];
      for (let offset = 0; offset < samples.length; offset += segmentStepBytes) {
        const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
        if (end - offset < MIN_SEGMENT_BYTES) break;
        segments.push({ offset, end });
      }

      const lastSegment = segments[segments.length - 1];
      const previousSegment = segments[segments.length - 2];
      if (
        previousSegment &&
        lastSegment?.end === samples.length &&
        lastSegment.end - lastSegment.offset < MIN_STANDALONE_TAIL_BYTES
      ) {
        previousSegment.end = samples.length;
        segments.pop();
        this._writeDiagnostic("parakeet_short_tail_merged", {
          recordingId,
          stage: "segmentation",
          status: "success",
          modelName,
          tailDurationSeconds: (lastSegment.end - lastSegment.offset) / BYTES_PER_SAMPLE / SAMPLE_RATE,
          mergedSegmentDurationSeconds:
            (previousSegment.end - previousSegment.offset) / BYTES_PER_SAMPLE / SAMPLE_RATE,
          minStandaloneTailSeconds: MIN_STANDALONE_TAIL_SECONDS,
        });
      }

      const segmentCount = segments.length;

      debugLogger.debug("Parakeet segmenting long audio", {
        durationSeconds,
        segmentCount,
        maxUnsegmentedSeconds: MAX_UNSEGMENTED_SECONDS,
        maxSegmentSeconds: MAX_SEGMENT_SECONDS,
        overlapSeconds: SEGMENT_OVERLAP_SECONDS,
        minStandaloneTailSeconds: MIN_STANDALONE_TAIL_SECONDS,
      });

      const texts = [];
      let totalElapsed = 0;
      let segmentIndex = 0;

      for (const { offset, end } of segments) {
        const segment = samples.subarray(offset, end);
        const segmentDurationSeconds = segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
        const isTailSegment = end === samples.length;
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
          tailSegment: isTailSegment,
          offsetSeconds: offset / BYTES_PER_SAMPLE / SAMPLE_RATE,
          segmentDurationSeconds,
          segmentRms,
          samplesBytes: segment.length,
        });
        totalElapsed += result.elapsed || 0;
        let segmentText = result.text?.trim() || "";

        if (!segmentText) {
          const contextBeforeBytes =
            isTailSegment && segmentDurationSeconds <= SHORT_TAIL_SEGMENT_SECONDS
              ? TAIL_CONTEXT_BYTES
              : SEGMENT_RECOVERY_CONTEXT_BYTES;
          const contextStart = Math.max(0, offset - contextBeforeBytes);
          const contextEnd = Math.min(samples.length, end + SEGMENT_RECOVERY_CONTEXT_BYTES);
          const recoveryContext = samples.subarray(contextStart, contextEnd);
          const recoveryContextDurationSeconds =
            recoveryContext.length / BYTES_PER_SAMPLE / SAMPLE_RATE;
          const recoveryContextRms = computeFloat32RMS(recoveryContext);
          const recoveryEventPrefix =
            isTailSegment && segmentDurationSeconds <= SHORT_TAIL_SEGMENT_SECONDS
              ? "parakeet_tail_context"
              : "parakeet_segment_context";

          this._writeDiagnostic(`${recoveryEventPrefix}_retry`, {
            recordingId,
            stage: "inference",
            status: "started",
            modelName,
            segmentIndex,
            segmentCount,
            tailSegment: isTailSegment,
            originalOffsetSeconds: offset / BYTES_PER_SAMPLE / SAMPLE_RATE,
            contextOffsetSeconds: contextStart / BYTES_PER_SAMPLE / SAMPLE_RATE,
            contextEndSeconds: contextEnd / BYTES_PER_SAMPLE / SAMPLE_RATE,
            segmentDurationSeconds,
            recoveryContextDurationSeconds,
            segmentRms,
            recoveryContextRms,
            contextSeconds: (contextEnd - contextStart) / BYTES_PER_SAMPLE / SAMPLE_RATE,
          });

          const recoveryResult = await this._transcribeNonSilentSamples(
            recoveryContext,
            modelName,
            modelDir,
            {
              mode: isTailSegment ? "tail_context" : "segment_context",
              recordingId,
              stage: "inference",
              modelName,
              segmentIndex,
              segmentCount,
              tailSegment: isTailSegment,
              originalOffsetSeconds: offset / BYTES_PER_SAMPLE / SAMPLE_RATE,
              offsetSeconds: contextStart / BYTES_PER_SAMPLE / SAMPLE_RATE,
              segmentDurationSeconds: recoveryContextDurationSeconds,
              segmentRms: recoveryContextRms,
              originalSegmentDurationSeconds: segmentDurationSeconds,
              originalSegmentRms: segmentRms,
              samplesBytes: recoveryContext.length,
              contextSeconds: (contextEnd - contextStart) / BYTES_PER_SAMPLE / SAMPLE_RATE,
            }
          );
          totalElapsed += recoveryResult.elapsed || 0;
          segmentText = recoveryResult.text?.trim() || "";

          this._writeDiagnostic(`${recoveryEventPrefix}_complete`, {
            recordingId,
            stage: "inference",
            status: segmentText ? "success" : "failure",
            errorClass: segmentText ? null : "model_empty_non_silent",
            modelName,
            segmentIndex,
            segmentCount,
            tailSegment: isTailSegment,
            textLength: segmentText.length,
            recoveryContextDurationSeconds,
            recoveryContextRms,
          });
        }

        if (segmentText) {
          texts.push(segmentText);
          debugLogger.debug("Parakeet segment transcription complete", {
            segmentIndex,
            textLength: segmentText.length,
            elapsed: result.elapsed || 0,
          });
        } else {
          debugLogger.warn("Parakeet segment returned empty text", {
            segmentIndex,
            segmentCount,
            tailSegment: isTailSegment,
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
