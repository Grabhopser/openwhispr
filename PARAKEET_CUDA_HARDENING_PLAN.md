# Parakeet-Only CUDA Hardening Plan

## Objective

Keep OpenWhispr fast by staying on Parakeet CUDA as the only transcription engine, while reducing transient outages where valid speech produces empty, truncated, or suspiciously short output.

Primary target failure mode:

- Capture succeeds.
- Decoded audio is non-silent.
- Parakeet CUDA returns empty or too-short text.
- A replay of the same audio can later produce usable text.

This suggests transient runtime, sidecar, ONNXRuntime, CUDA, cuDNN, or segmentation-state instability rather than a simple microphone failure.

## Non-Goals

- No Whisper fallback.
- No cloud transcription fallback.
- No transcript-content logging.
- No CUDA package downgrade as a first step.
- No broad rewrite of OpenWhispr's capture pipeline unless diagnostics prove capture is the root cause.

## Privacy And DSGVO Constraints

Diagnostics must stay local and metadata-only.

Do not log:

- transcript text
- transcript previews
- clipboard contents
- active-window text
- target application contents
- unbounded raw audio

Allowed diagnostics:

- timestamps
- recording IDs
- durations
- byte counts
- chunk counts
- RMS / peak / silence estimates
- model and provider names
- retry type
- segment index and segment timing
- text length only
- sanitized error classes
- process IDs
- loaded runtime library paths
- package versions

Audio retention:

- local only
- bounded rotation
- existing failed/suspicious retention remains acceptable
- diagnostic export excludes audio by default

## Current Evidence

Current live sidecar uses CUDA and mixed runtime libraries:

- AppImage: `libonnxruntime.so`, `libonnxruntime_providers_cuda.so`
- OpenWhispr cache: CUDA 12 `cublas`, `cufft`, `cudart`
- System: `/usr/lib/libcuda.so.580.173.02`
- System: `/usr/lib/libcudnn.so.9.25.0`
- System: `/usr/lib/libcudnn_graph.so.9.25.0`
- System CUDA: `/opt/cuda/targets/x86_64-linux/lib/libcurand.so.10.4.3.29`

Relevant system changes observed on `2026-07-31 22:38`:

- `cudnn 9.24.0.43-1.1 -> 9.25.0.15-1.1`
- `onnxruntime-opt-cuda 1.28.0-1` installed
- `linux-cachyos 7.1.3-2 -> 7.1.5-1`
- GStreamer packages rebuilt from `1.28.5-2.1` to `1.28.5-4.1`

Working interpretation:

- System updates can affect OpenWhispr even though it is launched as an AppImage.
- CUDA/cuDNN/driver/runtime changes are the highest-probability external cause.
- Capture is not ruled out, but existing logs point more strongly to non-silent inference failures.
- The implementation should first make runtime state observable, then add self-healing around the sidecar.

## Design Principles

- Prefer small reversible changes.
- Treat Parakeet failures as pipeline health signals, not only per-request failures.
- Make every outage explainable by metadata.
- Optimize for user-visible continuity: one failed dictation is bad, repeated failures are worse.
- Keep Parakeet CUDA as default unless explicitly overridden for diagnostics.
- Do not hide failures. Recover when possible, but log the recovery path.

## Phase 0: Baseline Snapshot Before Changes

### Purpose

Capture the exact pre-hardening state so improvements and regressions are measurable.

### Tasks

- Run current diagnostic summary.
- Record current AppImage symlink target.
- Record current Parakeet sidecar command line.
- Record current NVIDIA and CUDA package versions.
- Record current git status.
- Add a short baseline section to `AGENT_NOTES.md`.

### Acceptance Criteria

- We know the current failure counts before implementation.
- We know the current runtime versions.
- We can compare post-change behavior against this baseline.

### Risk

Low. Read-only except notes.

## Phase 1: Runtime Library Provenance Logging

### Purpose

Make the actual CUDA/cuDNN/ONNXRuntime dependency path visible for every sidecar lifecycle.

This answers:

- Which libraries did the live sidecar really load?
- Did a system update change the effective runtime?
- Did an AppImage rebuild actually change what is used at runtime?

### Implementation

