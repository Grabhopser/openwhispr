# Upstream Upgrade Assessment - 2026-08-08

## Current Local State

Local branch:

- `upgrade-v1.7.2-parakeet-cuda`

Local base:

- upstream tag `v1.7.2`

Current upstream state after fetch:

- latest release tag: `v1.8.1`
- `upstream/main`: `1866ecf6`
- release tags now available: `v1.7.4`, `v1.7.5`, `v1.7.6`, `v1.8.0`, `v1.8.1`

Local working tree is dirty and contains current Parakeet CUDA hardening work. Do not merge/rebase until this is committed or intentionally shelved.

## Size Of Upgrade

Diff from `v1.7.2` to `v1.8.1`:

- `607` files changed
- about `83k` insertions
- about `18k` deletions

Diff from local `HEAD` to `upstream/main`:

- `711` files changed
- about `100k` insertions
- about `22k` deletions

This is a major product upgrade, not a small patch.

## Directly Relevant Upstream Changes

### 1. Dropped Parakeet Segment Handling

Commit:

- `7a3bc345 fix(dictation): Retry and surface silently dropped transcript segments (#1462)`

Behavior:

- If audible audio returns empty text, upstream retries once.
- If a long-recording segment is still empty after retry, upstream marks the transcript as `truncated` instead of silently accepting a partial result.

Assessment:

- Highly relevant to our symptom.
- It does not solve the CUDA inference failure itself.
- It improves visibility and prevents silent acceptance of amputated transcripts.
- Our fork already has stronger metadata diagnostics and context retry, but upstream's explicit `truncated` result should be integrated.

### 2. Online Parakeet Runtime

Files added/changed:

- `src/helpers/parakeetModelInfo.js`
- `src/helpers/parakeetWsResult.js`
- `src/helpers/parakeetWsServer.js`
- `src/helpers/parakeetServer.js`
- `test/helpers/parakeetOnlineStream.test.js`

Behavior:

- Upstream now distinguishes Parakeet model runtime:
  - `offline`
  - `online`
- Online models use `sherpa-onnx-online-ws-*`.
- Online dictation can stream during capture and commit at stop.
- Online finish adds tail padding and tracks final/partial segments.

Assessment:

- Potentially useful for lost-end problems.
- It is a substantial architecture change.
- It may conflict with our CUDA-provider launch path because upstream shown code does not include our `--provider=cuda` logic in the same form.
- Needs explicit CUDA validation before adopting.

### 3. Parakeet Result Parser

File:

- `src/helpers/parakeetWsResult.js`

Behavior:

- Parses offline JSON messages.
- Accumulates online partial/final segment messages.
- Uses latest-final result per segment ID.

Assessment:

- Good quality improvement.
- Low conceptual risk.
- Useful if we adopt online Parakeet runtime.

### 4. Transcription Timeout Improvements

Relevant commits:

- `40b907f3 fix(transcription): scale local transcription timeouts with audio duration (#1104)`
- `3ec11251 fix(transcription): timeout, fresh-connection retry, cancel + global cap for chunked cloud uploads (#1330)`

Assessment:

- Useful general robustness.
- Less likely to fix our specific CUDA empty-output regression.

### 5. Whisper/CUDA Changes

Relevant commits:

- `6f9c7f8c fix(cuda): pin the CUDA whisper binaries and verify their digests (#1372)`
- `f4f4fa2c fix(whisper): stop local transcription splitting words mid-word (#1348)`
- `36df3a81 feat(whisper): Vulkan GPU acceleration for AMD/Intel GPUs (#1185)`

Assessment:

- Good upstream work, but not central because we are staying Parakeet-only.
- Does not directly solve our Parakeet CUDA instability.

## Conflict Risk

Likely conflict-heavy files:

- `src/helpers/audioManager.js`
- `src/helpers/ipcHandlers.js`
- `src/helpers/parakeet.js`
- `src/helpers/parakeetServer.js`
- `src/helpers/parakeetWsServer.js`
- `scripts/download-sherpa-onnx.js`
- `package.json`
- `package-lock.json`
- `electron-builder.json`

Reason:

- Our fork added Parakeet CUDA provider selection, CUDA runtime paths, runtime provenance logging, health restart, and diagnostics.
- Upstream changed Parakeet model/runtime architecture and streaming commit logic.
- These changes touch the same core files.

## Upgrade Value

High value if we want:

- upstream fix for silently dropped Parakeet segments
- online Parakeet streaming architecture
- newer product features and bug fixes
- broader test coverage around Parakeet

Low-to-medium value for the current root-cause question:

- Our logs point to CUDA/cuDNN/ONNXRuntime inference instability.
- Upstream does not obviously remove that runtime dependency.
- The current cuDNN rollback test is more targeted.

## Upgrade Risk

High risk for immediate production use:

- Large diff.
- Many conflicts.
- Parakeet runtime code changed substantially.
- Our CUDA path must be re-applied and revalidated.
- Package-lock and build system changed.
- The upgrade could disturb a currently useful diagnostic baseline during the cuDNN rollback trial.

## Recommendation

Do not upgrade the production AppImage immediately.

Recommended sequence:

1. Finish the cuDNN `9.24.0` trial for at least one normal work session.
2. Commit current hardening state once stable enough.
3. Create a separate upgrade branch from current fork.
4. First cherry-pick or manually port only the upstream dropped-segment/truncated warning logic from `7a3bc345` if needed.
5. Only then attempt a full `v1.8.1` merge in an isolated branch.
6. Re-apply and verify our Parakeet CUDA features:
   - `--provider=cuda`
   - CUDA runtime path setup
   - runtime library provenance logging
   - sidecar health restart
   - diagnostics summary
7. Build a test AppImage, but do not make it default until it passes a multi-day trial.

## Practical Upgrade Strategy

Preferred path:

- Short term: stay on current fork + cuDNN rollback trial.
- Medium term: cherry-pick the explicit dropped-segment warning behavior.
- Longer term: full `v1.8.1` upgrade branch if upstream online Parakeet proves useful.

Avoid:

- merging `upstream/main` directly into the active production branch
- changing CUDA/cuDNN runtime and upstream app version at the same time
- losing our diagnostic baseline before we know whether cuDNN rollback helped
