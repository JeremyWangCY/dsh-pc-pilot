import assert from 'node:assert/strict'
import fs from 'node:fs'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

// 1. Schema assertions: all 25 actions (16 legacy + 9 parity additions)
const tool = defineComputerTool((def) => def)
assert.equal(tool.name, 'computer')
const params = tool.parameters.properties

const expectedActions = [
  // 16 legacy actions
  'list_apps', 'get_app_state', 'click_element', 'click', 'type', 'key',
  'scroll', 'drag', 'set_value', 'open_app',
  'read_clipboard', 'write_clipboard', 'mouse_down', 'mouse_up', 'hold_key', 'list_displays',
  // 9 parity actions (ZCode computer-use capability surface)
  'mouse_move', 'perform_action', 'select_text', 'screenshot', 'zoom',
  'switch_display', 'cursor_position', 'list_windows', 'wait',
]

assert.equal(
  params.action.enum.length, 25,
  `action enum must have exactly 25 entries, got ${params.action.enum.length}: ${JSON.stringify(params.action.enum)}`
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
  ['path', 'string'],
]
for (const [name, type] of expectedParams) {
  assert.ok(params[name], `${name} parameter must be present`)
  assert.equal(params[name].type, type, `${name} must be typed '${type}'`)
}

// direction now covers horizontal scrolling
assert.deepEqual(params.direction.enum, ['down', 'up', 'left', 'right'])

// 2. Live round-trips (read-only / no side effects on the user's session)

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

// mouse_move in background with overlay off: synthetic only, never moves the real mouse
const moveRes = await tool.execute({ action: 'mouse_move', x: 10, y: 10, overlay: false })
assert.ok(moveRes, 'mouse_move must return a result object')
assert.equal(moveRes.ok, true, `mouse_move should succeed: ${JSON.stringify(moveRes)}`)
assert.equal(moveRes.action, 'mouse_move')
assert.ok(moveRes.position, 'mouse_move must return position')

// get_app_state smoke on a real window: the screenshot tier chain must produce a
// usable PNG (tier1 print_window implicit / tier2 bitblt_screen fallback).
// Tool/tray windows can expose empty UIA trees, so try candidates largest-first.
const stateCandidates = [...listWinRes.windows]
  .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))
  .slice(0, 4)
let stateRes = null
for (const cand of stateCandidates) {
  const res = await tool.execute({ action: 'get_app_state', app: String(cand.pid), screenshot: true })
  if (res.ok && Array.isArray(res.elements) && res.elements.length > 0) { stateRes = res; break }
}
assert.ok(stateRes, `get_app_state must yield a non-empty element tree for one of ${stateCandidates.length} candidate windows`)
assert.ok(stateRes.screenshot, 'get_app_state must return a screenshot object')
assert.ok(typeof stateRes.screenshot.path === 'string' && stateRes.screenshot.path.length > 0,
  `screenshot must have a path: ${JSON.stringify(stateRes.screenshot)}`)
assert.ok(fs.existsSync(stateRes.screenshot.path), `screenshot file must exist: ${stateRes.screenshot.path}`)
assert.ok(
  !stateRes.screenshot.method || stateRes.screenshot.method === 'bitblt_screen',
  `screenshot method must be tier1-implicit or bitblt_screen, got ${stateRes.screenshot.method}`
)

// Clean up daemon before exit
stopDaemon()

console.log('parity check PASSED')
