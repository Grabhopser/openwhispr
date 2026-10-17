// Main-process side of the transcribe.cpp engine. It mirrors the parts of
// ParakeetWsServer that ParakeetServerManager uses (start / transcribe / stop /
// getStatus / maxConcurrentDecodes), so segmentation, retries and the silence
// gate stay shared between both engines.
//
// The model runs in the native transcribe-sidecar process (see
// resources/transcribe-sidecar). It cannot run inside an Electron utility
// process: Electron's allocator refuses the single ~1 GB weight buffer that
// Canary 1B needs, and the process dies with SIGTRAP.
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const debugLogger = require("./debugLogger");
const sidecarPidFile = require("./sidecarPidFile");
const { createAbortError } = require("./abortError");
const { computeTranscriptionTimeoutMs } = require("./transcriptionTimeout");
const {
  resolveBinaryPath,
  gracefulStopProcess,
  getAvailableParallelism,
} = require("../utils/serverUtils");
const { getModelInfo } = require("./parakeetModelInfo");

const SIDECAR_NAME = "transcribe-cpp";
const STARTUP_TIMEOUT_MS = 120_000;
const LANGID_TIMEOUT_MS = 20_000;
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4;
// Language ID scores at most 30s anyway; the first seconds decided it as well
// as the whole clip did on real dictations, at a quarter of the cost.
const LANGID_MAX_SECONDS = 8;
const MAX_CONSECUTIVE_CRASHES = 3;
const STATUS_ABORTED = 13;

const PLATFORM_PACKAGES = {
  "linux-x64": "linux-x64-cpu-vulkan",
  "linux-arm64": "linux-arm64-cpu-vulkan",
};

// Same thread policy as the sherpa sidecar (see parakeetWsServer.js).
function resolveThreads() {
  const cpus = getAvailableParallelism();
  const override = Number.parseInt(process.env.OPENWHISPR_PARAKEET_THREADS || "", 10);
  if (Number.isInteger(override) && override > 0) return Math.min(override, cpus);
  return Math.max(1, Math.min(8, Math.floor(cpus * 0.75)));
}

