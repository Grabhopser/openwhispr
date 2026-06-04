# Asahi Linux Notes

This branch is for validating OpenWhispr on Asahi Linux / Apple Silicon Linux
(`linux-arm64` / `aarch64`).

## Current status

Tested on Fedora Asahi Remix 44, `aarch64`.

What works:

- The repo can be installed with Node.js 24.
- `npm install` completes and rebuilds Electron native dependencies for `arm64`.
- The renderer builds successfully.
- `npm run prebuild:linux` completes on `linux-arm64`.
- ARM64 Linux qdrant and sherpa-onnx sidecars download and package successfully.
- Electron Builder can package a native Linux ARM64 tarball with:

  ```bash
  npm run build:linux:tar
  ```

  This produces `dist/OpenWhispr-1.7.2-linux-arm64.tar.gz`.

Build prerequisites:

```bash
sudo dnf install gcc gcc-c++ make
```

Known blockers:

- Upstream OpenWhispr whisper-server releases currently do not include
  `linux-arm64`; `scripts/prebuild-linux.js` treats this as optional on Asahi.
- The pinned llama.cpp release used by `scripts/download-llama-server.js` does
  not include a `linux-arm64` mapping; `scripts/prebuild-linux.js` treats this
  as optional on Asahi.
- Optional Linux desktop helpers need additional development headers:
  - `linux-fast-paste`: X11 / XTest headers.
  - `linux-system-audio-helper`: GIO headers.
  - `linux-text-monitor`: AT-SPI2 and GLib headers.

These optional misses do not prevent an ARM64 tarball build.

## Local test commands

Use Node.js 24 or newer:

```bash
node --version
npm install
npm run build:linux:tar
```

For a full build, first install the native compiler toolchain, then run:

```bash
npm run prebuild:linux
npm run build:linux:tar
```

## Next work

The next implementation step is remaining linux-arm64 sidecar support:

- Compile or source ARM64 Linux builds for whisper.cpp / whisper-server.
- Compile or source ARM64 Linux builds for llama-server.
- Update the corresponding download scripts to recognize those binaries.

Until those remaining sidecars are available, Parakeet, local speaker
diarization, and local semantic search can be packaged for Asahi; local Whisper
and bundled local LLM support remain incomplete.
