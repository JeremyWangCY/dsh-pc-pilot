import assert from 'node:assert/strict'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

// 1. defineComputerTool schema assertions
const tool = defineComputerTool((def) => def)
assert.equal(tool.name, 'computer')
const params = tool.parameters.properties

const expectedActions = [
  'read_clipboard',
  'write_clipboard',
  'mouse_down',
  'mouse_up',
  'hold_key',
  'list_displays',
]

for (const act of expectedActions) {
  assert.ok(
    params.action.enum.includes(act),
    `action enum must include '${act}', current enum: ${JSON.stringify(params.action.enum)}`
  )
}

// button property schema
assert.ok(params.button, 'button parameter must be present')
assert.equal(params.button.type, 'string')
assert.deepEqual(params.button.enum, ['left', 'right', 'middle'])
assert.equal(
  params.button.description,
  'Mouse button for click and mouse_down/mouse_up (default left).'
)

// duration_ms property schema
assert.ok(params.duration_ms, 'duration_ms parameter must be present')
assert.equal(params.duration_ms.type, 'number')
assert.equal(
  params.duration_ms.description,
  'Hold duration in milliseconds for hold_key (default 500, max 10000).'
)

// 2. read_clipboard and write_clipboard execute and round-trip text
const testPayload = `dsh-test-clipboard-payload-${Date.now()}-${Math.random().toString(36).slice(2)}`
const writeRes = await tool.execute({
  action: 'write_clipboard',
  text: testPayload,
})
assert.ok(writeRes, 'write_clipboard must return a result object')
assert.equal(writeRes.ok, true, `write_clipboard should succeed: ${JSON.stringify(writeRes)}`)
assert.equal(writeRes.action, 'write_clipboard')
assert.equal(writeRes.length, testPayload.length)

const readRes = await tool.execute({
  action: 'read_clipboard',
})
assert.ok(readRes, 'read_clipboard must return a result object')
assert.equal(readRes.ok, true, `read_clipboard should succeed: ${JSON.stringify(readRes)}`)
assert.equal(readRes.action, 'read_clipboard')
assert.equal(readRes.text, testPayload, 'read_clipboard must return the text that was written')

// Also verify round-trip with empty text
const writeEmptyRes = await tool.execute({
  action: 'write_clipboard',
  text: '',
})
assert.equal(writeEmptyRes.ok, true, 'write_clipboard with empty text should succeed')
assert.equal(writeEmptyRes.length, 0)

const readEmptyRes = await tool.execute({
  action: 'read_clipboard',
})
assert.equal(readEmptyRes.ok, true, 'read_clipboard after empty write should succeed')
assert.equal(readEmptyRes.text, '', 'read_clipboard should return empty string')

// 3. list_displays returns at least 1 display with bounds
const displaysRes = await tool.execute({
  action: 'list_displays',
})
assert.ok(displaysRes, 'list_displays must return a result object')
assert.equal(displaysRes.ok, true, `list_displays should succeed: ${JSON.stringify(displaysRes)}`)
assert.equal(displaysRes.action, 'list_displays')
assert.ok(
  typeof displaysRes.display_count === 'number' && displaysRes.display_count >= 1,
  `display_count must be >= 1, got ${displaysRes.display_count}`
)
assert.ok(
  Array.isArray(displaysRes.displays) && displaysRes.displays.length >= 1,
  'displays must be a non-empty array'
)

for (const disp of displaysRes.displays) {
  assert.ok(typeof disp.index === 'number' && disp.index >= 1, 'display index must be 1-based number')
  assert.ok(typeof disp.id === 'string' && disp.id.length > 0, 'display id must be non-empty string')
  assert.ok(typeof disp.primary === 'boolean', 'display primary must be boolean')

  assert.ok(disp.bounds, 'display bounds must be defined')
  assert.equal(typeof disp.bounds.x, 'number')
  assert.equal(typeof disp.bounds.y, 'number')
  assert.ok(typeof disp.bounds.width === 'number' && disp.bounds.width > 0, 'bounds.width must be positive')
  assert.ok(typeof disp.bounds.height === 'number' && disp.bounds.height > 0, 'bounds.height must be positive')

  assert.ok(disp.working_area, 'display working_area must be defined')
  assert.equal(typeof disp.working_area.x, 'number')
  assert.equal(typeof disp.working_area.y, 'number')
  assert.ok(typeof disp.working_area.width === 'number' && disp.working_area.width > 0, 'working_area.width must be positive')
  assert.ok(typeof disp.working_area.height === 'number' && disp.working_area.height > 0, 'working_area.height must be positive')
}

// 4. Also exercise mouse_down, mouse_up, and hold_key through execute()
const mouseDownRes = await tool.execute({
  action: 'mouse_down',
  button: 'left',
  x: 50,
  y: 50,
  dispatch: 'background',
})
assert.ok(mouseDownRes, 'mouse_down should return a result')
assert.equal(mouseDownRes.ok, true, `mouse_down should succeed: ${JSON.stringify(mouseDownRes)}`)
assert.equal(mouseDownRes.action, 'mouse_down')
assert.equal(mouseDownRes.button, 'left')

const mouseUpRes = await tool.execute({
  action: 'mouse_up',
  button: 'left',
  x: 50,
  y: 50,
  dispatch: 'background',
})
assert.ok(mouseUpRes, 'mouse_up should return a result')
assert.equal(mouseUpRes.ok, true, `mouse_up should succeed: ${JSON.stringify(mouseUpRes)}`)
assert.equal(mouseUpRes.action, 'mouse_up')
assert.equal(mouseUpRes.button, 'left')

const holdKeyRes = await tool.execute({
  action: 'hold_key',
  key: 'Shift',
  duration_ms: 60,
  dispatch: 'background',
})
assert.ok(holdKeyRes, 'hold_key should return a result')
assert.equal(holdKeyRes.ok, true, `hold_key should succeed: ${JSON.stringify(holdKeyRes)}`)
assert.equal(holdKeyRes.action, 'hold_key')
assert.equal(holdKeyRes.key, 'Shift')
assert.equal(holdKeyRes.duration_ms, 60)

// Clean up daemon before exit
stopDaemon()

console.log('features check PASSED')
