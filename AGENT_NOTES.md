## Notes

- `OpenWhispr/whisper.cpp` release `0.0.6` ships `whisper-server-*-cuda` assets (Linux/Windows x64). `scripts/download-whisper-cpp.js` previously hardcoded CPU zips only.
- Upstream CUDA `whisper-server` binary (`0.0.6`) runs with user-space CUDA 12 runtime libs from Python wheels: `nvidia-cuda-runtime-cu12` + `nvidia-cublas-cu12` (no system CUDA downgrade required).
- OpenWhispr Parakeet (`sherpa-onnx` v1.12.23) default Linux shared build is CPU-only. Upstream GPU archive exists: `sherpa-onnx-v1.12.23-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2` and contains `sherpa-onnx-offline-websocket-server` + `libonnxruntime_providers_cuda.so`.
- After switching to the upstream GPU Parakeet archive, direct `--provider=cuda` launch fails on missing CUDA 12 libs (`libcublasLt.so.12`, `libcublas.so.12`, `libcudart.so.12`, `libcufft.so.11`) while `libcudnn.so.9` is present.
- Parakeet GPU path works with local user-space CUDA 12 wheels in `~/.cache/openwhispr/cuda12-runtime`: `nvidia-cuda-runtime-cu12`, `nvidia-cublas-cu12`, `nvidia-cufft-cu12`, `nvidia-nvjitlink-cu12` (cuDNN 9 resolved from system `/usr/lib` on this host).

## 2026-05-30 Upgrade v1.7.2 Parakeet CUDA

- Created branch `upgrade-v1.7.2-parakeet-cuda`.
- Checkpoint commit before upstream merge: `3f66f7ab`.
- Upstream `v1.7.2` merge commit with CUDA fork changes: `2d488d4c`.
- Package identity set to `1.7.2-parakeet-cuda.1`.
- Official upstream update checks are disabled by default in `src/updater.js`; set `OPENWHISPR_ENABLE_UPSTREAM_UPDATES=1` only if intentionally testing upstream updates.
- `electron-builder.json` publish owner changed to `Grabhopser` to avoid official upstream release metadata.
- Node toolchain note: repo `.nvmrc` is `24`; current system Node is `v26.1.0`. `npm install` needs `npm_config_engine_strict=false` on Node 26 because `better-sqlite3@12.8.0` allows Node 20-25 only. Prefer Node 24 for packaging.
- Electron install note: `node_modules/electron/install.js` returned success but did not populate `dist/electron`; manually extracted cached Electron `41.2.0` zip into `node_modules/electron/dist` and wrote `node_modules/electron/path.txt` for runtime helper tests.
- Milestone 1 checks passed: `npm run typecheck`, `npm run build:renderer`, `npm run lint` (3 warnings, 0 errors).
- Parakeet runtime proof against `/home/ga73dir/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3`:
  - `OPENWHISPR_PARAKEET_PROVIDER=cpu` starts with `--provider=cpu`, reports `providerUsed: cpu`.
  - `OPENWHISPR_PARAKEET_PROVIDER=cuda` starts with `--provider=cuda`, reports `providerUsed: cuda`.
  - `OPENWHISPR_PARAKEET_PROVIDER=auto` chooses `providerAttempts: [cuda, cpu]`, starts with `--provider=cuda`, reports `providerUsed: cuda`.
- Existing packaged AppImage sidecar remains running from `/tmp/.mount_OpenWh...` on port 6006; repo runtime tests used port 6007 and cleaned up after stop.

## 2026-05-30 Packaged Proof

