#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_LOG = path.join(
  os.homedir(),
  ".config",
  "open-whispr",
  "logs",
  "transcription-diagnostics.jsonl"
);

function readRows(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function countBy(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = typeof key === "function" ? key(row) : row[key];
    const normalized = value ?? "unknown";
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * (sorted.length - 1)))];
}

function printCounts(title, counts) {
  console.log(`\n${title}`);
  if (!counts.length) {
    console.log("  none");
    return;
  }
  for (const [key, count] of counts) {
    console.log(`  ${key}: ${count}`);
  }
}

function safeExec(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 3000,
      ...options,
    }).trim();
  } catch {
    return "";
  }
}

function getDayBucket(timestamp) {
  if (!timestamp) return "unknown";
  return String(timestamp).slice(0, 10);
}

function getHourBucket(timestamp) {
  if (!timestamp) return "unknown";
  return String(timestamp).slice(0, 13) + ":00Z";
}

function formatRate(numerator, denominator) {
  if (!denominator) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function printRecordingBuckets(recordingRollup) {
  const days = new Map();
  for (const recording of recordingRollup) {
    const day = getDayBucket(recording.first);
    const bucket = days.get(day) || { recordings: 0, failures: 0, suspicious: 0 };
    bucket.recordings += 1;
    if (!recording.success || recording.transcriptionFailed) bucket.failures += 1;
    if (recording.suspicious) bucket.suspicious += 1;
    days.set(day, bucket);
  }

  console.log("\nDaily recording buckets");
  for (const [day, bucket] of [...days.entries()].slice(-14)) {
    console.log(
      `  ${day}: recordings=${bucket.recordings} failures=${bucket.failures} ` +
        `failureRate=${formatRate(bucket.failures, bucket.recordings)} suspicious=${bucket.suspicious}`
    );
  }

  const latestDay = [...days.keys()].sort().at(-1);
  if (!latestDay) return;

  const hours = new Map();
  for (const recording of recordingRollup.filter((row) => getDayBucket(row.first) === latestDay)) {
    const hour = getHourBucket(recording.first);
    const bucket = hours.get(hour) || { recordings: 0, failures: 0, suspicious: 0 };
    bucket.recordings += 1;
    if (!recording.success || recording.transcriptionFailed) bucket.failures += 1;
    if (recording.suspicious) bucket.suspicious += 1;
    hours.set(hour, bucket);
  }

  console.log(`\nHourly recording buckets for ${latestDay} (UTC)`);
  for (const [hour, bucket] of [...hours.entries()].slice(-12)) {
    console.log(
      `  ${hour}: recordings=${bucket.recordings} failures=${bucket.failures} ` +
        `failureRate=${formatRate(bucket.failures, bucket.recordings)} suspicious=${bucket.suspicious}`
    );
  }
}

function printRuntimeState(rows) {
  const latestRuntime = rows.filter((row) => row.event === "parakeet_runtime_libraries").at(-1);
  const appImagePath = path.join(process.cwd(), "dist", "OpenWhispr.AppImage");
  const appImageTarget = fs.existsSync(appImagePath) ? fs.realpathSync(appImagePath) : "not found";
  const sidecarLines = safeExec("ps", ["-eo", "pid,etime,cmd"])
    .split(/\n/)
    .filter((line) => /sherpa-onnx-ws|OpenWhispr\.AppImage|open-whispr/.test(line))
    .filter((line) => !/diagnostics-summary/.test(line));

  console.log("\nCurrent runtime state");
  console.log(`  AppImage: ${appImageTarget}`);
  if (sidecarLines.length) {
    for (const line of sidecarLines.slice(0, 8)) {
      console.log(`  process: ${line.trim()}`);
    }
  } else {
    console.log("  process: none detected");
  }

  const nvidia = safeExec("nvidia-smi", [
    "--query-gpu=name,driver_version,memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader",
  ]);
  console.log(`  nvidia: ${nvidia || "n/a"}`);

  const packages = safeExec("pacman", [
    "-Q",
    "cuda",
    "cudnn",
    "cudnn-frontend",
    "nvidia-580xx-utils",
    "linux-cachyos",
    "onnxruntime-opt-cuda",
  ]);
  if (packages) {
    console.log("  packages:");
    for (const line of packages.split(/\n/)) {
      console.log(`    ${line}`);
    }
  }

  console.log("\nLatest Parakeet runtime libraries");
  if (!latestRuntime) {
    console.log("  none");
    return;
  }

  console.log(`  timestamp: ${latestRuntime.timestamp || "n/a"}`);
  console.log(`  pid: ${latestRuntime.pid || "n/a"}`);
  console.log(`  providerRequested: ${latestRuntime.providerRequested || "n/a"}`);
  console.log(`  providerUsed: ${latestRuntime.providerUsed || "n/a"}`);
  console.log(`  nvidiaDriverVersion: ${latestRuntime.nvidiaDriverVersion || "n/a"}`);
  console.log("  runtimeSourceCounts:");
  for (const [source, count] of Object.entries(latestRuntime.runtimeSourceCounts || {})) {
    console.log(`    ${source}: ${count}`);
  }
  console.log("  libraryPaths:");
  for (const libraryPath of latestRuntime.libraryPaths || []) {
    console.log(`    ${libraryPath}`);
  }
}

function buildRecordingRollup(rows) {
  const recordings = new Map();
  for (const row of rows) {
    if (!row.recordingId) continue;
    const recording = recordings.get(row.recordingId) || {
      id: row.recordingId,
      first: row.timestamp || "",
      last: row.timestamp || "",
      success: false,
      pasted: false,
      persisted: false,
      transcriptionFailed: false,
      suspicious: false,
      modelEmptyEvents: 0,
      tailFailures: 0,
      textLength: null,
      durationMs: null,
      provider: null,
      failureClasses: new Set(),
    };

    if (row.timestamp && (!recording.first || row.timestamp < recording.first)) {
      recording.first = row.timestamp;
    }
    if (row.timestamp && (!recording.last || row.timestamp > recording.last)) {
      recording.last = row.timestamp;
    }
    if (row.event === "transcription_complete" && row.status === "success") {
      recording.success = true;
      recording.textLength = row.textLength ?? recording.textLength;
      recording.durationMs = row.durationMs ?? recording.durationMs;
      recording.provider = row.provider || recording.provider;
    }
    if (row.event === "paste_complete") recording.pasted = true;
    if (row.event === "persistence_complete") recording.persisted = true;
    if (row.event === "transcription_failed") recording.transcriptionFailed = true;
    if (row.status === "suspicious") recording.suspicious = true;
    if (row.errorClass && row.errorClass !== "capture_empty") {
      recording.failureClasses.add(row.errorClass);
    }
    if (row.errorClass === "model_empty_non_silent") {
      recording.modelEmptyEvents += 1;
      if (row.tailSegment) recording.tailFailures += 1;
    }
    recordings.set(row.recordingId, recording);
  }

  return [...recordings.values()];
}

function main() {
  const logFile = process.argv[2] || DEFAULT_LOG;
  const rows = readRows(logFile);

  console.log(`Diagnostic log: ${logFile}`);
  console.log(`Events: ${rows.length}`);

  if (!rows.length) return;

  const failures = rows.filter(
    (row) =>
      (row.status === "failure" || row.errorClass) &&
      row.event !== "capture_final_empty_chunk" &&
      !(row.event === "capture_chunk_empty" && row.status === "skipped")
  );
  const suspicious = rows.filter((row) => row.status === "suspicious");
  const attempts = rows.filter((row) => row.event === "parakeet_attempt_complete");
  const latencies = attempts.map((row) => row.elapsedMs || row.totalWallMs).filter(Number.isFinite);
  const recordingRollup = buildRecordingRollup(rows);
  const trueFailures = recordingRollup.filter((row) => !row.success || row.transcriptionFailed);
  const partialTailRisks = recordingRollup.filter((row) => row.success && row.tailFailures > 0);

  printCounts("Events by type", countBy(rows, "event").slice(0, 20));
  printCounts("Status counts", countBy(rows, "status"));
  printCounts("Failure classes", countBy(failures, "errorClass"));
  printCounts("Provider used", countBy(rows.filter((row) => row.providerUsed), "providerUsed"));
  printCounts("Retry kinds", countBy(rows.filter((row) => row.retryKind), "retryKind"));
  printCounts("Attempt modes", countBy(attempts.filter((row) => row.mode), "mode"));
  printCounts(
    "Failure classes by provider",
    countBy(
      failures.filter((row) => row.providerUsed || row.provider),
      (row) => `${row.providerUsed || row.provider}:${row.errorClass || "unknown"}`
    )
  );
  printCounts(
    "Failure classes by attempt mode",
    countBy(
      failures.filter((row) => row.mode),
      (row) => `${row.mode}:${row.errorClass || "unknown"}`
    )
  );
  printCounts(
    "Sidecar restart reasons",
    countBy(
      rows.filter((row) =>
        [
          "parakeet_sidecar_restart",
          "parakeet_health_restart_requested",
          "parakeet_health_restart_complete",
          "parakeet_health_restart_failed",
          "parakeet_health_restart_skipped_cooldown",
        ].includes(row.event)
      ),
      (row) => `${row.event}:${row.reason || "unknown"}`
    )
  );

  console.log("\nParakeet attempt latency");
  console.log(`  count: ${latencies.length}`);
  console.log(`  p50Ms: ${percentile(latencies, 50) ?? "n/a"}`);
  console.log(`  p95Ms: ${percentile(latencies, 95) ?? "n/a"}`);
  console.log(`  maxMs: ${latencies.length ? Math.max(...latencies) : "n/a"}`);

  console.log("\nRecording rollup");
  console.log(`  recordings: ${recordingRollup.length}`);
  console.log(`  successful: ${recordingRollup.filter((row) => row.success).length}`);
  console.log(`  pasted: ${recordingRollup.filter((row) => row.pasted).length}`);
  console.log(`  persisted: ${recordingRollup.filter((row) => row.persisted).length}`);
  console.log(`  trueFailures: ${trueFailures.length}`);
  console.log(`  partialTailRisks: ${partialTailRisks.length}`);

  printRecordingBuckets(recordingRollup);
  printRuntimeState(rows);

  console.log("\nRecent suspicious/failure events");
  const recent = rows
    .filter(
      (row) =>
        (row.status === "failure" || row.status === "suspicious" || row.errorClass) &&
        row.event !== "capture_final_empty_chunk" &&
        !(row.event === "capture_chunk_empty" && row.status === "skipped")
    )
    .slice(-20);
  if (!recent.length) {
    console.log("  none");
    return;
  }
  for (const row of recent) {
    console.log(
      `  ${row.timestamp || "no-ts"} ${row.recordingId || "no-id"} ${row.event} ` +
        `status=${row.status || "n/a"} class=${row.errorClass || "n/a"} ` +
        `provider=${row.providerUsed || row.provider || "n/a"} duration=${row.durationSeconds || row.durationMs || "n/a"} ` +
        `textLength=${row.textLength ?? "n/a"} elapsed=${row.elapsedMs || row.totalWallMs || "n/a"}`
    );
  }

  console.log(`\nSuspicious events: ${suspicious.length}`);
}

main();
