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

function main() {
  const logFile = process.argv[2] || DEFAULT_LOG;
  const rows = readRows(logFile);

  console.log(`Diagnostic log: ${logFile}`);
  console.log(`Events: ${rows.length}`);

  if (!rows.length) return;

  const failures = rows.filter((row) => row.status === "failure" || row.errorClass);
  const suspicious = rows.filter((row) => row.status === "suspicious");
  const attempts = rows.filter((row) => row.event === "parakeet_attempt_complete");
  const latencies = attempts.map((row) => row.elapsedMs || row.totalWallMs).filter(Number.isFinite);

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

  console.log("\nRecent suspicious/failure events");
  const recent = rows
    .filter((row) => row.status === "failure" || row.status === "suspicious" || row.errorClass)
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
