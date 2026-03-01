#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const REPO_DIR = path.resolve(__dirname, "..");
const DEFAULT_SAMPLES_PATH = path.join(__dirname, "cleanup-benchmark-samples.json");
const DEFAULT_ENDPOINT = process.env.CLEANUP_ENDPOINT || "http://127.0.0.1:8000/v1";
const DEFAULT_OUT_DIR = path.join(REPO_DIR, "benchmark-results");
const DEFAULT_AGENT_NAME = "OpenWhispr";
const DEFAULT_TIMEOUT_MS = 60000;

function parseArgs(argv) {
  const args = {
    endpoint: DEFAULT_ENDPOINT,
    model: process.env.CLEANUP_MODEL || "",
    apiKey: process.env.CUSTOM_REASONING_API_KEY || process.env.OPENAI_API_KEY || "",
    samples: DEFAULT_SAMPLES_PATH,
    runs: 1,
    out: "",
    compare: "",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    agentName: DEFAULT_AGENT_NAME,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--endpoint" && argv[i + 1]) {
      args.endpoint = argv[++i];
    } else if (arg.startsWith("--endpoint=")) {
      args.endpoint = arg.split("=", 2)[1];
    } else if (arg === "--model" && argv[i + 1]) {
      args.model = argv[++i];
    } else if (arg.startsWith("--model=")) {
      args.model = arg.split("=", 2)[1];
    } else if (arg === "--api-key" && argv[i + 1]) {
      args.apiKey = argv[++i];
    } else if (arg.startsWith("--api-key=")) {
      args.apiKey = arg.split("=", 2)[1];
    } else if (arg === "--samples" && argv[i + 1]) {
      args.samples = path.resolve(argv[++i]);
    } else if (arg.startsWith("--samples=")) {
      args.samples = path.resolve(arg.split("=", 2)[1]);
    } else if (arg === "--runs" && argv[i + 1]) {
      args.runs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
    } else if (arg.startsWith("--runs=")) {
      args.runs = Math.max(1, Number.parseInt(arg.split("=", 2)[1], 10) || 1);
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = path.resolve(argv[++i]);
    } else if (arg.startsWith("--out=")) {
      args.out = path.resolve(arg.split("=", 2)[1]);
    } else if (arg === "--compare" && argv[i + 1]) {
      args.compare = path.resolve(argv[++i]);
    } else if (arg.startsWith("--compare=")) {
      args.compare = path.resolve(arg.split("=", 2)[1]);
    } else if (arg === "--timeout-ms" && argv[i + 1]) {
      args.timeoutMs = Math.max(1000, Number.parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS);
    } else if (arg.startsWith("--timeout-ms=")) {
      args.timeoutMs = Math.max(
        1000,
        Number.parseInt(arg.split("=", 2)[1], 10) || DEFAULT_TIMEOUT_MS
      );
    } else if (arg === "--agent-name" && argv[i + 1]) {
      args.agentName = argv[++i];
    } else if (arg.startsWith("--agent-name=")) {
      args.agentName = arg.split("=", 2)[1];
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    }
  }

  args.endpoint = normalizeBaseUrl(args.endpoint);
  return args;
}

function printUsage() {
  console.log(`Usage:
  node scripts/benchmark-cleanup-model.js [options]

Options:
  --endpoint URL         OpenAI-compatible base URL (default: ${DEFAULT_ENDPOINT})
  --model ID             Model ID (auto-discovered from /models if omitted)
  --api-key KEY          Optional bearer token
  --samples PATH         JSON benchmark corpus
  --runs N               Number of runs per sample (default: 1)
  --out PATH             Output JSON path
  --compare PATH         Prior benchmark JSON for delta report
  --timeout-ms N         Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})
  --agent-name NAME      Prompt agent name (default: ${DEFAULT_AGENT_NAME})
`);
}

