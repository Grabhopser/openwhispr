#!/usr/bin/env pwsh
param(
  [string]$Endpoint = "http://127.0.0.1:8000/v1",
  [string]$Model = "",
  [int]$Runs = 3,
  [string]$OutDir = "$HOME/AgentsWorkplace",
  [string]$ApiKey = "",
  [double]$IntervalSec = 0.2
)

$ErrorActionPreference = "Stop"

function Parse-Mib([string]$value) {
  if ($null -eq $value) { return 0 }
  if ($value -match "([0-9]+)") { return [int]$matches[1] }
  return 0
}

if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
  throw "nvidia-smi not found. Cannot capture GPU evidence."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found. Benchmark runner requires Node.js."
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoDir = (Resolve-Path (Join-Path $scriptDir "..")).Path

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$captureLog = Join-Path $OutDir "cleanup_gpu_capture_${stamp}.csv"
$benchLog = Join-Path $OutDir "cleanup_benchmark_${stamp}.log"
$benchJson = Join-Path $OutDir "cleanup_benchmark_${stamp}.json"
$summaryTxt = Join-Path $OutDir "cleanup_gpu_evidence_${stamp}.txt"

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

$benchArgs = @(
  (Join-Path $repoDir "scripts/benchmark-cleanup-model.js"),
  "--endpoint", $Endpoint,
  "--runs", "$Runs",
  "--out", $benchJson
)

if ($Model) {
  $benchArgs += @("--model", $Model)
}
if ($ApiKey) {
  $benchArgs += @("--api-key", $ApiKey)
}

$benchExit = 0
try {
  & node $benchArgs 2>&1 | Tee-Object -FilePath $benchLog
  $benchExit = $LASTEXITCODE
} finally {
  Start-Sleep -Milliseconds 500
  Stop-Job -Job $captureJob -Force -ErrorAction SilentlyContinue | Out-Null
  Receive-Job -Job $captureJob -ErrorAction SilentlyContinue | Out-Null
  Remove-Job -Job $captureJob -Force -ErrorAction SilentlyContinue
}

$rows = Import-Csv -Path $captureLog
$groups = @{}

foreach ($row in $rows) {
  $name = [string]$row.process_name
  if ([string]::IsNullOrWhiteSpace($name)) { continue }
  if (-not $groups.ContainsKey($name)) {
    $groups[$name] = [PSCustomObject]@{
      processName = $name
      samples = 0
      maxMem = 0
      pids = New-Object System.Collections.Generic.HashSet[string]
    }
  }
  $entry = $groups[$name]
  $entry.samples += 1
  $mem = Parse-Mib([string]$row.used_gpu_memory)
  if ($mem -gt $entry.maxMem) { $entry.maxMem = $mem }
  $pid = [string]$row.pid
  if (-not [string]::IsNullOrWhiteSpace($pid)) {
    $null = $entry.pids.Add($pid)
  }
}

$top = $groups.Values |
  Sort-Object -Property @{Expression="maxMem";Descending=$true}, @{Expression="samples";Descending=$true} |
  Select-Object -First 10

$bench = $null
try {
  $bench = Get-Content -Path $benchJson -Raw | ConvertFrom-Json
} catch {
  $bench = $null
}

$summaryLines = @(
  "endpoint=$Endpoint",
  "runs=$Runs",
  "capture_log=$captureLog",
  "benchmark_json=$benchJson",
  "gpu_samples_total=$($rows.Count)",
  "gpu_processes_observed=$($top.Count)"
)

if ($bench -and $bench.summary) {
  $summaryLines += @(
    "benchmark_model=$($bench.summary.model)",
    "benchmark_total_calls=$($bench.summary.totalCalls)",
    "benchmark_successful_calls=$($bench.summary.successfulCalls)",
    "benchmark_mean_latency_ms=$([double]$bench.summary.latency.meanMs)",
    "benchmark_quality_score=$([double]$bench.summary.quality.meanQualityScore)"
  )
}

$summaryLines += "top_gpu_processes="
foreach ($item in $top) {
  $pids = ($item.pids | Sort-Object) -join "|"
  if ([string]::IsNullOrWhiteSpace($pids)) { $pids = "none" }
  $summaryLines += "  - name=$($item.processName); samples=$($item.samples); max_mem_mib=$($item.maxMem); pids=$pids"
}

$summaryLines | Tee-Object -FilePath $summaryTxt

Write-Host ""
Write-Host "Benchmark log: $benchLog"
Write-Host "Evidence summary: $summaryTxt"

exit $benchExit
