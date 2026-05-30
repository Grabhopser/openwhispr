# OpenWhispr v1.7.2 Upgrade Plan for Parakeet CUDA Fork

## Goal

Upgrade this fork from the current `v1.4.11-2-g06672c9a` base to upstream OpenWhispr `v1.7.2`, while preserving and validating the local Parakeet CUDA path.

The target outcome is a locally built OpenWhispr package where:

- Parakeet can run with CUDA on Linux.
- CPU fallback still works.
- Upstream `v1.7.2` fixes are retained.
- The app shutdown/sidecar cleanup behavior remains correct.
- The in-app updater does not accidentally replace the CUDA fork with upstream CPU/default binaries.

## Current Facts

- Local version: `1.4.11`
- Local git description: `v1.4.11-2-g06672c9a`
- Upstream latest checked: `v1.7.2`
- Upstream release date: `2026-05-20`
- Upstream release tag: `e35a3642`
- Upstream release URL: <https://github.com/OpenWhispr/openwhispr/releases/tag/v1.7.2>
- Code delta from local HEAD to `v1.7.2`: `559 files changed, 95964 insertions, 34151 deletions`

## Decision Summary

Do upgrade the fork, but do not install the upstream update directly.

The in-app updater points at official OpenWhispr releases. Installing that build would likely replace the custom Parakeet CUDA work with the upstream package. The safe path is to merge upstream into this fork and build our own package.

## Why Upgrade

Upstream `v1.7.2` contains fixes that matter for this fork:

- Cloud transcription fixed after the Electron `net.fetch` migration.
- Parakeet health-check bug fixed by removing a stale `transcribing` guard.
- Sidecar process cleanup/reaping improvements.
- Linux paste fixes for Wave Terminal, Konsole, and GNOME Wayland.
- Local Whisper VAD wired end-to-end.
- Security migration toward OS keychain plus AES-256-GCM for secrets.
- Reasoning, notes, meeting recording, calendar, and sync improvements.
- Electron and build dependency updates.

## Main Risks

### 1. CUDA Patch Overlap

The upstream upgrade directly touches the same files used by the CUDA work:

- `scripts/download-sherpa-onnx.js`
- `src/helpers/parakeetWsServer.js`
- `src/helpers/whisperServer.js`
- `scripts/download-whisper-cpp.js`
- `main.js`
- `src/helpers/windowManager.js`
- `src/helpers/clipboard.js`
- `package.json`
- `package-lock.json`

This means the upgrade is a real merge, not a simple version bump.

### 2. Packaging Risk

Dev-mode CUDA may work while the packaged AppImage still falls back to CPU if CUDA libraries, binary selection, or environment setup are not included correctly.

### 3. Runtime Dependency Risk

Upstream `v1.7.2` requires Node `>=24`. The local machine and build workflow must match that requirement.

### 4. Secret Migration Risk

Upstream changed API-key and secret storage. First launch after upgrade may migrate secrets. Before testing the upgraded app, create a backup of the OpenWhispr config/data directories.

### 5. Updater Risk

The updater currently targets official OpenWhispr releases. If left unchanged, the app may keep offering upstream builds that do not include Parakeet CUDA.

## Non-Goals

This plan does not attempt to:

- Upstream the CUDA patch to OpenWhispr.
- Support every Linux distribution immediately.
- Bundle every possible CUDA installation layout.
- Replace Whisper with Parakeet everywhere.
- Remove CPU fallback.

## Proposed Upgrade Strategy

Use a controlled branch-based merge.

1. Preserve current work.
2. Merge upstream `v1.7.2`.
3. Re-apply the CUDA changes into the new upstream structure.
4. Validate dev mode.
5. Validate packaged mode.
6. Only then install the local package.

## Phase 0: Pre-Flight Review

### Tasks

- Review this plan.
- Confirm target behavior:
  - Parakeet should prefer CUDA on this machine.
  - CPU fallback remains enabled.
  - Debug logs should clearly show selected provider and fallback reason.
