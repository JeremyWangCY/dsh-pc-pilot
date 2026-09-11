import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const helperPath = path.join(rootDir, 'lib', 'pc-pilot-helper.ps1')
const helperSrc = fs.readFileSync(helperPath, 'utf8')

// ============================================================================
// 1. Schema Parity & Contract: new actions, hwnd parameter, chord support
// ============================================================================
const tool = defineComputerTool((def) => def)
const params = tool.parameters.properties

// All 3 new window-management actions must be registered in action enum
const newActions = ['activate_window', 'close_window', 'get_window']
for (const act of newActions) {
  assert.ok(
    params.action.enum.includes(act),
    `action enum must include '${act}', current: ${JSON.stringify(params.action.enum)}`
  )
}

// hwnd parameter must be exposed with type 'number'
assert.ok(params.hwnd, 'hwnd parameter must be present in parameters')
assert.equal(params.hwnd.type, 'number', 'hwnd parameter must be typed number')

// key description must mention chord syntax
assert.ok(
  params.key.description.includes('chord') || params.key.description.includes('ctrl+c'),
  'key description must document chord syntax'
)

// ============================================================================
// 2. Static Architectural Contracts (DWM Bounds, Fallbacks, Silent Launch)
// ============================================================================

// DwmGetWindowAttribute with DWMWA_EXTENDED_FRAME_BOUNDS = 9
assert.ok(
  helperSrc.includes('DwmGetWindowAttribute') && helperSrc.includes('DWMWA_EXTENDED_FRAME_BOUNDS = 9'),
  'helper must declare DwmGetWindowAttribute and DWMWA_EXTENDED_FRAME_BOUNDS = 9'
)
assert.ok(
  helperSrc.includes('GetDwmRect'),
  'helper must provide GetDwmRect'
)

// Tier 1 PrintWindow multi-mode fallback chain: flags 2 -> 0 -> 3
assert.ok(
  helperSrc.includes('$flag in @(2, 0, 3)'),
  'Do-AppState must test PrintWindow flags 2, 0, and 3 in sequence'
)

// Silent open_app: WindowStyle Minimized (direct at bottom, zero flicker/focus steal)
assert.ok(
  helperSrc.includes('WindowStyle $style') || helperSrc.includes('WindowStyle Minimized'),
  'open_app must launch with WindowStyle Minimized for clean, silent background execution'
)

// Fast process caching: Get-ProcessNameFast and Process.GetProcessById
assert.ok(
  helperSrc.includes('function Get-ProcessNameFast'),
  'helper must define Get-ProcessNameFast'
)
assert.ok(
  helperSrc.includes('[System.Diagnostics.Process]::GetProcessById'),
  'Get-ProcessNameFast must use .NET Process.GetProcessById for sub-millisecond lookup'
)

// Parse-KeyChord and aliases
assert.ok(
  helperSrc.includes('function Parse-KeyChord'),
  'helper must define Parse-KeyChord'
)
assert.ok(
  helperSrc.includes('control_l') && helperSrc.includes('alt_r') && helperSrc.includes('shift_l'),
  'helper must map left/right modifier aliases'
)

// ============================================================================
// 3. Dynamic Live Parity Tests on Owned Native Fixture (Strict Isolation)
// ============================================================================
// Strictly follows read-only contract for the user session:
// - Spawns our own owned fixture
// - Tests get_window, chords, activate_window, close_window
// - Immediately cleans up via taskkill
let fixturePid = 0
let fixtureHwnd = 0

