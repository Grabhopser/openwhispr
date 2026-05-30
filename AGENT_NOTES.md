## Notes

- `OpenWhispr/whisper.cpp` release `0.0.6` ships `whisper-server-*-cuda` assets (Linux/Windows x64). `scripts/download-whisper-cpp.js` previously hardcoded CPU zips only.
- Upstream CUDA `whisper-server` binary (`0.0.6`) runs with user-space CUDA 12 runtime libs from Python wheels: `nvidia-cuda-runtime-cu12` + `nvidia-cublas-cu12` (no system CUDA downgrade required).
- OpenWhispr Parakeet (`sherpa-onnx` v1.12.23) default Linux shared build is CPU-only. Upstream GPU archive exists: `sherpa-onnx-v1.12.23-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2` and contains `sherpa-onnx-offline-websocket-server` + `libonnxruntime_providers_cuda.so`.
- After switching to the upstream GPU Parakeet archive, direct `--provider=cuda` launch fails on missing CUDA 12 libs (`libcublasLt.so.12`, `libcublas.so.12`, `libcudart.so.12`, `libcufft.so.11`) while `libcudnn.so.9` is present.
- Parakeet GPU path works with local user-space CUDA 12 wheels in `~/.cache/openwhispr/cuda12-runtime`: `nvidia-cuda-runtime-cu12`, `nvidia-cublas-cu12`, `nvidia-cufft-cu12`, `nvidia-nvjitlink-cu12` (cuDNN 9 resolved from system `/usr/lib` on this host).