- Decide how to handle the updater:
  - Disable update checks in the fork, or
  - Change update source to the fork, or
  - Keep upstream update checks but clearly warn that upstream builds lose CUDA.

### Exit Criteria

- Upgrade direction approved.
- Updater policy chosen.
- No implementation started before review approval.

## Phase 1: Protect Current State

### Tasks

- Inspect dirty working tree.
- Separate unrelated user changes from CUDA-related changes where possible.
- Commit current CUDA work to a named branch or stash it safely.
- Record the current working CUDA behavior in `AGENT_NOTES.md`.

### Suggested Branch Names

- `main`: current fork state
- `upgrade/v1.7.2-parakeet-cuda`: integration branch

### Exit Criteria

- Current work is recoverable.
- No local modifications are at risk during merge.

## Phase 2: Create Upgrade Branch

### Tasks

- Create `upgrade/v1.7.2-parakeet-cuda` from the current fork state.
- Merge upstream tag `v1.7.2` into the branch.
- Resolve conflicts manually.

### Conflict Priority

Preserve upstream architecture where it improves lifecycle/security, then re-add CUDA support on top.

Especially preserve upstream changes for:

- Sidecar PID files.
- Sidecar reaper behavior.
- Parakeet health-check fix.
- Diarization binary download.
- Secret/keychain migration.
- Linux paste fixes.

### Exit Criteria

- Merge completes.
- No conflict markers remain.
- `package.json` version and scripts match the intended fork behavior.

## Phase 3: Re-Apply Parakeet CUDA Support

### Files

- `scripts/download-sherpa-onnx.js`
- `src/helpers/parakeetWsServer.js`
- Possibly `package.json`
- Possibly packaging config in `electron-builder.json`

### Required Behavior

`scripts/download-sherpa-onnx.js` should support Linux variants:

- `cpu`
- `gpu`
- `auto`

Expected behavior:

- `--variant=gpu` downloads the CUDA 12 / cuDNN 9 sherpa-onnx archive.
- `--variant=cpu` downloads the normal CPU archive.
- `--variant=auto` prefers GPU when NVIDIA/CUDA is detected, otherwise CPU.
- The diarization binary support added upstream must remain intact.

`src/helpers/parakeetWsServer.js` should support:

- `OPENWHISPR_PARAKEET_PROVIDER=auto`
- `OPENWHISPR_PARAKEET_PROVIDER=cuda`
- `OPENWHISPR_PARAKEET_PROVIDER=cpu`
- CUDA launch using `--provider=cuda`
- CPU fallback if CUDA launch fails in `auto` mode
- Debug logs showing provider decision, binary path, CUDA runtime paths, and fallback reason
- Upstream sidecar PID/reaper behavior

### Exit Criteria

- Parakeet server can start with CUDA in dev mode.
- If CUDA is forced and fails, error output is clear.
- If auto mode fails CUDA, CPU fallback starts and logs the reason.

## Phase 4: Reconcile Whisper CUDA Work

### Files

- `scripts/download-whisper-cpp.js`
- `src/helpers/whisperServer.js`
- `src/helpers/whisperCudaManager.js`

### Tasks

- Check whether upstream `v1.7.2` already added or changed CUDA/Vulkan support for Whisper.
- Preserve upstream `whisperCudaManager.js` behavior if it is better than the local patch.
- Avoid duplicating CUDA setup paths.
- Keep debug output for which Whisper path is active.

### Exit Criteria

- Whisper path still works.
- Parakeet CUDA work does not break Whisper local transcription.
- GPU-related code paths are not duplicated unnecessarily.

## Phase 5: Updater Policy

### Options

#### Option A: Disable Upstream Updates in the Fork

Best for avoiding accidental replacement of CUDA builds.

Pros:

- Safest for this machine.
- No accidental upstream CPU/default install.

Cons:

- Manual upgrade process required.

#### Option B: Point Updates to the Fork

Best if the fork will publish its own releases.

Pros:

- Clean long-term path.
- The app can update to CUDA-aware builds.

Cons:

- Requires release discipline and signed/published artifacts.

#### Option C: Keep Upstream Updates with Warning

