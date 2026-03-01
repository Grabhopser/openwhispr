#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const REPO_DIR = path.resolve(__dirname, "..");
const DEFAULT_BIN_DIR = path.join(REPO_DIR, "resources", "bin");
const DEFAULT_MODEL_NAME = "parakeet-tdt-0.6b-v3";
const DEFAULT_MODEL_DIR = path.join(
  os.homedir(),
  ".cache",
  "openwhispr",
  "parakeet-models",
  DEFAULT_MODEL_NAME
);

const ParakeetWsServer = require(path.join(REPO_DIR, "src/helpers/parakeetWsServer.js"));

function parseArgs(argv) {
  const args = {
    binDir: DEFAULT_BIN_DIR,
    modelName: DEFAULT_MODEL_NAME,
    modelDir: DEFAULT_MODEL_DIR,
    out: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--bin-dir" && argv[i + 1]) {
      args.binDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--bin-dir=")) {
      args.binDir = path.resolve(arg.split("=", 2)[1]);
    } else if (arg === "--model-dir" && argv[i + 1]) {
      args.modelDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--model-dir=")) {
      args.modelDir = path.resolve(arg.split("=", 2)[1]);
    } else if (arg === "--model-name" && argv[i + 1]) {
      args.modelName = argv[i + 1];
      i += 1;
    } else if (arg.startsWith("--model-name=")) {
      args.modelName = arg.split("=", 2)[1];
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--out=")) {
      args.out = path.resolve(arg.split("=", 2)[1]);
    }
  }

  return args;
}

function ensureFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
}

function hasNvidiaGpu() {
  try {
    const out = execSync("nvidia-smi -L", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 3000,
    });
    return Boolean(out && out.trim());
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function makeCpuOnlyBinaryDir(binDir) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "parakeet-cpu-only-"));
  const required = [
    "sherpa-onnx-ws-linux-x64",
    "libonnxruntime.so",
    "libsherpa-onnx-c-api.so",
    "libsherpa-onnx-cxx-api.so",
  ];
  const optional = ["libonnxruntime_providers_shared.so"];

  required.forEach((name) => {
    const src = path.join(binDir, name);
    ensureFile(src);
    const dest = path.join(tmpDir, name);
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, 0o755);
  });

  optional.forEach((name) => {
    const src = path.join(binDir, name);
    if (fs.existsSync(src)) {
      const dest = path.join(tmpDir, name);
      fs.copyFileSync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
  });

  return tmpDir;
}

async function runCase({ name, provider, modelName, modelDir, binaryDir }) {
  const result = {
    name,
    provider,
    binaryDir,
    started: false,
    stopCompleted: false,
    durationMs: null,
    error: null,
    status: null,
  };

  const priorProvider = process.env.OPENWHISPR_PARAKEET_PROVIDER;
  process.env.OPENWHISPR_PARAKEET_PROVIDER = provider;

  const server = new ParakeetWsServer();
  server.cachedWsBinaryPath = path.join(binaryDir, "sherpa-onnx-ws-linux-x64");

  const startTs = Date.now();
  try {
    await withTimeout(server.start(modelName, modelDir), 60000, `${name} start`);
    result.started = true;
    result.status = server.getStatus();
  } catch (err) {
    result.error = err.message;
  } finally {
    try {
      await withTimeout(server.stop(), 8000, `${name} stop`);
      result.stopCompleted = true;
    } catch (stopErr) {
      result.stopCompleted = false;
      result.error = result.error
        ? `${result.error}; stop_error=${stopErr.message}`
        : stopErr.message;
      try {
        execSync("pkill -9 -f 'sherpa-onnx-ws-linux-x64'", { stdio: "ignore" });
      } catch {}
    }

    if (priorProvider === undefined) {
      delete process.env.OPENWHISPR_PARAKEET_PROVIDER;
    } else {
      process.env.OPENWHISPR_PARAKEET_PROVIDER = priorProvider;
    }
  }

  result.durationMs = Date.now() - startTs;
  return result;
}

function evaluate(results, context) {
  const byName = Object.fromEntries(results.map((r) => [r.name, r]));

  const checks = [];

  const a = byName.A_force_cpu;
  checks.push({
    name: "A_force_cpu_uses_cpu",
    pass: Boolean(
      a &&
        a.started &&
        a.stopCompleted &&
        a.status?.backendTrace?.providerAttempted === "cpu" &&
        a.status?.backendTrace?.providerUsed === "cpu"
    ),
  });

  const b = byName.B_auto;
  const bPass =
    b &&
    b.started &&
    b.stopCompleted &&
    b.status?.backendTrace?.providerPreference === "auto" &&
    ((context.expectCudaInAuto &&
      b.status?.backendTrace?.providerAttempted === "cuda" &&
      b.status?.backendTrace?.providerUsed === "cuda") ||
      (!context.expectCudaInAuto && b.status?.backendTrace?.providerUsed === "cpu"));
  checks.push({
    name: "B_auto_expected_provider_path",
    pass: Boolean(bPass),
  });

  const c = byName.C_force_cuda_with_cpu_only_binary;
  checks.push({
    name: "C_force_cuda_fallback_cpu",
    pass: Boolean(
      c &&
        c.started &&
        c.stopCompleted &&
        c.status?.backendTrace?.providerPreference === "cuda" &&
        c.status?.backendTrace?.providerUsed === "cpu" &&
        c.status?.backendTrace?.fallbackUsed === true
    ),
  });

  return {
    checks,
    allPassed: checks.every((cItem) => cItem.pass),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.env.OPENWHISPR_LOG_LEVEL = process.env.OPENWHISPR_LOG_LEVEL || "warn";

  ensureFile(path.join(args.binDir, "sherpa-onnx-ws-linux-x64"));
  ensureFile(path.join(args.modelDir, "tokens.txt"));

  const cpuOnlyDir = makeCpuOnlyBinaryDir(args.binDir);
  const hasCudaProviderLib = fs.existsSync(path.join(args.binDir, "libonnxruntime_providers_cuda.so"));
  const gpuDetected = hasNvidiaGpu();
  const expectCudaInAuto = hasCudaProviderLib && gpuDetected;

  const cases = [
    {
      name: "A_force_cpu",
      provider: "cpu",
      modelName: args.modelName,
      modelDir: args.modelDir,
      binaryDir: args.binDir,
    },
    {
      name: "B_auto",
      provider: "auto",
      modelName: args.modelName,
      modelDir: args.modelDir,
      binaryDir: args.binDir,
    },
    {
      name: "C_force_cuda_with_cpu_only_binary",
      provider: "cuda",
      modelName: args.modelName,
      modelDir: args.modelDir,
      binaryDir: cpuOnlyDir,
    },
  ];

  const results = [];
  try {
    for (const testCase of cases) {
      results.push(await runCase(testCase));
      await sleep(800);
    }
  } finally {
    try {
      fs.rmSync(cpuOnlyDir, { recursive: true, force: true });
    } catch {}
  }

  const evaluation = evaluate(results, { expectCudaInAuto });
  const output = {
    timestampUtc: new Date().toISOString(),
    host: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    binDir: args.binDir,
    modelName: args.modelName,
    modelDir: args.modelDir,
    gpuDetected,
    hasCudaProviderLib,
    expectCudaInAuto,
    cases: results,
    evaluation,
  };

  if (args.out) {
    fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  }

  console.log(JSON.stringify(output, null, 2));
  if (!evaluation.allPassed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ fatal: err.message }, null, 2));
  process.exitCode = 1;
});
