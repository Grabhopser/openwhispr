# Asahi Linux Notes

This branch is for validating OpenWhispr on Asahi Linux / Apple Silicon Linux
(`linux-arm64` / `aarch64`).

## Minimal supported target

The first Asahi target is a CPU-only local transcription build:

- Local transcription uses Parakeet through the bundled `sherpa-onnx`
  `linux-arm64` sidecar.
- Local speaker diarization uses the existing `sherpa-onnx` ARM64 sidecar.
- Local semantic search falls back to keyword search on Fedora Asahi's 16K-page
  kernels because the upstream Qdrant `linux-arm64` binary currently aborts at
  startup with a jemalloc page-size mismatch.
- Bundled local Whisper and bundled local LLM support are not required for this
  target.
- Cloud transcription and external OpenAI-compatible/LAN reasoning providers can
  still be used when configured.

`npm run prebuild:linux` uses this minimal profile automatically on
`linux-arm64`. It skips bundled `whisper-server`, `llama-server`, and Qdrant
downloads because the currently pinned Whisper/llama release assets do not
provide Linux ARM64 binaries and the upstream Qdrant ARM64 binary is not usable
on Fedora Asahi's 16K-page kernels.
To explicitly attempt the fuller sidecar set, run:

```bash
OPENWHISPR_LINUX_ARM64_FULL=1 npm run prebuild:linux
```

## Current status

Tested on Fedora Asahi Remix 44, `aarch64`.

What works:

- The repo can be installed with Node.js 24.
- `npm install` completes and rebuilds Electron native dependencies for `arm64`.
- The renderer builds successfully.
- `npm run prebuild:linux` completes on `linux-arm64`.
- ARM64 Linux sherpa-onnx sidecars download and package successfully.
- ARM64 Linux qdrant is skipped by the minimal prebuild profile and disabled at
  runtime on 16K-page Asahi kernels to avoid a known jemalloc startup abort.
- Electron Builder can package a native Linux ARM64 tarball with:

  ```bash
  npm run build:linux:tar
  ```

  This produces `dist/OpenWhispr-1.7.2-linux-arm64.tar.gz`.

Build prerequisites:

```bash
sudo dnf install gcc gcc-c++ make libX11-devel libXtst-devel glib2-devel at-spi2-core-devel pkgconf-pkg-config
```

Known blockers:

- Upstream OpenWhispr whisper-server releases currently do not include
  `linux-arm64`. This only blocks bundled local Whisper, not the minimal
  Parakeet transcription target.
- The pinned llama.cpp release used by `scripts/download-llama-server.js` does
  not include a `linux-arm64` mapping. This only blocks bundled local LLM
  support, not transcription.
- Optional Linux desktop helpers require the development headers listed above:
  - `linux-fast-paste`: X11 / XTest, GIO, AT-SPI2.
  - `linux-system-audio-helper`: GIO.
  - `linux-text-monitor`: AT-SPI2, GLib, GObject.
- Qdrant semantic search is disabled on 16K-page Asahi kernels until a Qdrant
  ARM64 build compatible with non-4K pages is available. Keyword search remains
  available.

These optional misses do not prevent an ARM64 tarball build or the minimal
local transcription target.

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

## Minimal runtime verification

After building the tarball on Asahi, verify:

- The app launches from the extracted tarball.
- Settings can download a Parakeet model.
- Local transcription provider is set to NVIDIA / Parakeet.
- A short microphone recording transcribes locally without cloud credentials.
- Paste works in at least one XWayland or Wayland text field.
- Notes open and keyword search works. Semantic search is deferred on 16K-page
  Asahi kernels until a compatible Qdrant binary is available.

For a repeatable Parakeet timing check, run the benchmark against a known audio
file:

```bash
npm run benchmark:parakeet -- /path/to/audio.wav
```

The benchmark prints JSON with audio duration, transcription time, real-time
factor, and transcribed text. WAV input reports duration directly; other formats
are converted through the same app path but may not report duration.

## Deferred work

The deferred full-local feature set requires remaining linux-arm64 sidecar
support:

- Compile or source ARM64 Linux builds for whisper.cpp / whisper-server.
- Compile or source ARM64 Linux builds for llama-server.
- Update the corresponding download scripts to recognize those binaries.

Until those remaining sidecars are available, Parakeet and local speaker
diarization can be packaged for Asahi; local Whisper, bundled local LLM support,
and local semantic search remain incomplete.
