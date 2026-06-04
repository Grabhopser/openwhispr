# Asahi Linux Notes

This branch is for validating OpenWhispr on Asahi Linux / Apple Silicon Linux
(`linux-arm64` / `aarch64`).

## Current status

Tested on Fedora Asahi Remix 44, `aarch64`.

What works:

- The repo can be installed with Node.js 24.
- `npm install` completes and rebuilds Electron native dependencies for `arm64`.
- The renderer builds successfully.
- Electron Builder can package a native Linux ARM64 tarball with:

  ```bash
  npm run build:linux:tar
  ```

  This produces `dist/OpenWhispr-1.7.2-linux-arm64.tar.gz`.

Known blockers:

- The full Linux prebuild step requires a compiler toolchain for native helper
  binaries:

  ```bash
  sudo dnf install gcc gcc-c++ make
  ```

- Upstream sidecar download scripts currently reject `linux-arm64`:
  - `scripts/download-whisper-cpp.js`
  - `scripts/download-llama-server.js`
  - `scripts/download-sherpa-onnx.js`
  - `scripts/download-qdrant.js`

  These scripts fail with `Unsupported platform/arch: linux-arm64`.

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

The next implementation step is linux-arm64 sidecar support:

- Compile or source ARM64 Linux builds for whisper.cpp / whisper-server.
- Compile or source ARM64 Linux builds for llama-server.
- Compile or source ARM64 Linux builds for sherpa-onnx.
- Compile or source ARM64 Linux builds for qdrant.
- Update the corresponding download scripts to recognize `linux-arm64`.

Until those sidecars are available, the packaged app can be built, but local
offline transcription, Parakeet, local LLM, and local semantic search should be
treated as incomplete on Asahi.
