#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="packaged"
OUT_DIR="${HOME}/AgentsWorkplace"
INTERVAL_SEC="0.2"

usage() {
  cat <<'USAGE'
Usage:
  bash scripts/capture-parakeet-gpu-evidence.sh [--mode packaged|source] [--out-dir PATH]

Examples:
  bash scripts/capture-parakeet-gpu-evidence.sh --mode packaged
  bash scripts/capture-parakeet-gpu-evidence.sh --mode source --out-dir "$HOME/AgentsWorkplace"
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --mode=*)
      MODE="${1#*=}"
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

if [[ "${MODE}" != "packaged" && "${MODE}" != "source" ]]; then
  echo "Invalid --mode: ${MODE}. Use packaged|source." >&2
  exit 2
fi

mkdir -p "${OUT_DIR}"

if [[ "${MODE}" == "packaged" ]]; then
  BIN_DIR="${REPO_DIR}/dist/linux-unpacked/resources/bin"
else
  BIN_DIR="${REPO_DIR}/resources/bin"
fi

SHERPA_PATH="${BIN_DIR}/sherpa-onnx-ws-linux-x64"

if [[ ! -x "${SHERPA_PATH}" ]]; then
  echo "Missing executable sherpa binary: ${SHERPA_PATH}" >&2
  if [[ "${MODE}" == "packaged" ]]; then
    echo "Run: npm run build:linux (at least until linux-unpacked is generated)." >&2
  else
    echo "Run: npm run download:sherpa-onnx -- --variant gpu --force" >&2
  fi
  exit 1
fi

STAMP="$(date +%Y%m%d_%H%M%S)"
CAPTURE_LOG="${OUT_DIR}/gpu_capture_parakeet_${MODE}_${STAMP}.csv"
VALIDATOR_LOG="${OUT_DIR}/parakeet_validator_${MODE}_${STAMP}.log"
VALIDATOR_JSON="${OUT_DIR}/parakeet_validator_${MODE}_${STAMP}.json"
SUMMARY_TXT="${OUT_DIR}/parakeet_gpu_evidence_${MODE}_${STAMP}.txt"

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

OPENWHISPR_LOG_LEVEL=warn node "${REPO_DIR}/scripts/validate-parakeet-cuda-runtime.js" \
  --bin-dir "${BIN_DIR}" \
  --out "${VALIDATOR_JSON}" > "${VALIDATOR_LOG}" 2>&1
VALIDATOR_EXIT=$?

sleep 0.5
kill "${CAP_PID}" >/dev/null 2>&1 || true
unset CAP_PID

TARGET_SAMPLES="$(awk -F', *' -v target="${SHERPA_PATH}" 'NR>1 && $3==target {c++} END {print c+0}' "${CAPTURE_LOG}")"
TARGET_FIRST_MEM="$(awk -F', *' -v target="${SHERPA_PATH}" 'NR>1 && $3==target {m=$4; gsub(/ MiB/, "", m); print m+0; exit} END {if (NR==1) print 0}' "${CAPTURE_LOG}")"
TARGET_LAST_MEM="$(awk -F', *' -v target="${SHERPA_PATH}" 'NR>1 && $3==target {m=$4; gsub(/ MiB/, "", m); last=m+0} END {print last+0}' "${CAPTURE_LOG}")"
TARGET_MAX_MEM="$(awk -F', *' -v target="${SHERPA_PATH}" 'NR>1 && $3==target {m=$4; gsub(/ MiB/, "", m); if (m+0>max) max=m+0} END {print max+0}' "${CAPTURE_LOG}")"
TARGET_PIDS="$(awk -F', *' -v target="${SHERPA_PATH}" 'NR>1 && $3==target {pid[$2]=1} END {for (p in pid) printf "%s ", p}' "${CAPTURE_LOG}" | xargs || true)"

{
  echo "mode=${MODE}"
  echo "validator_exit=${VALIDATOR_EXIT}"
  echo "repo_dir=${REPO_DIR}"
  echo "bin_dir=${BIN_DIR}"
  echo "target_sherpa_path=${SHERPA_PATH}"
  echo "capture_log=${CAPTURE_LOG}"
  echo "validator_log=${VALIDATOR_LOG}"
  echo "validator_json=${VALIDATOR_JSON}"
  echo "target_samples=${TARGET_SAMPLES}"
  echo "target_first_mem_mib=${TARGET_FIRST_MEM}"
  echo "target_last_mem_mib=${TARGET_LAST_MEM}"
  echo "target_max_mem_mib=${TARGET_MAX_MEM}"
  echo "target_pids=${TARGET_PIDS:-none}"
  node - "${VALIDATOR_JSON}" <<'NODE'
const fs = require("fs");
const p = process.argv[2];
const d = JSON.parse(fs.readFileSync(p, "utf8"));
const auto = d.cases.find((c) => c.name === "B_auto")?.status?.backendTrace || {};
console.log(`validation_all_passed=${Boolean(d.evaluation?.allPassed)}`);
console.log(`validation_expect_cuda_auto=${Boolean(d.expectCudaInAuto)}`);
console.log(`auto_provider_attempted=${auto.providerAttempted || "unknown"}`);
console.log(`auto_provider_used=${auto.providerUsed || "unknown"}`);
console.log(`auto_fallback_used=${Boolean(auto.fallbackUsed)}`);
NODE
} | tee "${SUMMARY_TXT}"

echo
echo "Top matching GPU rows for target process:"
rg -n "sherpa-onnx-ws-linux-x64" "${CAPTURE_LOG}" | head -n 20 || true