Least invasive.

Pros:

- Minimal code changes.

Cons:

- User can still accidentally replace CUDA fork.

### Recommendation

Use Option A initially. Revisit Option B after the upgraded CUDA build is stable.

### Exit Criteria

- Updater behavior is explicit.
- The app no longer silently encourages installing a non-CUDA upstream package.

## Phase 6: Build and Test in Dev Mode

### Commands

Run after merge and dependency installation:

```bash
npm run typecheck
npm run lint
npm run build:renderer
```

Then run dev mode:

```bash
OPENWHISPR_PARAKEET_PROVIDER=auto npm run dev:main
```

### Manual Tests

- Start app.
- Select/use Parakeet model.
- Trigger transcription.
- Confirm debug logs show CUDA path.
- Force CPU mode and confirm CPU path still works.
- Force CUDA mode and confirm failures are clear if CUDA is unavailable.
- Quit app and confirm sidecars exit.

### Expected Debug Evidence

Logs should answer:

- Which Parakeet provider was requested?
- Which provider was actually used?
- Which sherpa-onnx binary was launched?
- Was `--provider=cuda` passed?
- Which CUDA library paths were injected?
- Did fallback happen?
- Why did fallback happen?

### Exit Criteria

- Dev mode works with Parakeet CUDA.
- CPU fallback works.
- App quit cleans sidecars.

## Phase 7: Package and Test AppImage

### Tasks

- Build Linux package/AppImage from the upgrade branch.
- Install or run the local artifact.
- Repeat Parakeet CUDA checks outside dev mode.
- Confirm packaged resources include the intended sherpa-onnx binary and required libraries.

### Exit Criteria

- Packaged app uses CUDA when available.
- Packaged app falls back to CPU when CUDA is unavailable.
- Packaged app closes cleanly.
- No upstream official package has replaced the local build.

## Phase 8: Finalize

### Tasks

- Update `README.md` or local setup docs with CUDA-specific instructions.
- Update `LOCAL_WHISPER_SETUP.md` if still relevant.
- Update `AGENT_NOTES.md` with final decisions and commands.
- Optionally tag the fork release.

### Exit Criteria

- Upgrade branch is ready for daily use.
- Rebuild instructions are documented.
- Debug path is documented.

## Review Questions

1. Should the fork disable upstream update notifications immediately?
2. Should Parakeet CUDA be Linux-only for now?
3. Should `auto` mode be the default, or should CUDA be forced on this machine?
4. Should CUDA runtime libraries be bundled in the AppImage, or should the app rely on system/user-installed CUDA libraries?
5. Should Whisper CUDA and Parakeet CUDA share one runtime detection helper?
6. Should we tag a local fork release after the upgrade, for example `v1.7.2-parakeet-cuda.1`?

## Initial Recommendation

Proceed with the upgrade after review, using these choices:

- Disable official upstream update prompts in this fork for now.
- Keep Parakeet CUDA Linux-only initially.
- Default to `auto` provider selection.
- Keep CPU fallback enabled.
- Preserve upstream sidecar lifecycle changes.
- Do not bundle full CUDA immediately; use detected local CUDA runtime first, then evaluate packaging later.
- Create a local tag once the packaged AppImage is verified.

## Goal-Mode Driven Development Addendum

### Primary Goal

Produce a locally installable OpenWhispr `v1.7.2` fork build for this Linux machine where Parakeet uses CUDA by default when available, falls back to CPU safely, and never gets replaced by the official upstream non-CUDA update path by accident.

### Goal Contract

The work is successful only if all of these are true:

- The application reports version/fork identity clearly enough that we know it is our build.
- Parakeet launches with CUDA in `auto` mode on the target machine.
- Logs prove the actual path taken: requested provider, selected provider, binary path, launch args, CUDA library paths, fallback state.
- CPU fallback works when CUDA is unavailable or explicitly disabled.
- App quit terminates Parakeet, Whisper, and other sidecars.
- Upstream `v1.7.2` sidecar, security, and Parakeet health-check fixes remain present.
- The official upstream updater cannot silently replace this fork with a non-CUDA build.
- A packaged AppImage/local artifact behaves the same as dev mode.

