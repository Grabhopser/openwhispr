# Parakeet CUDA Enablement Plan (OpenWhispr)

## Goal

Enable local **Parakeet** transcription to use **GPU (CUDA)** on Linux x64 in OpenWhispr, with safe CPU fallback.

## Current State (Confirmed)

- OpenWhispr Parakeet uses `sherpa-onnx` websocket server (`sherpa-onnx-ws-*`)
- Current code does **not** pass `--provider`, so sherpa-onnx defaults to `cpu`
- Bundled `sherpa-onnx` binary is currently **CPU-only**
- Direct test with `--provider=cuda` returns:
  - `Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Fallback to cpu!`
- Upstream `k2-fsa/sherpa-onnx` **does ship** a Linux GPU archive for the pinned version `v1.12.23`
  - `sherpa-onnx-v1.12.23-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2`
  - Includes websocket server + CUDA ONNX Runtime provider libs

## Success Criteria

- Parakeet starts with GPU-capable sherpa-onnx binary on Linux x64
- OpenWhispr launches Parakeet with `--provider=cuda` (when enabled/available)
- Startup logs clearly show whether CUDA provider is active or CPU fallback happened
- If GPU startup fails, app falls back to CPU without breaking transcription

## Step Plan

### Step 0 (Done): Discovery + Feasibility

- Confirm current Parakeet binary is CPU-only
- Confirm upstream GPU archive exists for pinned version
- Confirm archive contains websocket server and CUDA provider libs

### Step 1: Downloader Support for GPU sherpa-onnx

Scope:
- Patch `scripts/download-sherpa-onnx.js`
- Add GPU variant support for Linux x64 (and optionally Windows x64 for symmetry)
- Keep current default behavior safe (CPU/shared unless explicitly selected, or `auto`)

Deliverables:
- `--variant gpu|cpu|auto` (or equivalent flags)
- Correct archive selection for Linux x64 GPU build
- Logs showing selected variant and reason

Validation:
- Download GPU archive
- Confirm `resources/bin/sherpa-onnx-ws-linux-x64` replaced
- Confirm CUDA provider libs copied into `resources/bin/`

### Step 2: Runtime Provider Selection (`--provider=cuda`)

Scope:
- Patch `src/helpers/parakeetWsServer.js`
- Add provider selection logic:
  - Prefer `cuda` on supported Linux x64 GPU build
  - Fall back to `cpu` if unavailable or startup fails

Deliverables:
- `--provider=cuda` passed to sherpa-onnx when enabled
- Configurable override env (example: `OPENWHISPR_PARAKEET_PROVIDER=cpu|cuda|auto`)

Validation:
- Startup args include `--provider=cuda`
- No regression for CPU-only systems

### Step 3: Runtime Library Paths (CUDA 12 / cuDNN 9)

Scope:
- Ensure Parakeet child process can resolve required CUDA/cuDNN libs
- Reuse local runtime approach if needed (similar to Whisper CUDA runtime strategy)

Deliverables:
- Linux `LD_LIBRARY_PATH` wiring for:
  - `resources/bin` (ONNX provider libs)
  - CUDA 12 runtime libs
  - cuDNN 9 libs
- Clear startup error logs if missing libs remain

Validation:
- Direct binary startup succeeds under app-managed environment
- No `libcudart` / `cublas` / `cudnn` loader errors

### Step 4: CUDA Diagnostics / Debug Traces

Scope:
- Add Parakeet startup traces for provider path and fallback reasons

Deliverables:
- Logs for:
  - chosen provider
  - selected binary + archive variant
  - detected fallback (`CPUExecutionProvider` only)
  - explicit sherpa/onnx runtime errors

Validation:
- One transcription run produces enough logs to diagnose provider choice

### Step 5: End-to-End Verification + Docs

Scope:
- Validate actual Parakeet transcription in OpenWhispr using GPU
- Add concise docs for GPU Parakeet setup and troubleshooting

Deliverables:
- Verified local Parakeet transcription path in app
- Troubleshooting notes for CUDA 12 / cuDNN 9 runtime requirements

Validation checklist:
- App starts Parakeet server
- Parakeet server stays up
- Transcription completes
- Logs show CUDA provider active (or clear fallback reason)

## Risks / Unknowns

- Upstream GPU ONNX Runtime may not support older GPUs well (Pascal/TITAN X risk)
- cuDNN 9 runtime path may require bundling or local user-space install
- GPU provider may initialize but still fall back at model/session creation time

## Fallback Strategy

- Keep CPU Parakeet path fully functional
- Add explicit override to force CPU
- Do not remove CPU downloader variant or CPU runtime path

## Working Notes (Commands)

Direct test (current CPU-only bundled binary):

```bash
resources/bin/sherpa-onnx-ws-linux-x64 --provider=cuda ...
```

Expected CPU-only fallback message seen in testing:

```text
Please compile with -DSHERPA_ONNX_ENABLE_GPU=ON ... Available providers: CPUExecutionProvider ... Fallback to cpu!
```
