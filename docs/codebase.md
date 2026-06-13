# Codebase Guide

OpenWhispr is an Electron desktop app. The main process owns native integration,
sidecar processes, persistence, IPC, and packaging-time resources. The renderer
owns the React UI, settings, notes, model pickers, and client-side state.

## Main Process

- `main.js` starts Electron, configures platform behavior, registers protocol
  handlers, creates windows, and wires process-level app behavior.
- `preload.js` exposes the renderer-safe Electron API.
- `src/helpers/ipcHandlers.js` registers IPC handlers used by the renderer.
- `src/helpers/*` owns native helpers, sidecar managers, audio handling,
  database access, model downloads, transcription, meeting detection, and
  platform-specific integration.

## Renderer

- `src/App.jsx` and `src/AppRouter.jsx` mount the application routes and views.
- `src/components/*` contains product UI. Settings-specific views live under
  `src/components/settings`; reusable primitives live under `src/components/ui`.
- `src/hooks/*` contains renderer-side workflow hooks.
- `src/stores/*` contains Zustand stores for settings, notes, transcription,
  meetings, chat, workspaces, and actions.
- `src/services/*` contains API clients, reasoning flows, local/cloud provider
  integration, note services, and tool execution.

## Models And Transcription

- `src/models/modelRegistryData.json` is the source of model/provider metadata.
- `src/models/ModelRegistry.ts` exposes provider and model lookup helpers.
- Local Whisper is managed by `src/helpers/whisper*.js` and requires a bundled
  `whisper-server-*` sidecar.
- Local Parakeet transcription is managed by `src/helpers/parakeet*.js` and uses
  bundled `sherpa-onnx-*` sidecars.
- Local semantic search uses Qdrant through `src/helpers/qdrantManager.js`.
- `npm run benchmark:parakeet -- <audio-file>` measures the same Parakeet
  sidecar path used by the app and reports timing as JSON.

## Native And Packaging

- `resources/` contains native helper source files and packaging scripts.
- `resources/bin/` contains downloaded or built sidecar binaries.
- `scripts/build-*` compiles local native helpers.
- `scripts/download-*` downloads sidecars and models for the current platform.
- `scripts/prebuild-linux.js` prepares Linux packaging dependencies.
- `electron-builder.json` controls packaged files, extra resources, native
  unpacking, Linux targets, and installer hooks.

## Asahi Linux Scope

The first Asahi Linux target is a CPU-only local transcription build. It relies
on the existing Linux ARM64 `sherpa-onnx` sidecar for Parakeet and does not
require bundled `whisper-server`, `llama-server`, or Qdrant. Full bundled local
Whisper, bundled local LLM support, and local semantic vector search are
deferred until Linux ARM64 sidecar binaries exist and are verified.

Use `docs/asahi-linux.md` for the current build matrix, prerequisites, and
runtime verification checklist.