Add Linux-only provenance collection after Parakeet sidecar startup:

- Read `/proc/<pid>/maps`.
- Extract unique paths matching:
  - `cuda`
  - `cudnn`
  - `cublas`
  - `cufft`
  - `curand`
  - `onnxruntime`
  - `nvrtc`
  - `nvJitLink`
  - `libnvidia`
- Classify each path source:
  - `appimage`
  - `openwhispr_cache`
  - `system_usr`
  - `system_opt_cuda`
  - `other`
- Log event: `parakeet_runtime_libraries`.

Recommended event fields:

```json
{
  "event": "parakeet_runtime_libraries",
  "stage": "inference",
  "status": "success",
  "providerRequested": "cuda",
  "providerUsed": "cuda",
  "pid": 12345,
  "libraryPaths": [],
  "runtimeSourceCounts": {
    "appimage": 3,
    "openwhispr_cache": 4,
    "system_usr": 3,
    "system_opt_cuda": 1,
    "other": 0
  }
}
```

### Acceptance Criteria

- Every successful sidecar startup logs one provenance event.
- The event contains no transcript text.
- The event is robust if `/proc/<pid>/maps` is temporarily unavailable.
- Diagnostic summary prints the latest provenance block.

### Risk

Low. Read-only process metadata.

## Phase 2: Sidecar Health Window

### Purpose

Recognize when the Parakeet sidecar is entering a degraded state.

A single failed decode can happen. Several non-silent failures close together should be treated as a sidecar health problem.

### Implementation

Add an in-memory health tracker in the Parakeet server manager.

Track rolling events for the last `120s`:

- `model_empty_non_silent`
- `model_suspicious_short`
- `model_timeout`
- websocket connection failures
- sidecar process exits
- successful inference attempts

Ignore for restart decisions:

- `backend_silence`
- `capture_empty`
- user-cancelled or too-short recordings

New diagnostic events:

- `parakeet_health_window_update`
- `parakeet_health_degraded`
- `parakeet_health_recovered`

Recommended metadata:

- window duration
- failure count
- success count
- dominant failure class
- last restart time
- provider used
- sidecar PID

### Acceptance Criteria

- The health tracker differentiates user silence from model failure.
- Summary can show whether outages arrived in clusters.
- No restart behavior changes yet in this phase unless explicitly enabled by config.

### Risk

Low. Observation only.

## Phase 3: Controlled Sidecar Auto-Restart

### Purpose

Recover from transient Parakeet/ONNXRuntime/CUDA bad states without requiring the user to restart OpenWhispr manually.

### Default Policy

Restart when either condition is true:

- `3` non-silent model failures within `120s`.
- any transport-level sidecar failure or sidecar process crash.

Do not restart for:

- clear silence
- capture-empty failures
- isolated single non-silent failure

Cooldown:

- minimum `30s` between automatic restarts
- if restart threshold is hit during cooldown, log but skip restart

After restart:

- clear the health window
- log new sidecar PID
- log fresh runtime-library provenance

New diagnostic events:

- `parakeet_health_restart_requested`
- `parakeet_health_restart_started`
- `parakeet_health_restart_complete`
- `parakeet_health_restart_failed`
- `parakeet_health_restart_skipped_cooldown`

### Runtime Controls

Add environment knobs so we can tune without rebuilding:

```bash
OPENWHISPR_PARAKEET_AUTO_RESTART=1
OPENWHISPR_PARAKEET_RESTART_FAILURES=3
OPENWHISPR_PARAKEET_RESTART_WINDOW_MS=120000
OPENWHISPR_PARAKEET_RESTART_COOLDOWN_MS=30000
```

Default recommendation:

- enable auto-restart by default after implementation if tests show startup latency is acceptable
- keep the env override to disable it immediately if needed

### Acceptance Criteria

- Repeated non-silent model failures trigger one restart.
- Restart does not happen for normal silence.
- Restart cooldown prevents restart loops.
- Restart events are visible in `npm run diagnostics:summary`.
- Normal successful dictation path remains unchanged.

### Risk

Medium-low.

Cost is a latency spike during recovery. This is acceptable because the app is already degraded when the threshold is hit.

