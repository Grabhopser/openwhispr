const debugLogger = require("../debugLogger");

class AsrRouter {
  constructor({ parakeetManager, whisperManager }) {
    this.parakeetManager = parakeetManager;
    this.whisperManager = whisperManager;
  }

  getCapabilities() {
    const parakeetServerStatus = this.parakeetManager?.getServerStatus?.() || null;
    const whisperServerStatus = this.whisperManager?.getServerStatus?.() || null;

    return [
      {
        backendId: "parakeet-sherpa",
        modelFamily: "parakeet",
        provider: parakeetServerStatus?.backendTrace?.providerUsed || "auto",
        available: Boolean(this.parakeetManager?.serverManager?.isAvailable?.()),
        diagnostics: parakeetServerStatus,
      },
      {
        backendId: "whisper-local",
        modelFamily: "whisper",
        provider: whisperServerStatus?.cuda ? "cuda" : "cpu",
        available: Boolean(this.whisperManager?.serverManager?.isAvailable?.()),
        diagnostics: whisperServerStatus,
      },
    ];
  }

  selectBackend(options = {}) {
    const requestedProvider = String(options.provider || "").trim().toLowerCase();

    if (requestedProvider === "nvidia" || requestedProvider === "parakeet") {
      return {
        backendId: "parakeet-sherpa",
        modelFamily: "parakeet",
        providerHint: "cuda",
        manager: this.parakeetManager,
        method: "transcribeLocalParakeet",
      };
    }

    return {
      backendId: "whisper-local",
      modelFamily: "whisper",
      providerHint: this.whisperManager?.serverManager?.useCuda ? "cuda" : "cpu",
      manager: this.whisperManager,
      method: "transcribeLocalWhisper",
    };
  }

  async transcribe(audioBuffer, options = {}) {
    const selected = this.selectBackend(options);

    if (!selected.manager || typeof selected.manager[selected.method] !== "function") {
      throw new Error(`ASR backend unavailable: ${selected.backendId}`);
    }

    const startTime = Date.now();
    debugLogger.info("ASR backend selected", {
      backendId: selected.backendId,
      modelFamily: selected.modelFamily,
      providerHint: selected.providerHint,
      requestedProvider: options.provider || null,
      model: options.model || null,
    });

    const result = await selected.manager[selected.method](audioBuffer, options);
    const latencyMs = Date.now() - startTime;

    return {
      ...result,
      diagnostics: {
        ...(result?.diagnostics || {}),
        backendId: selected.backendId,
        modelFamily: selected.modelFamily,
        providerHint: selected.providerHint,
        fallbackUsed: false,
        latencyMs,
      },
    };
  }
}

module.exports = AsrRouter;
