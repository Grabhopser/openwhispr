# Mixed ASR Backend Strategy

This project should treat transcription as a backend capability, not as a
single model/runtime choice. Parakeet remains the default high-quality local
dictation path, while other runtimes can be added when they give useful GPU,
NPU, or platform coverage.

## Goals

- Preserve the current Parakeet CUDA path for NVIDIA systems.
- Add a stable interface for local ASR backends.
- Detect hardware/runtime capabilities before selecting a backend.
- Record backend evidence in logs so GPU/NPU use is auditable.
- Keep CPU fallback available on every platform.
- Add new hardware vendors incrementally only when packaged validation passes.

## Current Baseline

The current branch verifies:

- Parakeet transcription runs through `sherpa-onnx-ws` with `--provider=cuda`.
- NVIDIA CUDA fallback to CPU is implemented and validated.
- Text cleanup uses `llama-server-vulkan`; this is separate from transcription.

Important distinction:

```text
Parakeet transcription -> sherpa-onnx / ONNX Runtime / CUDA
Text cleanup           -> llama.cpp / Vulkan
```

Vulkan is therefore not a direct drop-in path for Parakeet transcription.

## Backend Matrix

| Platform / device | Preferred backend | Runtime path | Status |
| --- | --- | --- | --- |
| NVIDIA Linux/Windows | Parakeet TDT 0.6B v3 | sherpa-onnx CUDA | Working |
| Any CPU | Parakeet TDT 0.6B v3 | sherpa-onnx CPU | Working fallback |
| Apple Silicon | Parakeet or Whisper | CoreML / MLX | Candidate |
| Intel GPU/NPU | Whisper or Parakeet ONNX | OpenVINO EP | Candidate |
| Windows mixed GPU | Whisper or Parakeet ONNX | DirectML EP | Candidate |
| Qualcomm NPU | Whisper variants | QNN / Qualcomm AI Hub | Candidate |
| AMD Linux | Whisper or Parakeet ONNX | ROCm / MIGraphX | Candidate, higher packaging risk |

## Proposed Interface

Each backend should expose the same contract:

```ts
type AsrBackendId =
  | "parakeet-sherpa"
  | "whisper-local"
  | "whisper-openvino"
  | "whisper-directml"
  | "coreml-local"
  | "custom";

type AsrCapability = {
  backendId: AsrBackendId;
  provider: "cuda" | "cpu" | "coreml" | "openvino" | "directml" | "qnn" | "rocm";
  available: boolean;
  reason?: string;
  evidence?: Record<string, unknown>;
};

type AsrTranscriptionResult = {
  success: boolean;
  text?: string;
  segments?: unknown[];
  source: string;
  model: string;
  diagnostics: {
    backendId: AsrBackendId;
    provider: string;
    fallbackUsed: boolean;
    latencyMs?: number;
    evidence?: Record<string, unknown>;
  };
  error?: string;
};
```

The app should ask an ASR router to select a backend. Individual UI and IPC
paths should not need to know how CUDA, OpenVINO, DirectML, or CoreML are
started.

## Selection Policy

Use explicit user choice first, then automatic selection:

```text
1. User-selected backend/provider, if available.
2. Parakeet CUDA on NVIDIA.
3. Platform-native accelerator candidate.
4. CPU fallback.
5. Cloud/self-hosted provider if configured.
```

Every fallback must log:

- requested backend/provider
- attempted backend/provider
- selected backend/provider
- fallback reason
- process command/provider evidence where safe

Do not log API keys, bearer tokens, or raw private audio.

## Implementation Phases

### Phase 1: Internal Refactor

- Add `src/helpers/asrBackends/`.
- Move Parakeet startup/transcription behind a backend adapter.
- Add an ASR router used by dictation, file transcription, and meeting flows.
- Preserve all current behavior.
- Add tests around provider selection and fallback diagnostics.

### Phase 2: Capability Detection

- Add a capability detector for:
  - NVIDIA CUDA
  - sherpa CUDA provider library
  - Vulkan cleanup support, as separate reasoning capability
  - OpenVINO availability
  - DirectML availability on Windows
  - CoreML/macOS availability
- Add diagnostics IPC for frontend display and evidence capture.

### Phase 3: Second Local ASR Backend

Pick one backend based on target hardware:

- Windows broad GPU: DirectML candidate.
- Intel Linux/Windows: OpenVINO candidate.
- macOS: CoreML/MLX candidate.

Start with a prototype CLI evidence script before wiring UI.

### Phase 4: Packaged Validation

For each backend:

- source validation
- packaged app validation
- GPU/NPU process or runtime evidence
- CPU fallback test
- short dictation quality corpus
- long audio smoke test

## Recommendation

Do not replace Parakeet CUDA now. Use it as the reference backend. Build the
mixed-backend abstraction around it, then add one new accelerated backend at a
time. This keeps current NVIDIA performance while making the system ready for
Intel, Apple, Windows mixed GPU, and NPU paths.
