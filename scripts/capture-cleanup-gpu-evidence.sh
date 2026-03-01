#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENDPOINT="http://127.0.0.1:8000/v1"
MODEL=""
RUNS="3"
OUT_DIR="${HOME}/AgentsWorkplace"
API_KEY="${CUSTOM_REASONING_API_KEY:-}"
INTERVAL_SEC="0.2"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/capture-cleanup-gpu-evidence.sh [options]

Options:
  --endpoint URL      OpenAI-compatible endpoint base URL (default: http://127.0.0.1:8000/v1)
  --model ID          Optional model id (auto-discovers from /models if omitted)
  --runs N            Benchmark runs per sample (default: 3)
  --out-dir PATH      Output directory (default: $HOME/AgentsWorkplace)
  --api-key KEY       Optional endpoint bearer token
  --interval-sec N    nvidia-smi sampling interval seconds (default: 0.2)

Examples:
  bash scripts/capture-cleanup-gpu-evidence.sh
  bash scripts/capture-cleanup-gpu-evidence.sh --endpoint http://127.0.0.1:11434/v1 --runs 2
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --endpoint)
      ENDPOINT="${2:-}"
      shift 2
      ;;
    --endpoint=*)
      ENDPOINT="${1#*=}"
      shift
      ;;
    --model)
      MODEL="${2:-}"
      shift 2
      ;;
    --model=*)
      MODEL="${1#*=}"
      shift
      ;;
    --runs)
      RUNS="${2:-}"
      shift 2
      ;;
    --runs=*)
      RUNS="${1#*=}"
      shift
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --out-dir=*)
      OUT_DIR="${1#*=}"
      shift
      ;;
    --api-key)
      API_KEY="${2:-}"
      shift 2
      ;;
    --api-key=*)
      API_KEY="${1#*=}"
      shift
      ;;
    --interval-sec)
      INTERVAL_SEC="${2:-}"
      shift 2
      ;;
    --interval-sec=*)
      INTERVAL_SEC="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "nvidia-smi not found. Cannot capture GPU evidence." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found. Benchmark runner requires Node.js." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"

STAMP="$(date +%Y%m%d_%H%M%S)"
CAPTURE_LOG="${OUT_DIR}/cleanup_gpu_capture_${STAMP}.csv"
BENCH_LOG="${OUT_DIR}/cleanup_benchmark_${STAMP}.log"
BENCH_JSON="${OUT_DIR}/cleanup_benchmark_${STAMP}.json"
SUMMARY_TXT="${OUT_DIR}/cleanup_gpu_evidence_${STAMP}.txt"

echo "timestamp,pid,process_name,used_gpu_memory" > "${CAPTURE_LOG}"

cleanup() {
  if [[ -n "${CAP_PID:-}" ]]; then
    kill "${CAP_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

(
  while true; do
    ts="$(date -Iseconds)"
    nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader 2>/dev/null \
      | sed "s|^|${ts},|" >> "${CAPTURE_LOG}" || true
    sleep "${INTERVAL_SEC}"
  done
) &
CAP_PID=$!

BENCH_ARGS=(
  "${REPO_DIR}/scripts/benchmark-cleanup-model.js"
  --endpoint "${ENDPOINT}"
  --runs "${RUNS}"
  --out "${BENCH_JSON}"
)

if [[ -n "${MODEL}" ]]; then
  BENCH_ARGS+=(--model "${MODEL}")
fi

if [[ -n "${API_KEY}" ]]; then
  BENCH_ARGS+=(--api-key "${API_KEY}")
fi

set +e
node "${BENCH_ARGS[@]}" > "${BENCH_LOG}" 2>&1
BENCH_EXIT=$?
set -e

sleep 0.5
kill "${CAP_PID}" >/dev/null 2>&1 || true
unset CAP_PID

node - "${CAPTURE_LOG}" "${BENCH_JSON}" "${ENDPOINT}" "${RUNS}" <<'NODE' | tee "${SUMMARY_TXT}"
const fs = require("fs");

const [capturePath, benchPath, endpoint, runs] = process.argv.slice(2);
const captureCsv = fs.readFileSync(capturePath, "utf8").trim().split(/\r?\n/);
const rows = captureCsv.slice(1).map((line) => {
  const [timestamp, pid, processName, mem] = line.split(/,\s*/);
  const memNum = Number(String(mem || "").replace(/ MiB/i, "").trim()) || 0;
  return { timestamp, pid, processName, mem: memNum };
});

let bench = null;
try {
  bench = JSON.parse(fs.readFileSync(benchPath, "utf8"));
} catch {
  bench = null;
}

const byProcess = new Map();
for (const row of rows) {
  if (!row.processName) continue;
  const current = byProcess.get(row.processName) || { samples: 0, maxMem: 0, pids: new Set() };
  current.samples += 1;
  current.maxMem = Math.max(current.maxMem, row.mem);
  if (row.pid) current.pids.add(row.pid);
  byProcess.set(row.processName, current);
}

const top = [...byProcess.entries()]
  .map(([processName, data]) => ({
    processName,
    samples: data.samples,
    maxMem: data.maxMem,
    pids: [...data.pids],
  }))
  .sort((a, b) => (b.maxMem - a.maxMem) || (b.samples - a.samples))
  .slice(0, 10);

const summary = bench?.summary || null;

console.log(`endpoint=${endpoint}`);
console.log(`runs=${runs}`);
console.log(`capture_log=${capturePath}`);
console.log(`benchmark_json=${benchPath}`);
console.log(`gpu_samples_total=${rows.length}`);
console.log(`gpu_processes_observed=${top.length}`);
if (summary) {
  console.log(`benchmark_model=${summary.model}`);
  console.log(`benchmark_total_calls=${summary.totalCalls}`);
  console.log(`benchmark_successful_calls=${summary.successfulCalls}`);
  console.log(`benchmark_mean_latency_ms=${Number(summary.latency?.meanMs || 0).toFixed(1)}`);
  console.log(`benchmark_quality_score=${Number(summary.quality?.meanQualityScore || 0).toFixed(3)}`);
}
console.log("top_gpu_processes=");
for (const item of top) {
  console.log(
    `  - name=${item.processName}; samples=${item.samples}; max_mem_mib=${item.maxMem}; pids=${item.pids.join("|") || "none"}`
  );
}
NODE

echo
echo "Benchmark log: ${BENCH_LOG}"
echo "Evidence summary: ${SUMMARY_TXT}"

exit "${BENCH_EXIT}"
