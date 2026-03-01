#!/usr/bin/env pwsh
param(
  [ValidateSet("packaged", "source")]
  [string]$Mode = "packaged",
  [string]$OutDir = "$HOME/AgentsWorkplace",
  [double]$IntervalSec = 0.2
)

$ErrorActionPreference = "Stop"

function Parse-Mib([string]$value) {
  if ($null -eq $value) { return 0 }
  if ($value -match "([0-9]+)") { return [int]$matches[1] }
  return 0
}

function Get-ValidatorSummary([string]$ValidatorJsonPath) {
  $payload = Get-Content -Path $ValidatorJsonPath -Raw | ConvertFrom-Json
  $autoCase = $payload.cases | Where-Object { $_.name -eq "B_auto" } | Select-Object -First 1
  $trace = $autoCase.status.backendTrace
  return @{
    validation_all_passed = [bool]$payload.evaluation.allPassed
    validation_expect_cuda_auto = [bool]$payload.expectCudaInAuto
    auto_provider_attempted = if ($trace.providerAttempted) { [string]$trace.providerAttempted } else { "unknown" }
    auto_provider_used = if ($trace.providerUsed) { [string]$trace.providerUsed } else { "unknown" }
    auto_fallback_used = [bool]$trace.fallbackUsed
  }
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $scriptDir "..")).Path

if ($Mode -eq "packaged") {
  $binDir = Join-Path $repoDir "dist/win-unpacked/resources/bin"
} else {
  $binDir = Join-Path $repoDir "resources/bin"
}

$sherpaPath = Join-Path $binDir "sherpa-onnx-ws-win32-x64.exe"
if (!(Test-Path -Path $sherpaPath -PathType Leaf)) {
  Write-Error "Missing executable sherpa binary: $sherpaPath"
  if ($Mode -eq "packaged") {
    Write-Host "Run: npm run build:win (at least until win-unpacked is generated)."
  } else {
    Write-Host "Run: npm run download:sherpa-onnx -- --variant gpu --force"
  }
  exit 1
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$captureLog = Join-Path $OutDir "gpu_capture_parakeet_${Mode}_${stamp}.csv"
$validatorLog = Join-Path $OutDir "parakeet_validator_${Mode}_${stamp}.log"
$validatorJson = Join-Path $OutDir "parakeet_validator_${Mode}_${stamp}.json"
$summaryTxt = Join-Path $OutDir "parakeet_gpu_evidence_${Mode}_${stamp}.txt"

"timestamp,pid,process_name,used_gpu_memory" | Set-Content -Path $captureLog -Encoding utf8

$intervalMs = [Math]::Max(50, [int]($IntervalSec * 1000))
$captureJob = Start-Job -ScriptBlock {
  param($CaptureLog, $IntervalMs)
  while ($true) {
    $ts = (Get-Date).ToString("o")
    try {
      $rows = & nvidia-smi --query-compute-apps=pid,process_name,used_gpu_memory --format=csv,noheader 2>$null
      if ($rows) {
        foreach ($row in $rows) {
          Add-Content -Path $CaptureLog -Value "$ts,$row"
        }
      }
    } catch {
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
} -ArgumentList $captureLog, $intervalMs

$previousLogLevel = $env:OPENWHISPR_LOG_LEVEL
$env:OPENWHISPR_LOG_LEVEL = "warn"
$validatorExit = 0

try {
  & node (Join-Path $repoDir "scripts/validate-parakeet-cuda-runtime.js") --bin-dir $binDir --out $validatorJson 2>&1 `
    | Tee-Object -FilePath $validatorLog
  $validatorExit = $LASTEXITCODE
} finally {
  if ($null -ne $previousLogLevel) {
    $env:OPENWHISPR_LOG_LEVEL = $previousLogLevel
  } else {
    Remove-Item Env:OPENWHISPR_LOG_LEVEL -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
  Stop-Job -Job $captureJob -Force -ErrorAction SilentlyContinue | Out-Null
  Receive-Job -Job $captureJob -ErrorAction SilentlyContinue | Out-Null
  Remove-Job -Job $captureJob -Force -ErrorAction SilentlyContinue
}

$rows = Import-Csv -Path $captureLog
$targetRows = @($rows | Where-Object {
  $_.process_name -eq $sherpaPath -or $_.process_name -like "*sherpa-onnx-ws-win32-x64.exe"
})

$targetSamples = $targetRows.Count
$targetFirstMem = if ($targetRows.Count -gt 0) { Parse-Mib $targetRows[0].used_gpu_memory } else { 0 }
$targetLastMem = if ($targetRows.Count -gt 0) { Parse-Mib $targetRows[-1].used_gpu_memory } else { 0 }
$targetMaxMem = 0
foreach ($row in $targetRows) {
  $mib = Parse-Mib $row.used_gpu_memory
  if ($mib -gt $targetMaxMem) { $targetMaxMem = $mib }
}
$targetPids = ($targetRows | Select-Object -ExpandProperty pid -Unique) -join " "
if ([string]::IsNullOrWhiteSpace($targetPids)) {
  $targetPids = "none"
}

$summary = Get-ValidatorSummary -ValidatorJsonPath $validatorJson
$summaryLines = @(
  "mode=$Mode",
  "validator_exit=$validatorExit",
  "repo_dir=$repoDir",
  "bin_dir=$binDir",
  "target_sherpa_path=$sherpaPath",
  "capture_log=$captureLog",
  "validator_log=$validatorLog",
  "validator_json=$validatorJson",
  "target_samples=$targetSamples",
  "target_first_mem_mib=$targetFirstMem",
  "target_last_mem_mib=$targetLastMem",
  "target_max_mem_mib=$targetMaxMem",
  "target_pids=$targetPids",
  "validation_all_passed=$($summary.validation_all_passed)",
  "validation_expect_cuda_auto=$($summary.validation_expect_cuda_auto)",
  "auto_provider_attempted=$($summary.auto_provider_attempted)",
  "auto_provider_used=$($summary.auto_provider_used)",
  "auto_fallback_used=$($summary.auto_fallback_used)"
)

$summaryLines | Tee-Object -FilePath $summaryTxt

Write-Host ""
Write-Host "Top matching GPU rows for target process:"
if ($targetRows.Count -eq 0) {
  Write-Host "(none)"
} else {
  $targetRows | Select-Object -First 20 | ForEach-Object {
    Write-Host "$($_.timestamp),$($_.pid),$($_.process_name),$($_.used_gpu_memory)"
  }
}

exit $validatorExit
