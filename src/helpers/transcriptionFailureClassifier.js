function classifyTranscriptionFailure({ message = "", error = "", rms = null, textLength = null } = {}) {
  const combined = `${message} ${error}`.toLowerCase();

  if (combined.includes("audio buffer is empty") || combined.includes("no audio data")) {
    return "capture_empty";
  }
  if (combined.includes("ffmpeg") || combined.includes("conversion failed")) {
    return "decode_failed";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "model_timeout";
  }
  if (
    combined.includes("server is not running") ||
    combined.includes("websocket") ||
    combined.includes("connection refused") ||
    combined.includes("econnrefused")
  ) {
    return "sidecar_unavailable";
  }
  if (combined.includes("no audio detected")) {
    if (Number.isFinite(rms) && rms < 0.001) return "backend_silence";
    if (textLength === 0 || textLength === null) return "model_empty_non_silent";
    return "unknown_failure";
  }

  return "unknown_failure";
}

function classifySuspiciousSuccess({ durationMs = null, rms = null, textLength = null } = {}) {
  if (!Number.isFinite(durationMs) || !Number.isFinite(textLength)) return null;

  const durationSeconds = durationMs / 1000;
  const charsPerSecond = durationSeconds > 0 ? textLength / durationSeconds : null;

  if (Number.isFinite(rms) && rms > 0.01 && textLength === 0) {
    return "model_empty_non_silent";
  }
  if (durationMs > 8000 && textLength < 20) {
    return "model_suspicious_short";
  }
  if (durationMs > 15000 && Number.isFinite(charsPerSecond) && charsPerSecond < 2) {
    return "model_suspicious_short";
  }

  return null;
}

module.exports = {
  classifyTranscriptionFailure,
  classifySuspiciousSuccess,
};
