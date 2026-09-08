import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const helperPath = path.join(rootDir, 'lib', 'computer-use-helper.ps1')
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
// 3. Dynamic Live Parity Tests on Scratch Notepad (Strict Isolation)
// ============================================================================
// Strictly follows read-only contract for the user session:
// - Spawns our own scratch notepad
// - Tests get_window, chords, activate_window, close_window
// - Immediately cleans up via taskkill
let notepadPid = 0
let notepadHwnd = 0

try {
  // Test silent open_app
  const openRes = await tool.execute({ action: 'open_app', name: 'notepad' })
  assert.equal(openRes.ok, true, `open_app notepad should succeed: ${JSON.stringify(openRes)}`)
  notepadPid = openRes.pid
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'open_app must return a valid pid')

  // Wait briefly for the window to be registered in window list
  let foundWin = null
  for (let i = 0; i < 20; i++) {
    const listRes = await tool.execute({ action: 'list_windows', app: String(notepadPid) })
    if (listRes.ok && Array.isArray(listRes.windows) && listRes.windows.length > 0) {
      foundWin = listRes.windows[0]
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(foundWin, 'scratch notepad window must appear in list_windows')
  notepadHwnd = foundWin.hwnd
  assert.ok(notepadHwnd > 0, 'scratch notepad must have a valid hwnd')

  // 3a. get_window by app
  const gwAppRes = await tool.execute({ action: 'get_window', app: String(notepadPid) })
  assert.equal(gwAppRes.ok, true, `get_window by app must succeed: ${JSON.stringify(gwAppRes)}`)
  assert.equal(gwAppRes.hwnd, notepadHwnd, 'get_window hwnd must match')
  assert.equal(gwAppRes.pid, notepadPid, 'get_window pid must match')
  assert.equal(gwAppRes.process_name.toLowerCase(), 'notepad', 'get_window process_name must be notepad')
  assert.ok(gwAppRes.rect.width > 0 && gwAppRes.rect.height > 0, 'get_window rect must have positive dimensions')
  assert.equal(typeof gwAppRes.minimized, 'boolean', 'get_window minimized must be boolean')
  assert.ok(gwAppRes.window, 'get_window must include window info object')

  // 3b. get_window by hwnd
  const gwHwndRes = await tool.execute({ action: 'get_window', hwnd: notepadHwnd })
  assert.equal(gwHwndRes.ok, true, `get_window by hwnd must succeed: ${JSON.stringify(gwHwndRes)}`)
  assert.equal(gwHwndRes.hwnd, notepadHwnd, 'get_window by hwnd must return matching hwnd')
  assert.equal(gwHwndRes.pid, notepadPid, 'get_window by hwnd must return matching pid')

  // 3c. Background key chords with Sky/Mac syntax (never touches foreground)
  const chordKeyRes = await tool.execute({
    action: 'key',
    app: String(notepadPid),
    key: 'Control_L+a',
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordKeyRes.ok, true, `background chord key Control_L+a must succeed: ${JSON.stringify(chordKeyRes)}`)

  const chordCopyRes = await tool.execute({
    action: 'key',
    app: String(notepadPid),
    key: 'ctrl+c',
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordCopyRes.ok, true, `background chord key ctrl+c must succeed: ${JSON.stringify(chordCopyRes)}`)

  const chordHoldRes = await tool.execute({
    action: 'hold_key',
    app: String(notepadPid),
    key: 'ctrl+shift+p',
    duration_ms: 100,
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(chordHoldRes.ok, true, `background hold_key ctrl+shift+p must succeed: ${JSON.stringify(chordHoldRes)}`)

  // 3c-2. Click with element parameter (resolves element coordinates, not top-left)
  const clickElRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    element: 1,
    dispatch: 'background',
    overlay: false,
  })
  assert.equal(clickElRes.ok, true, `click with element must succeed: ${JSON.stringify(clickElRes)}`)

  // 3d. activate_window on scratch notepad
  const actRes = await tool.execute({ action: 'activate_window', hwnd: notepadHwnd })
  assert.equal(actRes.ok, true, `activate_window should succeed: ${JSON.stringify(actRes)}`)
  assert.equal(actRes.hwnd, notepadHwnd, 'activate_window hwnd must match')
  assert.equal(actRes.activated, true, 'activate_window activated must be true')

  // 3e. close_window on scratch notepad
  const closeRes = await tool.execute({ action: 'close_window', hwnd: notepadHwnd })
  assert.equal(closeRes.ok, true, `close_window should succeed: ${JSON.stringify(closeRes)}`)
  assert.equal(closeRes.hwnd, notepadHwnd, 'close_window hwnd must match')
  assert.equal(closeRes.closed, true, 'close_window closed must be true')
} finally {
  // Strict cleanup: kill scratch notepad immediately
  if (notepadPid > 0) {
    try { execSync(`taskkill /PID ${notepadPid} /F 2>nul || exit 0`, { timeout: 10000, windowsHide: true }) } catch { /* ignore */ }
  }
  stopDaemon()
}

console.log('codex-parity check PASSED')
