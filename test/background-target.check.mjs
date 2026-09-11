import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const helper = fileURLToPath(new URL('../lib/pc-pilot-helper.ps1', import.meta.url))
// Load real function ASTs only: no daemon, desktop initialization or user input.
const ps = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition 'public static class DshWin32 { public static System.IntPtr GetForegroundWindow() { return System.IntPtr.Zero; } public static bool IsChild(System.IntPtr a, System.IntPtr b) { return false; } }'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${helper.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors[0] }
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
$win=@{Rect=@{Left=-1000;Top=-500;Right=0;Bottom=500}}
$p=Resolve-ClickPoint -RawX -950 -RawY 0 -Win $win -Space screen
if ($p[0] -ne -950 -or $p[1] -ne 0) { throw 'negative/zero screen point changed' }
$p=Resolve-ClickPoint -RawX 0 -RawY 0 -Win $win -Space window
if ($p[0] -ne -1000 -or $p[1] -ne -500) { throw 'window origin changed' }
foreach ($v in @(@($null,0),@(0,$null),@($null,$null),@('',0),@('NaN',0),@('Infinity',0),@($true,0),@(2147483648,0))) {
 $failed=$false; try { Resolve-ClickPoint -RawX $v[0] -RawY $v[1] -Win $win -Space screen } catch { $failed=$true }
 if (-not $failed) { throw 'invalid coordinates accepted' }
}
Write-Output 'coordinate contracts passed'
$p=Resolve-ClickPoint -RawX 0 -RawY 0 -Space screen
if ($p[0] -ne 0 -or $p[1] -ne 0) { throw 'global zero point changed' }
$p=Resolve-ClickPoint -RawX 20 -RawY 30 -Win $win
if ($p[0] -ne -980 -or $p[1] -ne -470) { throw 'default app coordinates must be window-relative' }
$failed=$false; try { Resolve-ClickPoint -RawX -950 -RawY 0 -Win $win } catch { $failed=$true }
if (-not $failed) { throw 'app coordinates must never infer screen space from point position' }
foreach ($space in @('bad','window')) {
 $failed=$false; try { Resolve-ClickPoint -RawX 0 -RawY 0 -Space $space } catch { $failed=$true }
 if (-not $failed) { throw 'invalid coordinate space accepted' }
}
$script:win=@{Hwnd=[IntPtr]123;Rect=@{Left=-1000;Top=-500;Right=0;Bottom=500}}
function Resolve-TargetWindow { return $script:win }
function Notify-Cursor { }
function Test-ElementInWindow { return $script:owned }
function Find-TargetHitsAt { $script:scans++; if ($script:scanFails) { throw 'target_validation_failed: provider scan failed' }; return @{best=$script:el;bestPattern=$script:el} }
function Find-ElementByIndex { if ($script:stale) { throw 'stale_snapshot: refresh get_app_state' }; return $script:el }
function Send-BackgroundMouseButton { $script:messages++ }
function Invoke-FromPoint { $script:globalHits++; throw 'unexpected global hit' }
function Find-BackgroundHwndAt { $script:globalHits++; throw 'unexpected global lookup' }
function Reset-Fixture {
 $script:owned=$true; $script:stale=$false; $script:scanFails=$false; $script:scans=0; $script:messages=0; $script:invokes=0; $script:globalHits=0
 $script:mode='invoke'
 $script:pattern=New-Object PSObject
 $script:pattern | Add-Member ScriptMethod Invoke { $script:invokes++; if ($script:mode -eq 'throws') { throw 'provider failed after invoking' } }
 $script:el=[pscustomobject]@{Current=[pscustomobject]@{Name='Safe button';IsEnabled=$true;NativeWindowHandle=123;BoundingRectangle=[pscustomobject]@{X=-980;Y=-20;Width=50;Height=50;IsEmpty=$false}}}
 $script:el | Add-Member ScriptMethod TryGetCurrentPattern {
  param($id,$out)
  if ($script:mode -eq 'none') { return $false }
  if ($script:mode -eq 'moves') { $this.Current.BoundingRectangle.X=-500 }
  $out.Value=$script:pattern; return $true
 }
}
function Request($extra) {
 $p=@{app='fixture';x=-950;y=0;coordinate_space='screen';dispatch='background';expected_name='Safe button'}
 foreach ($key in $extra.Keys) { $p[$key]=$extra[$key] }
 return Invoke-ActionRequest -Action click -Payload ([pscustomobject]$p)
}
function Must-Reject($extra) {
 $r=Request $extra
 if ($r.ok -or $script:invokes -ne 0 -or $script:messages -ne 0 -or $script:globalHits -ne 0) { throw "unsafe rejection stack=$((Get-PSCallStack | Select-Object -ExpandProperty ScriptLineNumber) -join ',') extra=$($extra | ConvertTo-Json -Compress) mode=$script:mode owned=$script:owned : $($r | ConvertTo-Json -Compress)" }
 return $r
}
Reset-Fixture
$r=Request @{}
if (-not $r.ok -or $script:invokes -ne 1 -or $script:messages -ne 0 -or $r.clicked.x -ne -950 -or $r.clicked.y -ne 0) { throw 'validated click must invoke exactly once at requested point' }
foreach ($extra in @(@{expected_name=$null},@{expected_name=''},@{expected_name='Wrong'},@{expected_name='safe button'},@{x=$null},@{y=$null},@{x='NaN'},@{x=0},@{coordinate_space='bad'})) {
 Reset-Fixture; $null=Must-Reject $extra
}
Reset-Fixture; $r=Must-Reject @{expected_name=$null}
if ($script:scans -ne 0 -or $r.message -notmatch 'get_window_state.*element_index') { throw 'missing expectation must fail before scanning with recovery guidance' }
foreach ($caseMode in @('none','moves')) { Reset-Fixture; $script:mode=$caseMode; $null=Must-Reject @{} }
Reset-Fixture; $script:owned=$false; $null=Must-Reject @{}
Reset-Fixture; $script:el.Current.IsEnabled=$false; $null=Must-Reject @{}
Reset-Fixture; $script:el.Current.BoundingRectangle.Width=[double]::NaN; $null=Must-Reject @{}
Reset-Fixture; $script:stale=$true; $r=Must-Reject @{element=2}
if ($r.message -notmatch 'stale_snapshot' -or $script:scans -ne 0) { throw 'stale snapshot must propagate without coordinate rescan' }
Reset-Fixture; $script:scanFails=$true; $null=Must-Reject @{}
Reset-Fixture; $script:el=$null; $null=Must-Reject @{}
Reset-Fixture; $script:mode='throws'; $r=Request @{}
if ($r.ok -or $script:invokes -ne 1 -or $script:messages -ne 0 -or $script:globalHits -ne 0) { throw 'failed Invoke must never retry or fall back' }
foreach ($extra in @(@{button='right'},@{button='middle'},@{click_count=2})) {
 Reset-Fixture; $r=Request $extra
 if (-not $r.ok -or $script:messages -ne 1 -or $script:invokes -ne 0) { throw 'validated message click failed' }
 Reset-Fixture; $extra.expected_name='Wrong'; $null=Must-Reject $extra
 Reset-Fixture; $extra.expected_name=$null; $null=Must-Reject $extra
}
Reset-Fixture; $r=Request @{element=1;expected_name=$null}
if (-not $r.ok -or $script:invokes -ne 1 -or $script:scans -ne 0) { throw 'element click must use resolved element, not rescan coordinates' }
Write-Output 'background action contracts passed (mock providers; no desktop input)'
`
const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{encoding:'utf8',timeout:20000,windowsHide:true})
assert.equal(r.status,0,`${r.stdout}\n${r.stderr}\n${r.error ?? ''}`)
console.log(r.stdout.trim())