### Anti-Goals

Stop or defer if the work starts requiring any of these:

- Broad redesign of the transcription architecture.
- Making CUDA work cross-platform before Linux is stable.
- Publishing public releases before the local build is proven.
- Removing CPU fallback.
- Migrating user secrets without a backup/rollback path.
- Bundling a full CUDA runtime before proving system/local-runtime detection works.

### Milestone 1: Safe Merge Candidate

Goal: get upstream `v1.7.2` merged with CUDA patches reapplied, but do not package yet.

Acceptance criteria:

- Clean git branch with no conflict markers.
- `npm run typecheck` passes or failures are documented and unrelated.
- `npm run build:renderer` passes.
- Parakeet server starts in dev mode.
- Debug logs show provider decision.

Rollback point:

- If merge becomes too invasive, abandon the branch and return to the protected pre-merge commit/stash.

### Milestone 2: Runtime Proof

Goal: prove Parakeet CUDA and CPU fallback behavior in dev mode.

Acceptance criteria:

- `OPENWHISPR_PARAKEET_PROVIDER=cuda` starts with `--provider=cuda` or fails with a clear CUDA error.
- `OPENWHISPR_PARAKEET_PROVIDER=auto` uses CUDA on this machine.
- `OPENWHISPR_PARAKEET_PROVIDER=cpu` uses CPU.
- Forced CUDA failure in `auto` mode falls back to CPU and logs why.
- Sidecar cleanup works after app quit.

Rollback point:

- If CUDA fails due upstream architecture changes, keep the merge branch but disable CUDA default until the launcher is fixed.

### Milestone 3: Packaged Proof

Goal: prove the local AppImage/package behaves like dev mode.

Acceptance criteria:

- Local package builds.
- Packaged app launches.
- Packaged app uses Parakeet CUDA in `auto` mode.
- Packaged app logs the same provider evidence as dev mode.
- Packaged app quits cleanly.
- Official upstream update prompt is disabled or clearly neutralized.

Rollback point:

- If packaged CUDA fails while dev mode works, do not install the package as daily driver. Fix resource paths/runtime library handling first.

### Milestone 4: Daily-Driver Candidate

Goal: make the upgraded fork safe for regular use.

Acceptance criteria:

- Existing user data is backed up before first real launch.
- Secret/key migration is observed once and does not lose API keys.
- Basic dictation works.
- Parakeet transcription works.
- Notes/cleanup path still works.
- Local release tag is created, for example `v1.7.2-parakeet-cuda.1`.
- Setup/debug notes are updated.

## Plan Review Findings

### What Is Strong

- Correctly avoids the in-app upstream updater as the upgrade mechanism.
- Correctly treats the upgrade as a real merge, not a version bump.
- Correctly identifies the direct conflict files.
- Correctly prioritizes upstream sidecar lifecycle fixes over preserving old local code shape.
- Correctly keeps CPU fallback as a hard requirement.

### What Needed Tightening

- The original plan had one broad success target. It now has milestone-specific acceptance criteria.
- The original plan did not define rollback points. Each risky milestone now has one.
- The original plan did not explicitly require fork identity/version proof. This is now part of the goal contract.
- The original plan did not separate dev-mode proof from packaged proof strongly enough. These are now separate milestones.
- The original plan mentioned updater policy, but not as a hard success criterion. It is now mandatory before daily-driver use.

### Best-Plan Recommendation

Use the revised plan with goal-mode milestones. Do not start implementation until these review decisions are answered:

1. Updater policy: choose Option A now, disable official upstream update prompts in this fork.
2. Default provider: use `auto`, not forced CUDA.
3. CUDA scope: Linux only for this iteration.
4. Runtime strategy: detect/use installed CUDA runtime first; do not bundle full CUDA yet.
5. Release identity: use a local fork version/tag such as `1.7.2-parakeet-cuda.1`.
6. Backup requirement: backup OpenWhispr config/data before first upgraded daily-driver launch.