- Built local AppImage successfully with `npm run build:linux:appimage`.
- Artifact: `dist/OpenWhispr-1.7.2-parakeet-cuda.1-linux-x86_64.AppImage` (~863 MB).
- `dist/linux-unpacked/resources/bin` contains `sherpa-onnx-ws-linux-x64`, `libonnxruntime.so`, `libonnxruntime_providers_cuda.so`, `libonnxruntime_providers_shared.so`, and `libonnxruntime_providers_tensorrt.so`.
- Extracted app metadata from `dist/linux-unpacked/resources/app.asar`; package version is `1.7.2-parakeet-cuda.1`.
- Simulated packaged resource resolution with `process.resourcesPath=dist/linux-unpacked/resources`; `OPENWHISPR_PARAKEET_PROVIDER=auto` selected CUDA and launched packaged `resources/bin/sherpa-onnx-ws-linux-x64` with `--provider=cuda`.
- Packaged-resource simulation cleaned up the repo-launched sidecar. Existing unrelated AppImage sidecar on port 6006 was left untouched.

## 2026-05-30 Recording Stability

- Renderer `MediaRecorder.stop()` previously relied on a final implicit chunk only. Stabilized by calling `requestData()` before stop, using 1s recorder timeslices, filtering empty chunks, and logging chunk sizes/duration/flush delay.
- Parakeet local mode should not trust the renderer speech gate for hard no-audio decisions. The Parakeet backend already performs RMS silence detection after FFmpeg conversion, so renderer gate now logs but allows Parakeet transcription.
- Long Parakeet recordings previously used hard 15s cuts with no overlap. Segmentation now uses 0.75s overlap and per-segment RMS/duration/text diagnostics to expose partial-transcript failures.

## 2026-06-30 Parakeet Tail Loss Regression

- Recent saved WebM files decoded to full expected duration, so the regression was not recorder truncation.
- Diagnostic replay found Parakeet returning empty text for energetic trailing segments after 15s segmentation, e.g. 22.32s audio segmented to 118 chars while full-chunk transcription returned 179 chars.
- Fix direction: allow Parakeet to transcribe recordings up to 25s as one chunk; keep 15s overlapped segmentation only for longer recordings.
- On 2026-06-30 `nvidia-smi -L` failed with `Driver/library version mismatch`, causing Parakeet `auto` provider detection to choose CPU despite packaged CUDA libraries being present. Added fallback NVIDIA probes via `/proc/driver/nvidia/gpus` and `lspci` so `auto` can attempt CUDA then fall back to CPU if CUDA launch fails.
- Added a metadata-only `transcription-diagnostics.jsonl` flight recorder under the OpenWhispr logs directory. It records Parakeet durations/RMS/provider/retry outcomes, not transcript text.
- 2026-07-04 diagnostics showed short, non-silent CUDA clips can return empty while surrounding clips transcribe normally. Blocking sidecar restart on empty output added 4-5s delay and did not recover text. Empty non-silent output now uses a fast padded-silence retry; sidecar restart remains for transport/timeouts. Removed transcript preview from `parakeet-ws` debug logging.
- Extended failure logging phase 1/2/5 adds renderer-generated `recordingId`, capture/paste/persistence diagnostic events, Parakeet failure classes, and `npm run diagnostics:summary`. Keep transcript text out of diagnostics.
- Tail-loss hardening: stop now waits briefly before final MediaRecorder flush, final empty stop chunks are classified as benign `capture_final_empty_chunk`, and short non-silent tail segments get a context retry before being treated as empty.
- 2026-07-05 tail-loss hardening: Parakeet segmentation now merges final standalone tails shorter than 3s into the previous segment and logs `parakeet_short_tail_merged`, avoiding fragile isolated tail decodes for last words.
- 2026-07-05 tail-loss follow-up: Recent post-deploy losses were single-shot Parakeet decodes (<25s), not segmented tails. Increased recorder stop grace to 500ms and added 0.8s trailing-silence finalization padding to initial Parakeet decode attempts.
- 2026-07-05 suspicious-short hardening: Parakeet now retries non-silent outputs under 8 chars for recordings >=2.5s; persistent suspicious-short outputs fail with `model_suspicious_short` instead of being pasted.
- 2026-08-02 diagnostics: Degradation is Parakeet inference instability, not capture loss. Recent failed/hole cases have normal WebM blobs and strong RMS but CUDA Parakeet returns empty on non-silent single/segment windows. Added wider segment-context recovery for any failed non-silent segment, not only short tails, with `parakeet_segment_context_*` diagnostics.