function normalizeBaseUrl(base) {
  const trimmed = String(base || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function buildEndpointCandidates(base) {
  const lower = base.toLowerCase();
  if (lower.endsWith("/responses")) return [{ url: base, type: "responses" }];
  if (lower.endsWith("/chat/completions")) return [{ url: base, type: "chat" }];
  return [
    { url: `${base}/responses`, type: "responses" },
    { url: `${base}/chat/completions`, type: "chat" },
  ];
}

function buildHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

async function requestJson(url, payload, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function extractResponseText(responseJson) {
  const response = responseJson || {};
  const isResponsesApi = Array.isArray(response.output);
  const isChatCompletions = Array.isArray(response.choices);

  let responseText = "";
  if (isResponsesApi) {
    for (const item of response.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (content?.type === "output_text" && typeof content.text === "string" && content.text) {
          responseText = content.text.trim();
          break;
        }
      }
      if (responseText) break;
    }
  }

  if (!responseText && typeof response.output_text === "string") {
    responseText = response.output_text.trim();
  }

  if (!responseText && isChatCompletions) {
    for (const choice of response.choices) {
      const message = choice?.message ?? choice?.delta;
      const content = message?.content;

      if (typeof content === "string" && content.trim()) {
        responseText = content.trim();
        break;
      }

      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === "string" && part.text.trim()) {
            responseText = part.text.trim();
            break;
          }
        }
      }

      if (responseText) break;

      if (typeof choice?.text === "string" && choice.text.trim()) {
        responseText = choice.text.trim();
        break;
      }
    }
  }

  return responseText;
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function levenshteinDistance(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  const m = left.length;
  const n = right.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1).fill(0);
  const curr = new Array(n + 1).fill(0);

  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }

  return prev[n];
}

function similarityRatio(a, b) {
  const left = normalizeText(a);
  const right = normalizeText(b);
  const maxLen = Math.max(left.length, right.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(left, right) / maxLen;
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildSystemPrompt(agentName) {
  const promptDataPath = path.join(REPO_DIR, "src", "config", "promptData.json");
  const promptData = JSON.parse(fs.readFileSync(promptDataPath, "utf8"));
  const template = String(promptData.CLEANUP_PROMPT || "").trim();
  if (!template) throw new Error("CLEANUP_PROMPT not found in promptData.json");
  return template.replace(/\{\{agentName\}\}/g, agentName || DEFAULT_AGENT_NAME);
}

async function fetchModels(base, apiKey, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/models`, {
      method: "GET",
      headers: buildHeaders(apiKey),
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GET /models failed (${response.status}): ${body.slice(0, 200)}`);
    }
    const payload = await response.json().catch(() => ({}));
    const data = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
    const ids = data
      .map((item) => String(item?.id || item?.name || "").trim())
      .filter((id) => Boolean(id));
    return Array.from(new Set(ids));
  } finally {
    clearTimeout(timer);
  }
}

function checkConstraints(output, sample) {
  const haystack = ` ${normalizeText(output)} `;
  const mustContain = Array.isArray(sample.mustContain) ? sample.mustContain : [];
  const mustNotContain = Array.isArray(sample.mustNotContain) ? sample.mustNotContain : [];

  const containsPass = mustContain.every((term) => haystack.includes(normalizeText(term)));
  const notContainsPass = mustNotContain.every((term) => !haystack.includes(normalizeText(term)));
  const scoreParts = [];
  scoreParts.push(mustContain.length === 0 ? 1 : mustContain.filter((t) => haystack.includes(normalizeText(t))).length / mustContain.length);
  scoreParts.push(
    mustNotContain.length === 0
      ? 1
      : mustNotContain.filter((t) => !haystack.includes(normalizeText(t))).length / mustNotContain.length
  );

  return {
    pass: containsPass && notContainsPass,
    score: average(scoreParts),
  };
}

