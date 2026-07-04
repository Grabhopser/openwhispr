#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");

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
    const value = row[key] ?? "unknown";
    counts.set(value, (counts.get(value) || 0) + 1);
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
