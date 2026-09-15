import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 1. Schema assertions: canonical Windows Computer Use plus PC-Pilot extensions.
const tool = defineComputerTool((def) => def)
assert.equal(tool.name, 'computer')
const params = tool.parameters.properties

const expectedActions = [
  // Windows Computer Use desktop actions
  'list_apps', 'list_windows', 'get_window', 'launch_app', 'get_window_state',
  'click', 'press_key', 'type_text', 'scroll', 'drag', 'set_value', 'perform_secondary_action', 'activate_window',
  // PC-Pilot extensions
  'read_clipboard', 'write_clipboard', 'mouse_down', 'mouse_up', 'hold_key', 'list_displays',
  'select_text', 'screenshot', 'zoom', 'switch_display', 'cursor_position', 'wait', 'close_window',
]

assert.ok(
  params.action.enum.length >= 25,
  `action enum must have at least 25 entries, got ${params.action.enum.length}: ${JSON.stringify(params.action.enum)}`
)
for (const act of expectedActions) {
  assert.ok(
    params.action.enum.includes(act),
    `action enum must include '${act}', current enum: ${JSON.stringify(params.action.enum)}`
  )
}

// new parameters with correct types
const expectedParams = [
  ['click_count', 'number'],
  ['start', 'number'],
  ['length', 'number'],
  ['perform', 'string'],
  ['display', 'number'],
  ['width', 'number'],
  ['height', 'number'],
  ['duration_s', 'number'],
]
for (const [name, type] of expectedParams) {
  assert.ok(params[name], `${name} parameter must be present`)
  assert.equal(params[name].type, type, `${name} must be typed '${type}'`)
}
assert.ok(params.path.oneOf, 'path must accept both the canonical drag path and zoom screenshot path')

// direction now covers horizontal scrolling
assert.deepEqual(params.direction.enum, ['down', 'up', 'left', 'right'])

// 2. Live round-trips (read-only / no side effects on the user's session)

// list_apps: canonical app identifiers must be directly reusable and each
// returned window must retain the standard Window { id, app } shape.
const listAppsRes = await tool.execute({ action: 'list_apps' })
assert.equal(listAppsRes.ok, true, `list_apps should succeed: ${JSON.stringify(listAppsRes)}`)
assert.ok(Array.isArray(listAppsRes.apps), 'list_apps must return an apps array')
for (const app of listAppsRes.apps) {
  assert.equal(typeof app.id, 'string', 'a running app must expose a reusable string id')
  assert.equal(typeof app.displayName, 'string', 'a running app must expose displayName')
  assert.equal(app.isRunning, true, 'list_apps only reports running applications')
  assert.ok(Array.isArray(app.windows), 'a running app must expose a windows array')
  for (const window of app.windows) {
    assert.equal(typeof window.id, 'number', 'a returned window must expose its opaque id')
    assert.equal(typeof window.app, 'string', 'a returned window must expose its owning app')
  }
}

// cursor_position: numeric position + 1-based display
const cursorRes = await tool.execute({ action: 'cursor_position' })
assert.ok(cursorRes, 'cursor_position must return a result object')
assert.equal(cursorRes.ok, true, `cursor_position should succeed: ${JSON.stringify(cursorRes)}`)
assert.equal(cursorRes.action, 'cursor_position')
assert.ok(typeof cursorRes.position?.x === 'number' && typeof cursorRes.position?.y === 'number',
  `position.x/y must be numbers: ${JSON.stringify(cursorRes.position)}`)
assert.ok(cursorRes.display >= 1, `display must be >= 1, got ${cursorRes.display}`)

// list_windows: windows array
const listWinRes = await tool.execute({ action: 'list_windows' })
assert.ok(listWinRes, 'list_windows must return a result object')
assert.equal(listWinRes.ok, true, `list_windows should succeed: ${JSON.stringify(listWinRes)}`)
assert.equal(listWinRes.action, 'list_windows')
assert.ok(Array.isArray(listWinRes.windows), 'windows must be an array')
assert.equal(listWinRes.window_count, listWinRes.windows.length,
  'window_count must match the returned windows array')
assert.ok(listWinRes.windows.every((window) => window.app_identity === undefined),
  'list_windows discovery entries must use the compact Window shape')

// wait: fractional duration (default 1s when omitted, 0.3 here)
const waitRes = await tool.execute({ action: 'wait', duration_s: 0.3 })
assert.ok(waitRes, 'wait must return a result object')
assert.equal(waitRes.ok, true, `wait should succeed: ${JSON.stringify(waitRes)}`)
assert.equal(waitRes.action, 'wait')