async function runInference({ endpointBase, model, apiKey, timeoutMs, systemPrompt, inputText }) {
  const candidates = buildEndpointCandidates(endpointBase);
  let lastError = null;

  for (const candidate of candidates) {
    const payload =
      candidate.type === "responses"
        ? {
            model,
            input: [
              { role: "system", content: systemPrompt },
              { role: "user", content: inputText },
            ],
            store: false,
          }
        : {
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: inputText },
            ],
            temperature: 0.2,
          };

    const startedAt = Date.now();
    try {
      const response = await requestJson(candidate.url, payload, apiKey, timeoutMs);
      if (!response.ok) {
        const errorMessage =
          response.data?.error?.message ||
          response.data?.message ||
          `HTTP ${response.status} from ${candidate.type}`;
        if (candidate.type === "responses" && (response.status === 404 || response.status === 405)) {
          lastError = new Error(errorMessage);
          continue;
        }
        throw new Error(errorMessage);
      }

      const output = extractResponseText(response.data);
      if (!output) {
        throw new Error(`Empty response text from ${candidate.type}`);
      }

      return {
        endpointType: candidate.type,
        output,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error;
      if (candidate.type === "responses") continue;
    }
  }

  throw lastError || new Error("No endpoint candidate succeeded");
}

function printSummary(summary, compareSummary = null) {
  console.log("\nCleanup Benchmark Summary");
  console.log("-------------------------");
  console.log(`Endpoint: ${summary.endpoint}`);
  console.log(`Model: ${summary.model}`);
  console.log(`Samples: ${summary.sampleCount} x ${summary.runsPerSample} run(s)`);
  console.log(`Successful calls: ${summary.successfulCalls}/${summary.totalCalls}`);
  console.log(`Mean latency: ${summary.latency.meanMs.toFixed(1)} ms`);
  console.log(`P50 latency: ${summary.latency.p50Ms.toFixed(1)} ms`);
  console.log(`P95 latency: ${summary.latency.p95Ms.toFixed(1)} ms`);
  console.log(`Exact-match rate: ${(summary.quality.exactMatchRate * 100).toFixed(1)}%`);
  console.log(`Constraint pass rate: ${(summary.quality.constraintPassRate * 100).toFixed(1)}%`);
  console.log(`Mean similarity: ${summary.quality.meanSimilarity.toFixed(3)}`);
  console.log(`Mean quality score: ${summary.quality.meanQualityScore.toFixed(3)}`);
  console.log(`Mean output chars/sec: ${summary.throughput.meanCharsPerSecond.toFixed(1)}`);

  if (compareSummary) {
    const latencyDelta = summary.latency.meanMs - compareSummary.latency.meanMs;
    const qualityDelta = summary.quality.meanQualityScore - compareSummary.quality.meanQualityScore;
    console.log("\nComparison");
    console.log("----------");
    console.log(`Against: ${compareSummary.timestampUtc} (${compareSummary.model})`);
    console.log(`Mean latency delta: ${latencyDelta >= 0 ? "+" : ""}${latencyDelta.toFixed(1)} ms`);
    console.log(`Quality score delta: ${qualityDelta >= 0 ? "+" : ""}${qualityDelta.toFixed(3)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.endpoint) throw new Error("Missing --endpoint");
  if (!fs.existsSync(args.samples)) throw new Error(`Benchmark corpus not found: ${args.samples}`);

  const samples = JSON.parse(fs.readFileSync(args.samples, "utf8"));
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("Benchmark corpus is empty");
  }

  const systemPrompt = buildSystemPrompt(args.agentName);

  let model = args.model?.trim();
  if (!model) {
    const discovered = await fetchModels(args.endpoint, args.apiKey, args.timeoutMs);
    if (discovered.length === 0) throw new Error("No models returned from /models");
    model = discovered[0];
    console.log(`Auto-selected model from /models: ${model}`);
  }

  const runs = [];
  const totalCalls = samples.length * args.runs;

  for (let runIndex = 0; runIndex < args.runs; runIndex += 1) {
    for (const sample of samples) {
      const callId = `${sample.id || "sample"}#${runIndex + 1}`;
      const start = Date.now();
      try {
        const result = await runInference({
          endpointBase: args.endpoint,
          model,
          apiKey: args.apiKey,
          timeoutMs: args.timeoutMs,
          systemPrompt,
          inputText: String(sample.input || ""),
        });

        const similarity = similarityRatio(result.output, sample.expected || "");
        const exactMatch =
          normalizeText(result.output) === normalizeText(sample.expected || "") &&
          normalizeText(sample.expected || "").length > 0;
        const constraints = checkConstraints(result.output, sample);
        const qualityScore = 0.6 * similarity + 0.4 * constraints.score;
        const charsPerSecond =
          result.durationMs > 0 ? result.output.length / (result.durationMs / 1000) : 0;

        runs.push({
          id: callId,
          sampleId: sample.id || null,
          runIndex: runIndex + 1,
          input: sample.input,
          expected: sample.expected,
          output: result.output,
          endpointType: result.endpointType,
          durationMs: result.durationMs,
          totalDurationMs: Date.now() - start,
          exactMatch,
          similarity,
          constraintsPass: constraints.pass,
          constraintsScore: constraints.score,
          qualityScore,
          charsPerSecond,
          error: null,
        });
      } catch (error) {
        runs.push({
          id: callId,
          sampleId: sample.id || null,
          runIndex: runIndex + 1,
          input: sample.input,
          expected: sample.expected,
          output: "",
          endpointType: null,
          durationMs: Date.now() - start,
          totalDurationMs: Date.now() - start,
          exactMatch: false,
          similarity: 0,
          constraintsPass: false,
          constraintsScore: 0,
          qualityScore: 0,
          charsPerSecond: 0,
          error: error.message,
        });
      }
    }
  }

  const successful = runs.filter((item) => !item.error);
  const latencies = successful.map((item) => item.durationMs);
  const qualityScores = successful.map((item) => item.qualityScore);
  const similarities = successful.map((item) => item.similarity);
  const throughputs = successful.map((item) => item.charsPerSecond);

  const summary = {
    timestampUtc: new Date().toISOString(),
    endpoint: args.endpoint,
    model,
    sampleCount: samples.length,
    runsPerSample: args.runs,
    totalCalls,
    successfulCalls: successful.length,
    failedCalls: runs.length - successful.length,
    latency: {
      meanMs: average(latencies),
      p50Ms: quantile(latencies, 0.5),
      p95Ms: quantile(latencies, 0.95),
      maxMs: latencies.length > 0 ? Math.max(...latencies) : 0,
    },
    quality: {
      exactMatchRate:
        successful.length > 0
          ? successful.filter((item) => item.exactMatch).length / successful.length
          : 0,
      constraintPassRate:
        successful.length > 0
          ? successful.filter((item) => item.constraintsPass).length / successful.length
          : 0,
      meanSimilarity: average(similarities),
      meanQualityScore: average(qualityScores),
    },
    throughput: {
      meanCharsPerSecond: average(throughputs),
    },
  };

  const output = {
    summary,
    samples,
    runs,
  };

  let compareSummary = null;
  if (args.compare) {
    if (!fs.existsSync(args.compare)) {
      throw new Error(`Compare file not found: ${args.compare}`);
    }
    const comparePayload = JSON.parse(fs.readFileSync(args.compare, "utf8"));
    compareSummary = comparePayload?.summary || null;
  }

  if (!args.out) {
    fs.mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    args.out = path.join(DEFAULT_OUT_DIR, `cleanup-benchmark-${stamp}.json`);
  }

  fs.writeFileSync(args.out, JSON.stringify(output, null, 2));
  printSummary(summary, compareSummary);
  console.log(`\nResult JSON: ${args.out}`);

  if (summary.failedCalls > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`Benchmark failed: ${error.message}`);
  process.exitCode = 1;
});