## Phase 4: Parakeet Retry And Segment Recovery Audit

### Purpose

Make the current Parakeet-only recovery logic stricter and easier to tune.

We already have partial recovery mechanisms:

- trailing silence for finalization
- padded retry for non-silent empty output
- suspicious-short retry
- short-tail merge
- wider context retry for failed segments

This phase audits and tightens those behaviors.

### Implementation

- Ensure all non-silent empty/suspicious attempts carry stable failure classes.
- Ensure each failed non-silent segment gets at most one context retry.
- Preserve special tail handling because user-observed losses often occur near stop time.
- Log mode for every attempt:
  - `full`
  - `segment`
  - `tail`
  - `segment_context`
  - `tail_context`
- Log segment metadata:
  - segment index
  - total segments
  - segment start/end seconds
  - segment duration
  - RMS
  - retry kind
  - output text length only
- Avoid duplicate explosion from overlap by keeping overlap conservative.

Tuning constants to review:

- `MAX_UNSEGMENTED_SECONDS`
- `MAX_SEGMENT_SECONDS`
- `SEGMENT_OVERLAP_SECONDS`
- `MIN_STANDALONE_TAIL_SECONDS`
- `FINALIZATION_PADDING_SECONDS`
- `SEGMENT_RECOVERY_CONTEXT_SECONDS`
- `TAIL_CONTEXT_SECONDS`

### Acceptance Criteria

- Lost-tail and middle-hole attempts are clearly distinguishable in logs.
- Summary can report failure rate by attempt mode.
- No transcript text is logged.
- Saved failed audio can be replayed with metadata-only comparison.

### Risk

Medium.

Segmentation changes can trade missing words for duplicate words. Any tuning must be tested with saved failed cases and short live sessions.

## Phase 5: Diagnostic Summary Upgrade

### Purpose

Make one command sufficient for outage triage.

### Implementation

Extend `npm run diagnostics:summary` to include:

- daily recording counts
- daily true failure rate
- daily suspicious-success rate
- hourly buckets for current day
- provider usage counts
- failure classes by provider
- failure rate by retry kind
- failure rate by attempt mode
- latest sidecar PID and uptime if running
- current AppImage symlink target
- current Parakeet sidecar command line
- current NVIDIA driver version if available
- current installed package versions for:
  - `cuda`
  - `cudnn`
  - `nvidia-580xx-utils`
  - `linux-cachyos`
  - `onnxruntime-opt-cuda`
- latest `parakeet_runtime_libraries` event
- sidecar restart count and reasons

### Acceptance Criteria

A single command answers:

- Is Parakeet CUDA active?
- Which runtime libraries are loaded?
- Did failures cluster after a system update?
- Did auto-restart trigger?
- Are failures mostly full-recording, middle-segment, or tail-segment failures?
- Did restart improve the next attempts?

### Risk

Low. Metadata-only reporting.

## Phase 6: CPU Diagnostic Probe, Not Fallback

### Purpose

Determine whether the failures are CUDA-specific without changing the product behavior.

This is not a fallback path. It is a diagnostic run mode.

### Implementation

Add helper script:

```bash
scripts/run-openwhispr-parakeet-cpu-diagnostic.sh
```

It should launch the existing AppImage with:

```bash
OPENWHISPR_PARAKEET_PROVIDER=cpu
```

Diagnostics must record:

- `providerRequested: cpu`
- `providerUsed: cpu`
- latency
- failure class counts

### Acceptance Criteria

- User can run a short CPU comparison session deliberately.
- Default boot/startup still uses Parakeet CUDA.
- Summary can compare CPU and CUDA stability.

### Risk

Low. CPU will be slower, but this is manual diagnostics only.

## Phase 7: Runtime Dependency Pinning Decision

### Purpose

Decide whether to reduce exposure to system CUDA/cuDNN changes.

Do not implement this before Phase 1 and Phase 5 produce enough evidence.

### Options

Option A: Keep mixed runtime.

- Least packaging risk.
- Still exposed to system CUDA/cuDNN changes.

Option B: Prefer OpenWhispr-managed CUDA/cuDNN cache before system paths.