try {
  // Test silent open_app
  const fixturePath = path.join(rootDir, 'test/fixtures/native-window.ps1')
  const openRes = await tool.execute({ action: 'launch_app', name: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${fixturePath}"` })
  assert.equal(openRes.ok, true, `open_app notepad should succeed: ${JSON.stringify(openRes)}`)
  fixturePid = openRes.pid
  assert.ok(Number.isInteger(fixturePid) && fixturePid > 0, 'open_app must return a valid pid')

  // Wait briefly for the window to be registered in window list
  let foundWin = null
  for (let i = 0; i < 20; i++) {
    const listRes = await tool.execute({ action: 'list_windows', app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}) })
    if (listRes.ok && Array.isArray(listRes.windows) && listRes.windows.length > 0) {
      foundWin = listRes.windows.find(w => w.title === 'PC-Pilot native test fixture')
      if (foundWin) break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(foundWin, 'owned fixture window must appear in list_windows')
  fixtureHwnd = foundWin.hwnd
  assert.ok(fixtureHwnd > 0, 'owned fixture must have a valid hwnd')
  // Background observation must never implicitly restore a minimized window.
  // Set up only this owned fixture explicitly before testing background input.
  const prepared = await tool.execute({ action: 'get_window_state', hwnd: fixtureHwnd, screenshot: false, dispatch: 'foreground' })
  assert.equal(prepared.ok, true, JSON.stringify(prepared))

  // 3a. get_window by app
  const gwAppRes = await tool.execute({ action: 'get_window', app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}) })
  assert.equal(gwAppRes.ok, true, `get_window by app must succeed: ${JSON.stringify(gwAppRes)}`)
  assert.equal(gwAppRes.hwnd, fixtureHwnd, 'get_window hwnd must match')
  assert.equal(gwAppRes.pid, fixturePid, 'get_window pid must match')
  assert.equal(gwAppRes.process_name.toLowerCase(), 'powershell', 'get_window must match the fixture process')
  assert.ok(gwAppRes.rect.width > 0 && gwAppRes.rect.height > 0, 'get_window rect must have positive dimensions')
  assert.equal(typeof gwAppRes.minimized, 'boolean', 'get_window minimized must be boolean')
  assert.ok(gwAppRes.window, 'get_window must include window info object')

  // 3b. get_window by hwnd
  const gwHwndRes = await tool.execute({ action: 'get_window', hwnd: fixtureHwnd })
  assert.equal(gwHwndRes.ok, true, `get_window by hwnd must succeed: ${JSON.stringify(gwHwndRes)}`)
  assert.equal(gwHwndRes.hwnd, fixtureHwnd, 'get_window by hwnd must return matching hwnd')
  assert.equal(gwHwndRes.pid, fixturePid, 'get_window by hwnd must return matching pid')

  // 3c. Background key chords with Sky/Mac syntax (never touches foreground)
  const chordKeyRes = await tool.execute({
    action: 'press_key',
    app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}),
    key: 'Control_L+a',
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordKeyRes.ok, true, `background chord key Control_L+a must succeed: ${JSON.stringify(chordKeyRes)}`)

  const chordCopyRes = await tool.execute({
    action: 'press_key',
    app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}),
    key: 'ctrl+c',
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordCopyRes.ok, true, `background chord key ctrl+c must succeed: ${JSON.stringify(chordCopyRes)}`)

  const chordHoldRes = await tool.execute({
    action: 'hold_key',
    app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}),
    key: 'ctrl+shift+p',
    duration_ms: 100,
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordHoldRes.ok, true, `background hold_key ctrl+shift+p must succeed: ${JSON.stringify(chordHoldRes)}`)

  // 3c-2. Click with element parameter (resolves element coordinates, not top-left)
  const clickState = await tool.execute({ action: 'get_window_state', app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}), screenshot: false })
  assert.equal(clickState.ok, true, `fresh state before element click must succeed: ${JSON.stringify(clickState)}`)
  const clickElement = clickState.elements.find(element => element.enabled && !element.offscreen && /^(最小化|Minimize)$/.test(element.name))
  assert.ok(clickElement, `fresh state must expose minimize: ${JSON.stringify(clickState.elements.map(e => ({ name:e.name, role:e.role, invokable:e.invokable, enabled:e.enabled, offscreen:e.offscreen })))}`)
  const clickElRes = await tool.execute({
    action: 'click',
    app: String(fixturePid), ...(fixtureHwnd ? { hwnd: fixtureHwnd } : {}),
    element: clickElement.index,
    snapshot_id: clickState.snapshot_id,
    expected_name: clickElement.name,
    dispatch: 'background',
    overlay: false,
  })
  if (clickElement.invokable) {
    assert.ok(clickElRes.ok || clickElRes.outcome === 'unknown', JSON.stringify(clickElRes))
  } else {
    assert.equal(clickElRes.error_code, 'background_unavailable', 'no UIA pattern must cause a refusal, not an unverified fallback')
    // Fixture setup only: minimize this exact owned window so the following
    // observation test does not depend on platform UIA proxy availability.
    const setup = `$ProgressPreference = 'SilentlyContinue'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FixtureSetup { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n); }'; [FixtureSetup]::ShowWindow([IntPtr]${fixtureHwnd}, 6) | Out-Null`
    execSync(`powershell -NoProfile -EncodedCommand ${Buffer.from(setup, 'utf16le').toString('base64')}`, { windowsHide: true, timeout: 5000 })
  }
  let minimized
  for (let attempt = 0; attempt < 20; attempt++) {
    minimized = await tool.execute({ action: 'get_window', hwnd: fixtureHwnd })
    if (minimized.minimized) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(minimized.minimized, true, `validated background click must actually minimize the fixture: ${JSON.stringify(clickElRes)}`)
  const afterMinimize = await tool.execute({ action: 'get_window_state', hwnd: fixtureHwnd, screenshot: false })
  assert.equal(afterMinimize.error_code, 'background_unavailable', 'background observation must not restore the minimized window')

  // 3d. activate_window on owned fixture
  const actRes = await tool.execute({ action: 'activate_window', hwnd: fixtureHwnd })
  assert.equal(actRes.ok, true, `activate_window should succeed: ${JSON.stringify(actRes)}`)
  assert.equal(actRes.hwnd, fixtureHwnd, 'activate_window hwnd must match')
  assert.equal(actRes.activated, true, 'activate_window activated must be true')

  // 3e. close_window on owned fixture
  const closeRes = await tool.execute({ action: 'close_window', hwnd: fixtureHwnd })
  assert.equal(closeRes.ok, true, `close_window should succeed: ${JSON.stringify(closeRes)}`)
  assert.equal(closeRes.hwnd, fixtureHwnd, 'close_window hwnd must match')
  assert.equal(closeRes.closed, true, 'close_window closed must be true')
} finally {
  // Strict cleanup: kill owned fixture immediately
  if (fixturePid > 0) {
    try { execSync(`taskkill /PID ${fixturePid} /F 2>nul || exit 0`, { timeout: 10000, windowsHide: true }) } catch { /* ignore */ }
  }
  stopDaemon()
}

console.log('codex-parity check PASSED')