// screenshot: full-screen capture saved to %TEMP%\dsh-cua\disp-*.png
const shotRes = await tool.execute({ action: 'screenshot' })
assert.ok(shotRes, 'screenshot must return a result object')
assert.equal(shotRes.ok, true, `screenshot should succeed: ${JSON.stringify(shotRes)}`)
assert.equal(shotRes.action, 'screenshot')
assert.ok(typeof shotRes.path === 'string' && shotRes.path.length > 0, `screenshot must return a path: ${JSON.stringify(shotRes)}`)
assert.ok(fs.existsSync(shotRes.path), `screenshot file must exist on disk: ${shotRes.path}`)
assert.ok(shotRes.width > 0 && shotRes.height > 0, `screenshot width/height must be positive: ${shotRes.width}x${shotRes.height}`)

// zoom: 10x10 crop of the screenshot we just took
const zoomRes = await tool.execute({ action: 'zoom', path: shotRes.path, x: 0, y: 0, width: 10, height: 10 })
assert.ok(zoomRes, 'zoom must return a result object')
assert.equal(zoomRes.ok, true, `zoom should succeed: ${JSON.stringify(zoomRes)}`)
assert.equal(zoomRes.action, 'zoom')
assert.ok(typeof zoomRes.path === 'string' && zoomRes.path.length > 0, `zoom must return a path: ${JSON.stringify(zoomRes)}`)
assert.ok(fs.existsSync(zoomRes.path), `zoom output file must exist on disk: ${zoomRes.path}`)
assert.equal(zoomRes.source_path, shotRes.path, 'zoom source_path must echo the requested source')

// switch_display: display 1 is always valid
const switchRes = await tool.execute({ action: 'switch_display', display: 1 })
assert.ok(switchRes, 'switch_display must return a result object')
assert.equal(switchRes.ok, true, `switch_display should succeed: ${JSON.stringify(switchRes)}`)
assert.equal(switchRes.action, 'switch_display')
assert.equal(switchRes.display, 1)

// zoom without a crop size must fail loudly, not silently produce a 1x1 crop
const zoomNoSizeRes = await tool.execute({ action: 'zoom', path: shotRes.path, x: 0, y: 0 })
assert.equal(zoomNoSizeRes.ok, false, `zoom without width/height must fail: ${JSON.stringify(zoomNoSizeRes)}`)
assert.ok(
  /width and height are required/.test(zoomNoSizeRes.message || ''),
  `zoom failure must name the missing crop size: ${JSON.stringify(zoomNoSizeRes.message)}`
)

// get_window_state smoke must use an owned fixture.  The test runner must not
// capture or inspect a user's existing application merely to find a convenient
// window with a non-empty accessibility tree.
let stateRes = null
let fixturePid = 0
try {
  const fixturePath = path.join(__dirname, 'fixtures', 'native-window.ps1')
  const launched = await tool.execute({ action: 'launch_app', name: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${fixturePath}"` })
  fixturePid = Number.isSafeInteger(launched.pid) ? launched.pid : 0
  for (let attempt = 0; attempt < 20; attempt++) {
    const windows = await tool.execute({ action: 'list_windows', app: String(fixturePid) })
    const fixture = windows.windows?.find((window) => window.title === 'PC-Pilot native test fixture')
    if (fixture) {
      const candidate = await tool.execute({ action: 'get_window_state', app: String(fixturePid), hwnd: fixture.hwnd, screenshot: true, include_text: true, dispatch: 'foreground' })
      if (candidate.ok && candidate.elements?.length > 0 && candidate.screenshot?.path) {
        stateRes = candidate
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
} finally {
  if (fixturePid > 0) {
    try { execFileSync('taskkill', ['/PID', String(fixturePid), '/T', '/F'], { windowsHide: true, timeout: 10000, stdio: 'ignore' }) } catch { /* fixture already exited */ }
  }
}
assert.ok(stateRes, 'get_window_state must yield a non-empty element tree with a captured screenshot for the owned native fixture')
assert.ok(stateRes.screenshot, 'get_window_state must return a screenshot object')
assert.ok(typeof stateRes.screenshot.path === 'string' && stateRes.screenshot.path.length > 0,
  `screenshot must have a path: ${JSON.stringify(stateRes.screenshot)}`)
assert.ok(fs.existsSync(stateRes.screenshot.path), `screenshot file must exist: ${stateRes.screenshot.path}`)
assert.ok(
  !stateRes.screenshot.method || ['windows_graphics_capture', 'print_window'].includes(stateRes.screenshot.method),
  `screenshot method must be windows_graphics_capture or print_window, got ${stateRes.screenshot.method}`
)

// The capture outputs exist only to verify this test.  Delete the exact paths
// returned by the helper so regression runs do not retain desktop snapshots.
for (const capturePath of new Set([shotRes.path, zoomRes.path, stateRes.screenshot.path])) {
  try { fs.unlinkSync(capturePath) } catch { /* already removed by the helper */ }
}

// Clean up daemon before exit.
stopDaemon()

console.log('parity check PASSED')
