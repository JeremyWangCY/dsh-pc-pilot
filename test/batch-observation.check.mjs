import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const tool = defineComputerTool(value => value, {})
const screenshotDir = path.join(os.tmpdir(), 'dsh-cua')
const captures = new Set()
function rememberCapture(value) {
  const capturePath = value?.post_action_observation?.screenshot?.path || value?.steps?.at(-1)?.post_action_observation?.screenshot?.path
  if (typeof capturePath === 'string') captures.add(capturePath)
}

try {
  const out = await tool.execute({ actions: [{ action: 'wait', duration_s: 0 }] })
  rememberCapture(out)
  assert.equal(out.ok, true)
  assert.equal(out.action, 'batch')
  assert.equal(out.completed_count, 1)
  assert.equal(out.steps.length, 1)
  assert.equal(out.steps[0].post_action_observation.ok, true)
  assert.ok(out.steps[0].post_action_observation.screenshot?.path)
  assert.deepEqual(out.post_action_observation, out.steps[0].post_action_observation)

  const twoSteps = await tool.execute({ actions: [{ action: 'wait', duration_s: 0 }, { action: 'wait', duration_s: 0 }] })
  rememberCapture(twoSteps)
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

  // Lightweight conditional batching: `when` gates a step before dispatch; `expect`
  // remains the post-action gate. No branching or hidden retry engine is involved.
  const definitelyMissingHwnd = 999999999
  const gatedPass = await tool.execute({
    hwnd: definitelyMissingHwnd,
    actions: [
      { action: 'wait', duration_s: 0, when: { type: 'window_closed' } },
      { action: 'wait', duration_s: 0 },
    ],
  })
  rememberCapture(gatedPass)
  assert.equal(gatedPass.ok, true, JSON.stringify(gatedPass))
  assert.equal(gatedPass.completed_count, 2)
  assert.equal(gatedPass.steps[0].precondition.ok, true)
  assert.equal(gatedPass.steps[0].precondition.waited_ms >= 0, true)

  const gatedStop = await tool.execute({
    hwnd: definitelyMissingHwnd,
    actions: [
      { action: 'wait', duration_s: 0, when: { type: 'window_exists' } },
      { action: 'wait', duration_s: 0 },
    ],
  })
  assert.equal(gatedStop.ok, false)
  assert.equal(gatedStop.outcome, 'not_executed')
  assert.equal(gatedStop.failed_index, 0)
  assert.equal(gatedStop.completed_count, 0)
  assert.equal(gatedStop.steps.length, 1, 'later batch steps must not run after an unmet precondition')
  assert.equal(gatedStop.steps[0].error_code, 'precondition_not_met')
  assert.equal(gatedStop.steps[0].retry_safe, true)

  console.log('batch observation and safety check PASSED')
} finally {
  for (const capturePath of captures) {
    const resolved = path.resolve(capturePath)
    if (path.dirname(resolved) === screenshotDir && /^(shot|disp|zoom)-[a-f0-9]{32}\.png$/i.test(path.basename(resolved))) {
      try { fs.unlinkSync(resolved) } catch { /* helper already removed it */ }
    }
  }
  stopDaemon()
}
