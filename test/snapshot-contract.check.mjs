import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const helper = fileURLToPath(new URL('../lib/pc-pilot-helper.ps1', import.meta.url)).replaceAll("'", "''")
// Execute the real helper functions against a deterministic provider double.
// No desktop input or process-wide UIA initialization is performed here.
const ps = `
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile('${helper}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw $errors[0] }
$ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst]},$false) | ForEach-Object { . ([scriptblock]::Create($_.Extent.Text)) }
Add-Type @'
using System;
public class FixtureRect { public int Left=0, Top=0, Right=100, Bottom=100; }
public static class DshWin32 {
 public static FixtureRect Rect = new FixtureRect();
 public static FixtureRect GetDwmRect(IntPtr h) { return Rect; }
 public static IntPtr GetForegroundWindow() { return IntPtr.Zero; }
}
'@
$el=[pscustomobject]@{Current=[pscustomobject]@{ProcessId=77;Name='Submit';AutomationId='submit';ControlType=[pscustomobject]@{Id=50000};IsEnabled=$true;IsOffscreen=$false;BoundingRectangle=[pscustomobject]@{X=5;Y=5;Width=20;Height=20}}}
$el | Add-Member ScriptMethod GetRuntimeId { return @(7,9) }
function Seed {
 $script:payload=[pscustomobject]@{snapshot_id='fresh'}
 $script:observation=@{id='fresh';hwnd=[IntPtr]42;created=[DateTime]::UtcNow;rect=(New-Object FixtureRect)}
 $script:cachedTreeHwnd=[IntPtr]42
 $script:cachedElements=@($el)
 $script:cachedIdentities=@((Get-ElementIdentity $el))
}
function Reject([scriptblock]$call,[string]$prefix) {
 $caught=$false
 try { & $call | Out-Null } catch { if ($_.Exception.Message -notlike ($prefix+':*')) { throw }; $caught=$true }
 if (-not $caught) { throw "Expected $prefix rejection" }
}
Seed
if ((Find-ElementByIndex -Hwnd 42 -Index 1) -ne $el) { throw 'fresh identity should resolve' }
$script:payload=[pscustomobject]@{}
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } snapshot_required
Seed; $script:payload.snapshot_id='old'
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } stale_snapshot
Seed
Reject { Find-ElementByIndex -Hwnd 43 -Index 1 } stale_snapshot
Seed; $script:observation.created=[DateTime]::UtcNow.AddMinutes(-2)
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } stale_snapshot
Seed; $el.Current.Name='Different button'
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } stale_snapshot
Seed; $el.Current.BoundingRectangle.X=50
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } stale_snapshot
Seed; [DshWin32]::Rect.Left=20
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } stale_snapshot
[DshWin32]::Rect.Left=0
Seed; $script:cachedElements=$null
Reject { Find-ElementByIndex -Hwnd 42 -Index 1 } element_not_found
Seed
$r=Invoke-ActionRequest -Action unsupported_fixture_action -Payload $script:payload
if ($r.ok -or $script:observation -or $script:cachedElements) { throw 'failed mutation must consume observation' }
Seed
$r=Invoke-ActionRequest -Action type_text -Payload ([pscustomobject]@{text='must not reach foreground'})
if ($r.ok -or $r.error_code -ne 'target_required') { throw 'background type_text must reject absent target' }
Write-Output 'PASS: snapshot identity, window binding, expiry, movement, no index remap, consumption and background target'
`
const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
assert.match(output, /PASS:/)
console.log(output.trim())
