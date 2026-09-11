import assert from 'node:assert/strict'
import { defineComputerTool } from '../lib/index.js'

const tool = defineComputerTool(value => value, {})
const out = await tool.execute({ actions: [{ action: 'wait', duration_s: 0 }] })
assert.equal(out.ok, true)
assert.equal(out.action, 'batch')
assert.equal(out.completed_count, 1)
assert.equal(out.steps.length, 1)
assert.equal(out.steps[0].post_action_observation.ok, true)
assert.ok(out.steps[0].post_action_observation.screenshot?.path)
assert.deepEqual(out.post_action_observation, out.steps[0].post_action_observation)

const twoSteps = await tool.execute({ actions: [{ action: 'wait', duration_s: 0 }, { action: 'wait', duration_s: 0 }] })
assert.equal(twoSteps.completed_count, 2)
assert.equal(twoSteps.steps[0].post_action_observation, undefined, 'a batch returns one final observation')
assert.equal(twoSteps.steps[1].post_action_observation.ok, true)

const classified = await tool.execute({ action: 'click', hwnd: 1, x: 1, y: 1, expected_name: 'Delete account', dispatch: 'background' })
assert.equal(classified.safety.class, 'consequential')
assert.equal(classified.safety.requires_confirmation, false)

const invalid = await tool.execute({ actions: [{ action: 'wait', duration_s: 0 }, { nope: true }] })
assert.equal(invalid.ok, false)
assert.equal(invalid.failed_index, 1)
assert.equal(invalid.completed_count, 1)

console.log('batch observation and safety check PASSED')
