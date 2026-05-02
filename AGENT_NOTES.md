# Agent Notes

- 2026-05-02: Source Parakeet CUDA validation passed on `WiscoCachy` with NVIDIA TITAN X (Pascal). `resources/bin` contains `sherpa-onnx-ws-linux-x64` and `libonnxruntime_providers_cuda.so`; model files exist under `~/.cache/openwhispr/parakeet-models/parakeet-tdt-0.6b-v3`.
- 2026-05-02: Upstream latest public release is `v1.6.10`; `upstream/main` has moved package metadata to `1.7.0` but no `v1.7.0` tag was present after fetch. `v1.6.10` removes local CUDA validator/evidence scripts and has CPU-only sherpa download config, so CUDA work must be carried forward explicitly during upgrade.
