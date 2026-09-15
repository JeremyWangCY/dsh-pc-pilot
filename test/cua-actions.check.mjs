import assert from 'node:assert/strict'
import { defineComputerTool, normalizeComputerAction } from '../lib/index.js'

const tool = defineComputerTool((value) => value, {})
const parameters = tool.parameters.properties
const actionEnum = parameters.action.enum
assert.deepEqual(actionEnum.slice(0, 13), [
  'list_apps', 'list_windows', 'get_window', 'launch_app', 'get_window_state',
  'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
  'perform_secondary_action', 'activate_window',
])
for (const removed of ['get_app_state', 'open_app', 'click_element', 'key', 'perform_action']) {
  assert.ok(!actionEnum.includes(removed), `legacy action must not be model-callable: ${removed}`)
}
assert.equal(parameters.keys.type, 'array')
assert.ok(parameters.path.oneOf, 'path must accept both drag paths and zoom screenshot paths')
assert.equal(parameters.actions.type, 'array')
assert.equal(parameters.action.required, undefined, 'action is optional when an ordered actions array is supplied')
assert.ok(parameters.url, 'computer schema must expose initial browser URL')
assert.equal(parameters.activate.type, 'boolean', 'launch_app foreground activation must be model-callable')
assert.ok(parameters.include_text, 'computer schema must expose screenshot-first include_text control')
assert.match(parameters.include_text.description, /default false/i)
assert.ok(actionEnum.includes('browser_observe'), 'browser_observe must remain model-callable')
assert.equal(parameters.browser.type, 'object', 'computer schema must expose reusable browser targets')
assert.match(parameters.browser_element.description, /@eN/, 'browser_element must document compact semantic refs')
assert.equal(normalizeComputerAction({ action: 'browser_observe', browser: { endpoint: 'ws://127.0.0.1:9222/devtools/browser/test', tab_id: 'tab-1' } }).args.browser_endpoint, 'ws://127.0.0.1:9222/devtools/browser/test')
assert.equal(normalizeComputerAction({ action: 'browser_observe', browser: { endpoint: 'ws://127.0.0.1:9222/devtools/browser/test', tab_id: 'tab-1' } }).args.tab_id, 'tab-1')

assert.deepEqual(normalizeComputerAction({ action: 'scroll', x: 10, y: 20, scrollX: 240, scrollY: 0 }).args, {
  action: 'scroll', x: 10, y: 20, scrollX: 240, scrollY: 0, scroll_x: 240, scroll_y: 0, amount: 2, direction: 'right',
})
assert.deepEqual(normalizeComputerAction({ action: 'scroll', scroll_x: 120, scroll_y: -240 }).args.scroll_components, [
  { amount: 1, direction: 'right' },
  { amount: 2, direction: 'up' },
])
assert.deepEqual(normalizeComputerAction({ action: 'drag', path: [[1, 2], [30, 40], [50, 60]] }).args, {
  action: 'drag', path: [[1, 2], [30, 40], [50, 60]], from_x: 1, from_y: 2, to_x: 50, to_y: 60,
})
assert.equal(normalizeComputerAction({ action: 'click', keys: ['CTRL'], x: 1, y: 2 }).args.modifiers, 'CTRL')
assert.equal(normalizeComputerAction({ action: 'click', screenshotId: 'shot-1' }).args.screenshot_id, 'shot-1')
assert.equal(normalizeComputerAction({ action: 'click', mouse_button: 'l' }).args.button, 'left')
assert.equal(normalizeComputerAction({ action: 'click', mouse_button: 'r' }).args.button, 'right')
assert.equal(normalizeComputerAction({ action: 'click', mouse_button: 'm' }).args.button, 'middle')
assert.equal(normalizeComputerAction({ action: 'click', button: 'wheel' }).args.button, 'middle')
for (const button of ['left', 'right', 'middle', 'wheel', 'back', 'forward']) {
  assert.ok(parameters.button.enum.includes(button), `OpenAI click button must be model-callable: ${button}`)
}
assert.deepEqual(normalizeComputerAction({ action: 'get_window_state', window: { id: 42, app: 'notepad.exe' }, include_screenshot: false }), {
  requestedAction: 'get_window_state', action: 'get_window_state', args: { action: 'get_window_state', window: { id: 42, app: 'notepad.exe' }, include_screenshot: false, hwnd: 42, app: 'notepad.exe', screenshot: false },
})
assert.deepEqual(normalizeComputerAction({ action: 'launch_app', app: 'notepad.exe' }), {
  requestedAction: 'launch_app', action: 'launch_app', args: { action: 'launch_app', name: 'notepad.exe' },
})
assert.equal(normalizeComputerAction({ action: 'press_key', window: { id: 42, app: 'notepad.exe' }, key: 'Return' }).action, 'press_key')
assert.equal(normalizeComputerAction({ action: 'type_text', text: 'hello' }).action, 'type_text')
assert.deepEqual(normalizeComputerAction({ action: 'double_click', x: 7, y: 9 }), {
  requestedAction: 'double_click', action: 'click', args: { action: 'click', x: 7, y: 9, click_count: 2 },
})
assert.deepEqual(normalizeComputerAction({ action: 'type', text: 'hello' }), {
  requestedAction: 'type', action: 'type_text', args: { action: 'type_text', text: 'hello' },
})
assert.deepEqual(normalizeComputerAction({ action: 'keypress', keys: ['CTRL', 'L'] }), {
  requestedAction: 'keypress', action: 'press_key', args: { action: 'press_key', keys: ['CTRL', 'L'], key: 'CTRL+L' },
})
assert.deepEqual(normalizeComputerAction({ action: 'move', x: 7, y: 9 }), {
  requestedAction: 'move', action: 'mouse_move', args: { action: 'mouse_move', x: 7, y: 9 },
})
for (const alias of ['double_click', 'type', 'keypress', 'move']) assert.ok(actionEnum.includes(alias), `OpenAI computer-use alias must be model-callable: ${alias}`)
assert.deepEqual(normalizeComputerAction({ action: 'perform_secondary_action', secondary_action: 'expand' }), {
  requestedAction: 'perform_secondary_action', action: 'perform_secondary_action', args: { action: 'perform_secondary_action', secondary_action: 'expand' },
})
assert.equal(normalizeComputerAction({ action: 'perform_secondary_action', secondary_action: 'Scroll Down' }).args.secondary_action, 'scroll_down')
assert.equal(normalizeComputerAction({ action: 'perform_secondary_action', secondary_action: 'scroll-left' }).args.secondary_action, 'scroll_left')
assert.equal(parameters.screenshot_id.type, 'string')

for (const request of [
  { action: 'press_key', key: 'Meta+R' },
  { action: 'keypress', keys: ['Meta', 'R'] },
  { action: 'hold_key', key: 'Command+space' },
  { action: 'click', x: 1, y: 1, keys: ['Win'] },
]) {
  const denied = await tool.execute(request)
  assert.equal(denied.ok, false, `system-key request must be refused: ${JSON.stringify(request)}`)
  assert.equal(denied.error_code, 'unsupported_system_key')
  assert.equal(denied.outcome, 'not_executed')
}

console.log('canonical computer-use actions check PASSED')
