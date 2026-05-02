# Windows NVIDIA Validation Handoff

Goal: validate that the `feat/parakeet-cuda-v1.6.10` branch works as the Windows
NVIDIA packaged build before doing broader mixed-ASR-backend work.

## Starting Point

- Repo branch to validate first: `feat/parakeet-cuda-v1.6.10`
- Remote: `git@github.com:Grabhopser/openwhispr.git`
- Do not start with `feat/mixed-asr-backends`; that branch is experimental.
- Linux packaged validation already passed with Parakeet CUDA.
- Windows support is implemented but not yet proven on a Windows NVIDIA machine.

## Windows Machine Requirements

- Windows x64
- NVIDIA GPU visible in `nvidia-smi`
- Recent NVIDIA driver
- Node.js version compatible with the repo (`package.json` requires Node >= 24)
- Git
- PowerShell
- Build tooling required by Electron native dependencies if `npm install` rebuilds modules

## Commands

Run from PowerShell:

```powershell
git clone git@github.com:Grabhopser/openwhispr.git
cd openwhispr
git checkout feat/parakeet-cuda-v1.6.10
npm install

$env:SHERPA_ONNX_VARIANT = "gpu"
npm run download:sherpa-onnx -- --current --force
npm run build:win
npm run validate:parakeet-cuda:win:packaged
npm run evidence:parakeet-gpu:win
```

If the repo is already cloned:

```powershell
git fetch origin
git checkout feat/parakeet-cuda-v1.6.10
git pull --ff-only
```

## What Must Be Verified

### Packaged Files

Check `dist/win-unpacked/resources/bin` contains:

- `sherpa-onnx-ws-win32-x64.exe`
- `onnxruntime_providers_cuda.dll`
- required CUDA/cuDNN/ONNX Runtime companion DLLs copied from the sherpa-onnx GPU archive
- `sherpa-onnx-diarize-win32-x64.exe`

### Runtime Evidence

The packaged validator should report:

```text
evaluation.allPassed = true
B_auto providerAttempted = cuda
B_auto providerUsed = cuda
B_auto fallbackUsed = false
```

The evidence script should capture a GPU process for:

```text
sherpa-onnx-ws-win32-x64.exe
```

with nonzero GPU memory in `nvidia-smi`.

### Manual App Test

After `npm run build:win`, test either `dist/win-unpacked/OpenWhispr.exe` or the
portable/installer artifact.

Manual checks:

- App starts without missing DLL dialogs.
- Select local NVIDIA/Parakeet transcription.
- First dictation starts `sherpa-onnx-ws-win32-x64.exe`.
- `nvidia-smi` shows the sherpa process using GPU memory.
- Debug logs show `providerAttempted: cuda` and `providerUsed: cuda`.
- If CUDA startup fails, app falls back to CPU and logs the fallback reason.
- Key listener, mic listener, paste, and text monitor still work on Windows.

## Useful Diagnostics

```powershell
nvidia-smi
Get-Process | Where-Object { $_.ProcessName -match "OpenWhispr|sherpa|onnx|whisper" }
Get-ChildItem dist\win-unpacked\resources\bin | Sort-Object Name
```

OpenWhispr logs are usually under:

```text
%APPDATA%\OpenWhispr\logs
```

or, for development builds:

```text
%APPDATA%\OpenWhispr-development\logs
```

## Pass Criteria

Windows is considered parity-ready for this CUDA branch only if:

- `npm run validate:parakeet-cuda:win:packaged` passes.
- GPU evidence script captures `sherpa-onnx-ws-win32-x64.exe` on the NVIDIA GPU.
- Manual packaged app transcription succeeds with Parakeet.
- No missing DLL dialogs appear.
- CPU fallback still works when CUDA provider DLL is removed or unavailable.

## If It Fails

Do not assume the model is the problem. First inspect:

- Whether `onnxruntime_providers_cuda.dll` exists in `resources/bin`.
- Whether CUDA/cuDNN companion DLLs are next to the sherpa executable.
- Whether Windows `PATH` includes `resources/bin` before process launch.
- Exact error lines mentioning `LoadLibrary`, `cudart64_12.dll`, `cublas64_12.dll`,
  `cublasLt64_12.dll`, `cufft64_11.dll`, or `cudnn64_9.dll`.

Quote exact errors in the report. Do not include API keys or private transcript text.

## After Windows CUDA Passes

Then switch to:

```powershell
git checkout feat/mixed-asr-backends
```

The next development phase is to extend the ASR router with additional backend
capability detection. Keep Parakeet CUDA as the reference backend.
