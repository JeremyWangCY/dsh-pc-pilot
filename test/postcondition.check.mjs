import assert from 'node:assert/strict'
import { defineComputerTool, evaluatePostconditionObservation, remapStableElementForRecovery } from '../lib/index.js'

assert.deepEqual(
  evaluatePostconditionObservation({ type: 'window_exists' }, { ok: true }),
  { type: 'window_exists', ok: true, observed: 'present' },
)
assert.equal(evaluatePostconditionObservation({ type: 'window_closed' }, { ok: false, error_code: 'window_not_found' }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'window_closed' }, { ok: false, error_code: 'observation_failed' }).ok, false)

const changed = evaluatePostconditionObservation({ type: 'accessibility_changed' }, {
  accessibility_revision: 12,
  accessibility_delta: { reset: false, added: [{ element_id: 'x' }], removed: [], changed: [] },
})
assert.equal(changed.ok, true)
assert.equal(changed.changed_count, 1)
assert.equal(evaluatePostconditionObservation({ type: 'accessibility_changed' }, {
  accessibility_delta: { reset: true, added: [], removed: [], changed: [] },
}).reason, 'accessibility_baseline_unavailable')

const element = { element_id: 'uia:1:2.3', index: 9, value: 'hello world', name: 'Editor' }
assert.equal(evaluatePostconditionObservation({ type: 'element_value', element_id: element.element_id, value: 'hello', match: 'prefix' }, { elements: [element] }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'text_present', text: 'Editor' }, { elements: [element] }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'browser_url', url: 'https://example.com/a', match: 'prefix' }, { url: 'https://example.com/a/b' }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'browser_text', text: 'ready' }, { text: 'page ready now' }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'browser_ready' }, { ready_state: 'complete' }).ok, true)
assert.equal(evaluatePostconditionObservation({ type: 'download_completed', filename: 'report.pdf' }, {
  downloads: [{ suggested_filename: 'report.pdf', state: 'completed' }],
  files: [],
}).ok, true)

assert.deepEqual(remapStableElementForRecovery(
  { action: 'click', element: 3, element_id: 'uia:stable', snapshot_id: 'old' },
  { snapshot_id: 'new', elements: [{ element_id: 'uia:stable', index: 17 }] },
), {
  ok: true,
  args: { action: 'click', element: 17, element_index: 17, element_id: 'uia:stable', snapshot_id: 'new' },
})
assert.equal(remapStableElementForRecovery({ element: 3 }, { elements: [] }).reason, 'element_id_required_for_safe_recovery')
assert.equal(remapStableElementForRecovery({ element: 3, element_id: 'missing' }, { elements: [] }).reason, 'stable_element_not_found')

const tool = defineComputerTool((value) => value, {})
const p = tool.parameters.properties
assert.equal(p.expect.type, 'object')
assert.ok(p.expect.properties.type.enum.includes('element_value'))
assert.deepEqual(p.recovery.enum, ['none', 'foreground_once'])
assert.equal(p.element_id.type, 'string')

const invalid = await tool.execute({ action: 'wait', duration_s: 0, expect: { type: 'element_value', value: 'x' } })
assert.equal(invalid.ok, false)
assert.equal(invalid.error_code, 'invalid_postcondition')
assert.equal(invalid.outcome, 'not_executed')

console.log('postcondition check PASSED')
