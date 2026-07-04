# Extended Failure Logging Plan

## Goal

Make local dictation failures diagnosable without logging transcript text or uploading private data.

The feature should answer one question after an outage:

> Which stage failed: capture, decode, speech gate, model inference, sidecar/runtime, persistence, or paste?

## Privacy Requirements

- Keep all diagnostics local.
- Do not log transcript text, transcript previews, active window text, clipboard text, or target-app content.
- Log only metadata: timings, byte counts, durations, audio energy, provider/model, retry/fallback outcomes, and sanitized error classes.
- Failed audio retention must be opt-in or clearly local-only with bounded rotation.
- Diagnostic export must exclude audio by default and redact user-specific paths where practical.

## Current Baseline

Already present:

- Metadata-only `transcription-diagnostics.jsonl`.
- Parakeet backend audio analysis: duration, RMS, WAV size, input size.
- CUDA provider metadata: attempted provider, used provider, fallback state, sidecar port.
- Per-attempt metadata: attempt number, retry kind, text length, elapsed time.
- Fast padded retry for non-silent empty Parakeet output.
- No Parakeet transcript preview in `parakeet-ws` debug logging.

Missing:

- End-to-end `recordingId`.
- Capture-stage chunk and recorder lifecycle metadata in the same diagnostic stream.
- Consistent failure classification.
- Suspicious-success detection.
- Failed/suspicious audio retention and rotation.
- Local diagnostic summary/export tooling.

## Data Model

Every dictation should get one `recordingId` at capture start.

Use a compact ID:

```text
rec_YYYYMMDD_HHMMSS_mmm_random
```

Every diagnostic event should include:

- `recordingId`
- `event`
- `timestamp`
- `stage`
- `status`
- `provider`
- `model`
- `durationMs`
- `elapsedMs`
- `errorClass`

Stage values:

- `capture`
- `encode`
- `decode`
- `analysis`
- `inference`
- `retry`
- `fallback`
- `persistence`
- `paste`

Status values:

- `started`
- `success`
- `failure`
- `suspicious`
- `skipped`

## Failure Classes

Use stable machine-readable strings:

- `capture_empty`: recorder produced no usable chunks.
- `capture_too_short`: recording duration below minimum useful threshold.
- `decode_failed`: FFmpeg/WebM/WAV conversion failed.
- `backend_silence`: decoded audio RMS below backend silence threshold.
- `model_empty_non_silent`: decoded audio has speech-like energy but model returned empty text.
- `model_suspicious_short`: text length implausibly short for duration/RMS.
- `model_timeout`: inference timed out.
- `sidecar_unavailable`: sidecar not running or websocket connection failed.
- `cuda_fallback`: CUDA failed and CPU was used.
- `paste_failed`: transcription succeeded but insertion failed.
- `unknown_failure`: fallback when no safer class applies.

## Suspicious Success Rules

A transcription can be technically successful but still suspicious.

Initial rules:

- `durationMs > 8000 && textLength < 20`
- `durationMs > 15000 && charsPerSecond < 2`
- `rms > 0.01 && textLength === 0`
- segment mode has an empty middle or tail segment with `segmentRms > 0.01`
- inference wall time is much higher than recent baseline

Suspicious events should not block user flow. They should log enough metadata to replay/debug later.

## Failed Audio Retention

Store only failed or suspicious audio locally.

Directory:

```text
~/.config/open-whispr/failed-audio/
```

Files:

```text
<recordingId>.webm
<recordingId>.json
```

Metadata JSON:

```json
{
  "recordingId": "rec_20260704_130323_190_a91f",
  "failureClass": "model_empty_non_silent",
  "durationMs": 2400,
  "rms": 0.0769,
  "providerUsed": "cuda",
  "model": "parakeet-tdt-0.6b-v3",
  "audioPath": "failed-audio/rec_20260704_130323_190_a91f.webm"
}
```

Retention:

- Max files: `50` recordings.
- Max total size: `200 MB`.
- Delete oldest first.
- Audio export disabled by default.

## Diagnostic Summary

Add a local summary script:

```bash
npm run diagnostics:summary
```

It should print:

- failure counts by `errorClass`
- success/suspicious/failure counts by provider/model
- CUDA vs CPU usage
- p50/p95 inference latency
- latest suspicious recordings
- failed audio retained count and size

It must not print transcript text.

## Implementation Phases

### Phase 1: Schema And Correlation

- Add `recordingId` generation in the renderer capture path.
- Pass `recordingId` through IPC to local transcription providers.
- Extend `debugLogger.writeDiagnostic()` schema helpers.
- Add capture lifecycle events: start, chunk, flush, stop, final blob.

Acceptance:

- One dictation produces a linked timeline across capture and Parakeet inference.
- No transcript text appears in diagnostics.

### Phase 2: Failure Classification

- Add a small failure-classifier helper.
- Map Parakeet empty/silence/timeout/sidecar errors to stable classes.
- Preserve current user-facing messages, but log precise internal classes.

Acceptance:

- “No audio detected” can be separated into capture empty, backend silence, and model empty non-silent.

### Phase 3: Suspicious Success Detection

- Add heuristic checks after transcription.
- Log `status: suspicious` without blocking normal paste/save.
- Include text length only, not text.

Acceptance:

- Short/truncated-looking outputs are visible in diagnostics.

### Phase 4: Failed Audio Retention

- Add local failed-audio directory.
- Save original WebM for failed/suspicious recordings.
- Add rotation by count and size.
- Add setting toggle later if desired.

Acceptance:

- A failed non-silent model output leaves a replayable local audio sample.

### Phase 5: Summary Tool

- Add `scripts/diagnostics-summary.js`.
- Add `npm run diagnostics:summary`.
- Summarize JSONL and failed-audio metadata.

Acceptance:

- We can inspect recent failures with one command and no private transcript output.

## Risks

- More logging can accidentally capture private text if future code is careless.
- Failed audio retention is sensitive even if local-only.
- IDs must cross renderer/main boundaries cleanly without breaking existing IPC.
- Over-aggressive suspicious heuristics can create noise.

## Recommended First Implementation

Start with phases 1, 2, and 5.

Reason:

- They improve diagnosis immediately.
- They avoid storing audio until the metadata path is proven.
- They let us measure whether failed-audio retention is worth enabling.

## Implementation Status

- Phase 1 started: renderer generates `recordingId`; capture, transcription, paste, and persistence events write metadata diagnostics.
- Phase 2 started: Parakeet no-audio paths now return stable failure classes such as `backend_silence`, `model_empty_non_silent`, `model_timeout`, and `sidecar_unavailable`.
- Phase 5 started: `npm run diagnostics:summary` summarizes the local JSONL diagnostics without transcript text.
- Phase 4 is intentionally deferred until metadata-only diagnostics prove the value of retaining failed audio.