## 2026-08-02 OpenWhispr CUDA instability package provenance
- Live Parakeet CUDA sidecar loads mixed dependencies: packaged AppImage ONNXRuntime, cached CUDA 12 cublas/cufft/cudart, system `/usr/lib/libcuda.so.580.173.02`, system `/usr/lib/libcudnn.so.9.25.0`, system `/usr/lib/libcudnn_graph.so.9.25.0`, and `/opt/cuda/targets/x86_64-linux/lib/libcurand.so.10.4.3.29`.
- This means system NVIDIA driver, cuDNN, and selected CUDA libraries can influence OpenWhispr behavior despite the AppImage bundle.

## 2026-08-02 ASR model options note
- AMD Ryzen AI ASR material currently centers on Whisper models exported/optimized for Ryzen AI NPU, not a distinct AMD-native ASR model that is clearly better than Parakeet.
- OpenWhispr host currently uses NVIDIA TITAN X Pascal; AMD NPU paths are only relevant on Ryzen AI hardware and likely Windows-first in AMD docs.

## 2026-08-02 Parakeet CUDA hardening deployed
- Added runtime-library provenance diagnostics for the Parakeet CUDA sidecar via `/proc/<pid>/maps`; logs `parakeet_runtime_libraries` with provider, PID, library paths, source counts, and NVIDIA driver version.
- Added Parakeet health tracking and auto-restart controls: `OPENWHISPR_PARAKEET_AUTO_RESTART`, `OPENWHISPR_PARAKEET_RESTART_FAILURES`, `OPENWHISPR_PARAKEET_RESTART_WINDOW_MS`, and `OPENWHISPR_PARAKEET_RESTART_COOLDOWN_MS`.
- Extended `npm run diagnostics:summary` with daily/hourly buckets, attempt modes, restart reasons, current AppImage/process state, package versions, and latest runtime library provenance.
- Rebuilt and restarted `/home/ga73dir/tools/openwhispr/dist/OpenWhispr.AppImage`; live sidecar verified on CUDA with PID 140797 and cuDNN 9.25.0 loaded from `/usr/lib`.

## 2026-08-08 Parakeet post-hardening trial analysis
- Five-day diagnostics show hardening did not materially fix the regression. Since the Aug 2 deploy there were 420 recordings, with Aug 8 at 82 recordings, 6 hard failures (~7.3%), 6 suspicious successes, and 11 recordings containing `model_empty_non_silent` events.
- Hidden partial-risk signal increased: successful recordings with internal Parakeet attempt failures rose from 1.4% on Aug 3 to 11.5% on Aug 7 and 10.3% on Aug 8.
- Attempt failures remain CUDA `model_empty_non_silent`; current runtime provenance is stable and always loads system `/usr/lib/libcudnn.so.9.25.0` plus NVIDIA driver `580.173.02`.
- Segment attempts are worse than single attempts post-deploy: single fail rate ~6.6%, segment fail rate ~13.8%, padded retry fail rate ~32.3%. This supports the user-observed missing middle/tail portions.
- No relevant CUDA/cuDNN/NVIDIA/kernel/GStreamer package updates were found after Aug 2; likely persistent July 31 cuDNN/runtime regression rather than a new update.

## 2026-08-08 upstream upgrade assessment
- Fetched upstream; latest release tag is `v1.8.1`, upstream/main at `1866ecf6`. Local fork remains based on `v1.7.2` plus Parakeet CUDA/hardening commits.
- Full upgrade is large: `v1.7.2..v1.8.1` changes 607 files; local HEAD to upstream/main changes 711 files.
- Upstream has directly relevant Parakeet fixes: `7a3bc345` retries/surfaces silently dropped audible segments, and newer online Parakeet runtime files (`parakeetModelInfo.js`, `parakeetWsResult.js`, online ws server path).
- Recommendation: do not production-upgrade during cuDNN rollback trial. First finish rollback trial, commit current state, then cherry-pick dropped-segment warning or test full v1.8.1 on separate branch.