- Better reproducibility.
- Requires careful `LD_LIBRARY_PATH` ordering.
- Could break if required libraries are absent or incompatible.

Option C: Bundle more GPU runtime libraries in AppImage where redistribution permits.

- Best reproducibility.
- Larger artifact.
- Highest legal/licensing and compatibility risk.

Option D: Use a containerized/runtime-wrapper launch path.

- Strong isolation.
- Operationally heavier.
- Poor fit for desktop startup simplicity.

### Acceptance Criteria

- We know exactly which system libraries remain in use.
- We can compare failure rates before and after any runtime path change.
- Rollback is one symlink or config change.

### Risk

Medium-high.

CUDA loader changes can fail hard. This phase should only happen after diagnostics justify it.

## Recommended Implementation Batch 1

Implement first:

1. Phase 0 baseline snapshot.
2. Phase 1 runtime library provenance logging.
3. Phase 2 sidecar health window.
4. Phase 3 controlled auto-restart.
5. Phase 5 summary additions needed to inspect phases 1 to 3.

Defer:

- Phase 4 tuning unless the new logs show segment/tail failures remain common.
- Phase 6 CPU probe until we need a deliberate comparison session.
- Phase 7 dependency pinning until provenance shows unstable system libraries are likely causal.

Rationale:

- Batch 1 is low risk and directly targets repeated outages.
- It preserves Parakeet snappiness.
- It gives hard evidence before touching fragile CUDA packaging.

## Validation Plan

Static checks:

```bash
node --check src/helpers/parakeetServer.js
node --check scripts/diagnostics-summary.js
npm run typecheck
npm run lint
```

Build:

```bash
npm run build:linux:appimage
```

Runtime checks:

```bash
ps -eo pid,etime,cmd | rg 'sherpa-onnx-ws|OpenWhispr.AppImage|open-whispr'
npm run diagnostics:summary
```

Manual live checks:

- short dictation
- long dictation above segmentation threshold
- intentional silence
- rapid repeated dictations
- restart OpenWhispr and verify startup provenance event

Expected results:

- CUDA sidecar starts with `--provider=cuda`.
- Diagnostics show loaded runtime libraries.
- Normal dictation latency is unchanged.
- Silence does not trigger health restart.
- Repeated non-silent Parakeet failures trigger sidecar restart.

## Success Metrics

Short term:

- no regression in normal successful dictation latency
- runtime library provenance visible after startup
- restart reason visible when triggered
- summary shows provider, failures, and runtime state without manual log searching

Medium term:

- lower clustered failure rate
- fewer multi-minute outage windows
- fewer user-visible repeated `no audio detected` / failed transcription events for non-silent audio

Hard target after observation:

- true failure rate below `1%` over a normal workday
- no clusters of `3+` non-silent model failures without auto-restart action

## Rollback Plan

If behavior gets worse:

1. Disable auto-restart:

```bash
OPENWHISPR_PARAKEET_AUTO_RESTART=0
```

2. Keep provenance logging if harmless.
3. Repoint `dist/OpenWhispr.AppImage` to the previous known-good AppImage if needed.
4. Restart OpenWhispr.
5. Compare diagnostics before and after rollback.

## Open Decisions Before Implementation

Recommended defaults:

- restart threshold: `3` non-silent model failures
- window: `120s`
- cooldown: `30s`
- auto-restart: enabled by default with env override
- CPU probe script: defer until needed
- dependency pinning: defer until provenance confirms need

Decision needed only if we want more conservative behavior:

- Use threshold `2` for faster recovery but higher risk of unnecessary restarts.
- Use cooldown `60s` for lower restart-loop risk but slower recovery.

## First Files To Inspect During Implementation

Likely targets:

- `src/helpers/parakeetServer.js`
- `src/helpers/parakeet.js`
- `src/helpers/debugLogger.js`
- `scripts/diagnostics-summary.js`
- `package.json` if new scripts are added

## Commit Strategy

Use small commits:

1. `docs: add parakeet cuda hardening plan`
2. `feat: log parakeet cuda runtime provenance`
3. `feat: add parakeet sidecar health restart`
4. `feat: extend diagnostics summary for parakeet runtime`

Do not commit unrelated `backups/` files.
