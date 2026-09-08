import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(__dirname, '..')

console.log('Running robust pip-overlay check...')

// 1. Verify pip-overlay.ps1 exists and has Apple design specifications
const pipPath = path.join(repoDir, 'lib', 'pip-overlay.ps1')
assert.ok(fs.existsSync(pipPath), 'pip-overlay.ps1 must exist in lib/')

const pipSrc = fs.readFileSync(pipPath, 'utf8')
assert.ok(pipSrc.includes('CornerRadius="16"'), 'Must have Apple 16px corner radius')
assert.ok(pipSrc.includes('Background="#E61C1C1E"'), 'Must use Apple dark frosted glass background')
assert.ok(pipSrc.includes('BtnClose') && pipSrc.includes('BtnMini') && pipSrc.includes('BtnExpand'), 'Must have 3 Apple traffic light buttons')
assert.ok(pipSrc.includes('#FF5F56') && pipSrc.includes('#FFBD2E') && pipSrc.includes('#27C93F'), 'Traffic lights must use genuine Apple hex colors')
assert.ok(pipSrc.includes('HorizontalAlignment="Right"'), 'Traffic light buttons must be placed at the top-right corner')
assert.ok(pipSrc.includes('WS_EX_NOACTIVATE'), 'Must apply WS_EX_NOACTIVATE to prevent focus theft')
assert.ok(pipSrc.includes('ShowActivated="False"'), 'Must specify ShowActivated="False" to prevent managed WPF focus theft')
assert.ok(pipSrc.includes('Focusable="False"'), 'Must specify Focusable="False"')
assert.ok(pipSrc.includes('[System.Windows.SystemParameters]::WorkArea'), 'Must use pure WPF SystemParameters for screen bounds')
assert.ok(!pipSrc.includes('System.Drawing'), 'Must not import unused System.Drawing')
assert.ok(pipSrc.includes('Live'), 'Must include Live status pill')
assert.ok(pipSrc.includes('CaptureRectWithCursor'), 'Must composite the AI virtual cursor into the canvas mirror')
assert.ok(pipSrc.includes('cursor.state'), 'Must read the AI virtual cursor state file')
assert.ok(pipSrc.includes('Polygon') && pipSrc.includes('Ellipse'), 'Cursor glyph must be drawn with pure GDI, not System.Drawing')
assert.ok(pipSrc.includes('GlyphClose') && pipSrc.includes('GlyphMini') && pipSrc.includes('GlyphExpand'), 'Traffic lights must expose macOS hover glyphs')
assert.ok(pipSrc.indexOf('BtnClose') < pipSrc.indexOf('BtnMini') && pipSrc.indexOf('BtnMini') < pipSrc.indexOf('BtnExpand'), 'Traffic light order must be macOS (close/minimize/zoom)')
assert.ok(pipSrc.includes('LiveDot') && pipSrc.includes('RepeatBehavior]::Forever'), 'Live dot must breathe (opacity pulse)')
assert.ok(pipSrc.includes('pip.pos'), 'PiP must remember its dragged position across respawns')
assert.ok(pipSrc.includes('pillFaded'), 'Action pill must fade out after the last action')
assert.ok(pipSrc.includes('pulseTick'), 'Cursor focus ring must pulse (radius varies per mirror tick)')

// 2. Verify computer-use-helper.ps1 and index.js
const helperPath = path.join(repoDir, 'lib', 'computer-use-helper.ps1')
const helperSrc = fs.readFileSync(helperPath, 'utf8')

assert.ok(helperSrc.includes('function Notify-Pip'), 'Helper must define Notify-Pip')
assert.ok(helperSrc.includes('function Ensure-PipOverlayProcess'), 'Helper must define Ensure-PipOverlayProcess')
assert.ok(helperSrc.includes("'toggle_pip'"), 'Helper must support toggle_pip action')
assert.ok(helperSrc.includes("'isolate_window'"), 'Helper must support isolate_window action')

const indexPath = path.join(repoDir, 'lib', 'index.js')
const indexSrc = fs.readFileSync(indexPath, 'utf8')
assert.ok(indexSrc.includes('PIP_SOURCE') && indexSrc.includes('PIP_TARGET'), 'index.js must copy pip-overlay.ps1 to temp directory')
assert.ok(indexSrc.includes("'toggle_pip'") && indexSrc.includes("'isolate_window'"), 'index.js must expose new actions in tool schema')

// 3. Live runtime verification of pip-overlay.ps1
const pwshCmd = `
$pip = '${pipPath.replace(/'/g, "''")}'
$proc = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File', $pip) -WindowStyle Hidden -PassThru

# Poll for window up to 3 seconds
. '${helperPath.replace(/'/g, "''")}'
$foundWin = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 100
  $wins = [DshWin32]::EnumWindowsList() | Where-Object { $_.Pid -eq $proc.Id }
  if ($wins -and $wins.Count -gt 0) {
    $foundWin = $wins[0]
    break
  }
}

if (-not $foundWin) {
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  throw "PiP window 'AI Workspace' was not created in PID $($proc.Id)!"
}

Write-Output ("HWND: " + $foundWin.Hwnd + " Title: " + $foundWin.Title + " Left: " + $foundWin.Rect.Left + " Top: " + $foundWin.Rect.Top)

# Assert positive on-screen coordinates
if ($foundWin.Rect.Left -lt 0 -or $foundWin.Rect.Top -lt 0) {
  Stop-Process -Id $proc.Id -Force
  throw ("Window created offscreen at (" + $foundWin.Rect.Left + ", " + $foundWin.Rect.Top + ")")
}

Stop-Process -Id $proc.Id -Force
Write-Output "PIP_RUNTIME_VERIFIED_SUCCESS"
`

const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', pwshCmd], {
  encoding: 'utf8',
  windowsHide: true,
})

if (res.stderr && res.stderr.trim()) {
  console.error('PowerShell stderr:', res.stderr)
}
console.log('PowerShell stdout:', res.stdout)
assert.equal(res.status, 0, 'PowerShell test script must exit 0')
assert.ok(res.stdout.includes('PIP_RUNTIME_VERIFIED_SUCCESS'), 'PiP window must be visible on-screen with positive coordinates and non-activating style')

console.log('pip-overlay check PASSED')
