# PC-Pilot smoke test (read-only). Prefer pwsh 7; PS 5.1 works because this file is ASCII-only.
# Usage: pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/smoke-test.ps1
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$helper = Join-Path $here "..\lib\pc-pilot-helper.ps1"
$ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"

function Get-HelperJson($lines, [string]$step) {
  $candidates = @()
  foreach ($item in $lines) {
    $s = if ($item -is [System.Management.Automation.ErrorRecord]) { $item.ToString() } else { [string]$item }
    if ($s -match '^\s*\{') { $candidates += $s }
  }
  $joined = $candidates -join "`n"
  $m = [regex]::Match($joined, '\{.*\}', 'Singleline')
  if (-not $m.Success) { throw "${step}: no JSON in helper output: $joined" }
  return $m.Value | ConvertFrom-Json
}

$oldEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

Write-Host "== list_apps =="
# Payloads go through stdin: PS 5.1 strips embedded double quotes when passing
# native arguments, so -PayloadJson mangles any JSON that contains strings.
$out1 = '{}' | & $ps -NoProfile -ExecutionPolicy Bypass -File $helper -Action list_apps -PayloadStdin 2>$null
$r1 = Get-HelperJson $out1 'list_apps'
if ($r1.ok -ne $true) { throw "list_apps failed: $($r1.message)" }
Write-Host ("OK: found {0} apps" -f @($r1.apps).Count)

Write-Host "== get_app_state (largest titled window, no screenshot) =="
$windows = @()
foreach ($app in @($r1.apps)) {
  foreach ($w in @($app.windows)) {
    if ($w.title -and $w.title.Trim().Length -gt 0 -and -not $w.minimized) {
      $area = [Math]::Max(0, $w.rect.width) * [Math]::Max(0, $w.rect.height)
      $windows += [PSCustomObject]@{ app = $app.name; hwnd = $w.hwnd; area = $area; title = $w.title }
    }
  }
}
if ($windows.Count -eq 0) { throw "no titled windows available for smoke state" }
$pick = $windows | Sort-Object area -Descending | Select-Object -First 1
$payload = @{ app = $pick.app; hwnd = $pick.hwnd; screenshot = $false } | ConvertTo-Json -Compress
$out2 = $payload | & $ps -NoProfile -ExecutionPolicy Bypass -File $helper -Action get_app_state -PayloadStdin 2>$null
$r2 = Get-HelperJson $out2 'get_app_state'
if ($r2.ok -ne $true) { throw "get_app_state failed: $($r2.message)" }
Write-Host ("OK: {0} elements on '{1}'" -f $r2.element_count, $pick.title)

$ErrorActionPreference = $oldEAP
Write-Host "smoke test passed."