// The prebuilt libtranscribe and its ggml CPU modules ship in an npm package,
// unpacked from app.asar so the dynamic loader can read them.
function resolveLibraryDir() {
  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`];
  if (!pkg) return null;
  try {
    const dir = path
      .dirname(require.resolve(`@transcribe-cpp/${pkg}/package.json`))
      .replace(/app\.asar(?=[\\/])/, "app.asar.unpacked");
    return fs.existsSync(path.join(dir, "libtranscribe.so")) ? dir : null;
  } catch {
    return null;
  }
}

function baseLanguage(code) {
  return typeof code === "string" ? code.trim().replace(/_/g, "-").split("-")[0].toLowerCase() : "";
}

// UI languages first, then the languages of the regional formats: someone
// with an English desktop and German date/number formats (LC_TIME=de_DE)
// most likely dictates in both.
const LOCALE_ENV_VARS = [
  "LC_ALL",
  "LC_MESSAGES",
  "LANG",
  "LANGUAGE",
  "LC_TIME",
  "LC_NUMERIC",
  "LC_MONETARY",
  "LC_PAPER",
  "LC_MEASUREMENT",
  "LC_ADDRESS",
  "LC_TELEPHONE",
];

function systemLanguages(env = process.env) {
  const codes = [];
  try {
    const { app } = require("electron");
    codes.push(...(app.getPreferredSystemLanguages?.() || []), app.getLocale?.());
  } catch {
    // Not running under Electron (tests).
  }
  for (const name of LOCALE_ENV_VARS) {
    codes.push(...String(env[name] || "").split(":"));
  }
  return codes.map((code) => baseLanguage(String(code || "").split(".")[0])).filter(Boolean);
}

// Which languages language ID may choose from. Letting it pick among all 25
// Canary languages misread 2 of 100 German dictations as Latvian/Croatian, and
// Canary then translates, so the set is limited to what the user speaks.
function candidateLanguages(supported, spokenLanguages, env = process.env) {
  const pick = (codes) =>
    [...new Set(codes.map(baseLanguage))].filter((code) => supported.includes(code));
  const spoken = pick(Array.isArray(spokenLanguages) ? spokenLanguages : []);
  if (spoken.length) return spoken;
  const fallback = pick([...systemLanguages(env), "en"]);
  return fallback.length ? fallback : supported.slice(0, 1);
}

function sidecarError(reply, fallback) {
  const error = new Error(reply?.error || fallback);
  if (reply?.status === STATUS_ABORTED) return createAbortError(error.message);
  error.status = reply?.status;
  return error;
}

class TranscribeCppServer {
  constructor() {
    this.process = null;
    this.port = null; // never a TCP port; kept for status parity with the sherpa server
    this.ready = false;
    this.modelName = null;
    this.modelInfo = null;
    this.startupPromise = null;
    this.startingModelName = null;
    this.crashCount = 0;
    this.stdoutBuffer = "";
    this.waiters = []; // resolve callbacks for the next stdout lines, in order
    this.queue = Promise.resolve();
    this.cachedBinaryPath = undefined;
    this.cachedLibraryDir = undefined;
  }

  getBinaryPath() {
    if (this.cachedBinaryPath === undefined) {
      this.cachedBinaryPath = resolveBinaryPath(
        `transcribe-sidecar-${process.platform}-${process.arch}`
      );
    }
    return this.cachedBinaryPath;
  }

  getLibraryDir() {
    if (this.cachedLibraryDir === undefined) this.cachedLibraryDir = resolveLibraryDir();
    return this.cachedLibraryDir;
  }

  isAvailable() {
    return Boolean(this.getBinaryPath() && this.getLibraryDir());
  }

  // The sidecar decodes one request at a time.
  get maxConcurrentDecodes() {
    return 1;
  }

  async start(modelName, modelDir) {
    while (this.startupPromise) {
      if (this.startingModelName === modelName) return this.startupPromise;
      await this.startupPromise.catch(() => {});
    }
    if (this.ready && this.process && this.modelName === modelName) return;
    if (this.crashCount >= MAX_CONSECUTIVE_CRASHES) {
      throw new Error("transcribe.cpp sidecar crashed repeatedly; restart the app to retry");
    }

    this.startingModelName = modelName;
    this.startupPromise = (async () => {
      try {
        if (this.process) await this.stop();
        await this._doStart(modelName, modelDir);
      } finally {
        this.startupPromise = null;
        this.startingModelName = null;
      }
    })();
    return this.startupPromise;
  }

  async _doStart(modelName, modelDir) {
    const binary = this.getBinaryPath();
    const libDir = this.getLibraryDir();
    if (!binary || !libDir) throw new Error("transcribe.cpp sidecar not found");

    const info = getModelInfo(modelName);
    const fileNames = (info?.files || []).map((file) => file.name);
    const nThreads = resolveThreads();
    const args = ["--model", path.join(modelDir, "model.gguf"), "--threads", String(nThreads)];
    if (fileNames.includes("langid.gguf"))
      args.push("--langid", path.join(modelDir, "langid.gguf"));

    const started = Date.now();
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
        // Only the CPU backend: never load GPU driver code.
        TRANSCRIBE_BACKENDS: "cpu",
      },
    });
    this.process = child;
    this.stdoutBuffer = "";
    this.waiters = [];
    sidecarPidFile.write(SIDECAR_NAME, child.pid);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this._onStdout(chunk));
    // Library logs only (model info, warnings); stdout carries the transcripts.
    child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line) debugLogger.debug("transcribe.cpp sidecar", { line: line.slice(0, 300) });
      }
    });
    child.stdin.on("error", () => {});
    child.on("close", (code, signal) => this._onClose(child, code, signal));

    let ready;
    try {
      ready = await this._nextLine(STARTUP_TIMEOUT_MS, "startup");
    } catch (error) {
      await this.stop();
      throw error;
    }
    if (!ready?.ready) {
      await this.stop();
      throw new Error(`transcribe.cpp failed to load ${modelName}: ${ready?.error || "unknown"}`);
    }
    this.modelName = modelName;
    this.modelInfo = {
      languages: ready.languages || [],
      hasLangId: !!ready.langid,
      languageDetection: info?.languageDetection || null,
    };
    this.ready = true;
    debugLogger.info("transcribe.cpp sidecar ready", {
      modelName,
      arch: ready.arch,
      version: ready.version,
      nThreads,
      startupMs: Date.now() - started,
    });
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      try {
        waiter.resolve(JSON.parse(line));
      } catch {
        waiter.reject(new Error("transcribe.cpp sidecar sent a malformed reply"));
      }
    }
  }

  _onClose(child, code, signal) {
    sidecarPidFile.clear(SIDECAR_NAME);
    if (child !== this.process) return;
    if (!this.stopping) {
      this.crashCount += 1;
      debugLogger.warn("transcribe.cpp sidecar exited", {
        code,
        signal,
        crashCount: this.crashCount,
      });
    }
    this.process = null;
    this.ready = false;
    this.modelName = null;
    const error = new Error("transcribe.cpp sidecar exited");
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  // Resolves with the next JSON line from the sidecar.
  _nextLine(timeoutMs, what) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`transcribe.cpp ${what} timed out`));
        // A hung decode would block every later request; restart the sidecar.
        debugLogger.warn("transcribe.cpp request timed out; stopping sidecar", { what });
        this.stop().catch(() => {});
      }, timeoutMs);
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.waiters.push(waiter);
    });
  }

  // Sends one request and waits for its reply. Requests are serialized, so
  // replies always come back in order.
  _request(kind, arg, samplesBuffer, timeoutMs, signal) {
    const run = async () => {
      if (signal?.aborted) throw createAbortError("transcribe.cpp request cancelled");
      const child = this.process;
      if (!child || !this.ready) throw new Error("transcribe.cpp sidecar is not running");
      const reply = this._nextLine(timeoutMs, kind === "T" ? "transcription" : "language ID");
      const onAbort = () => {
        try {
          child.kill("SIGUSR1");
        } catch {}
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        child.stdin.write(`${kind} ${samplesBuffer.length} ${arg || "-"}\n`);
        child.stdin.write(samplesBuffer);
        return await reply;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  // Picks the decode language once per dictation, before segmentation, so every
  // segment of one dictation uses the same language. Models that detect the
  // language themselves get undefined.
  async resolveLanguage(samplesBuffer, { language, spokenLanguages, signal } = {}) {
    const info = this.modelInfo;
    if (!info || info.languageDetection !== "langid") {
      return { language: undefined, source: "model" };
    }
    const supported = info.languages;
    const requested = baseLanguage(language);
    if (requested && requested !== "auto" && supported.includes(requested)) {
      return { language: requested, source: "setting" };
    }
    const allowed = candidateLanguages(supported, spokenLanguages);
    if (allowed.length === 1 || !info.hasLangId) {
      return { language: allowed[0], source: "fallback" };
    }
    const maxBytes = LANGID_MAX_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
    const clip = samplesBuffer.subarray(0, Math.min(samplesBuffer.length, maxBytes));
    const reply = await this._request("L", allowed.join(","), clip, LANGID_TIMEOUT_MS, signal);
    if (reply.ok && allowed.includes(reply.code)) {
      return {
        language: reply.code,
        source: "langid",
        languageMs: reply.ms,
        // Tried when the chosen language decodes to nothing: Canary returns
        // empty text rather than a transcript when the language is wrong.
        alternatives: allowed.filter((code) => code !== reply.code),
      };
    }
    if (reply.status === STATUS_ABORTED) throw sidecarError(reply);
    // Too short to score (under 0.5s) or a failed run: the first candidate is
    // the user's main language.
    debugLogger.debug("transcribe.cpp language ID failed, using fallback", {
      status: reply.status ?? null,
    });
    return { language: allowed[0], source: "fallback" };
  }

  async transcribe(samplesBuffer, sampleRate, { signal, language } = {}) {
    if (!this.ready || !this.process) throw new Error("transcribe.cpp sidecar is not running");
    if (sampleRate !== SAMPLE_RATE) throw new Error(`unsupported sample rate ${sampleRate}`);
    const audioSeconds = samplesBuffer.length / BYTES_PER_SAMPLE / sampleRate;
    const started = Date.now();
    const reply = await this._request(
      "T",
      language,
      samplesBuffer,
      computeTranscriptionTimeoutMs(audioSeconds),
      signal
    );
    if (!reply.ok) throw sidecarError(reply, "transcribe.cpp transcription failed");
    this.crashCount = 0;
    const text = (reply.text || "").trim();
    return {
      text,
      elapsed: Date.now() - started,
      engineMs: reply.ms,
      ...(reply.truncated ? { truncated: true } : {}),
    };
  }

  async stop() {
    const child = this.process;
    this.ready = false;
    this.modelName = null;
    this.modelInfo = null;
    if (!child) return;
    this.stopping = true;
    try {
      child.stdin.end();
      await gracefulStopProcess(child);
    } catch (error) {
      debugLogger.error("Error stopping transcribe.cpp sidecar", { error: error.message });
    } finally {
      this.stopping = false;
      if (this.process === child) this.process = null;
    }
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      starting: this.startupPromise !== null,
      port: null,
      modelName: this.modelName || this.startingModelName,
      engine: "transcribe-cpp",
    };
  }
}

module.exports = TranscribeCppServer;
module.exports.candidateLanguages = candidateLanguages;
module.exports.resolveLibraryDir = resolveLibraryDir;
