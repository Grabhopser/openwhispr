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
