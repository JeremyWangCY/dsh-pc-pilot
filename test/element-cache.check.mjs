import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

// 1. Static assertions: Find-ElementByIndex must prioritize $script:cachedElements cache
const helperSrc = fs.readFileSync(new URL('../lib/pc-pilot-helper.ps1', import.meta.url), 'utf8')
assert.match(
  helperSrc,
  /function\s+Find-ElementByIndex[\s\S]*?\$script:cachedTreeHwnd\s*-eq\s*\$Hwnd\s*-and\s*\$null\s*-ne\s*\$script:cachedElements\s*-and\s*\$Index\s*-ge\s*1\s*-and\s*\$Index\s*-le\s*\$script:cachedElements\.Count/,
  'Find-ElementByIndex must prioritize $script:cachedElements cache'
)
assert.match(
  helperSrc,
  /\$cached\s*=\s*\$script:cachedElements\[\$Index\s*-\s*1\][\s\S]*?\$cached\.Current\.ProcessId[\s\S]*?return\s+\$cached/,
  'Find-ElementByIndex must verify cached element liveness and return O(1)'
)

// 2. Dynamic live test on OUR OWN scratch notepad — never on the user's foreground
//    window (the suite must stay read-only toward the user's session, same contract
//    as parity.check.mjs). Pattern proven in earlier review rounds:
//    open_app -> get_app_state -> click_element -> taskkill.
const tool = defineComputerTool((def) => def)
let notepadPid = 0
try {
  const openRes = await tool.execute({ action: 'launch_app', name: 'notepad' })
  notepadPid = Number.isSafeInteger(openRes.pid) ? openRes.pid : 0
  assert.equal(openRes.ok, true, `open_app notepad should succeed: ${JSON.stringify(openRes)}`)
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'scratch notepad must be spawned for the dynamic cache test')

  const screenshotOnly = await tool.execute({
    action: 'get_window_state',
    app: String(notepadPid),
    screenshot: false,
    include_text: false,
    dispatch: 'foreground',
  })
  assert.equal(screenshotOnly.ok, true, `screenshot-first state must succeed: ${JSON.stringify(screenshotOnly.message)}`)
  assert.equal(screenshotOnly.accessibility, null, 'include_text:false must not return an accessibility tree')
  assert.equal(screenshotOnly.accessibility_status, 'not_requested', 'screenshot-first state must not be mislabeled as unavailable UIA')
  assert.deepEqual(screenshotOnly.screenshots, [], 'a state without a capture must retain the canonical empty screenshots array')
  assert.deepEqual(screenshotOnly.elements, [], 'include_text:false must not build element indexes')

  const waited = await tool.execute({
    action: 'wait', duration_s: 2, app: String(notepadPid), include_text: true, wait_for: 'accessibility_present',
  })
  assert.equal(waited.ok, true, `window-targeted wait must succeed: ${JSON.stringify(waited)}`)
  assert.equal(waited.ready, true, 'accessibility_present must explicitly confirm a usable tree before proceeding')
  assert.ok(['partial', 'available'].includes(waited.accessibility_status), 'condition result must expose the observed readiness status')
  assert.ok(['available', 'partial'].includes(waited.post_action_observation?.accessibility_status),
    `wait must return a ready-state diagnosis when include_text is requested: ${JSON.stringify(waited.post_action_observation)}`)
  assert.equal(waited.post_action_observation?.accessibility?.status, waited.post_action_observation?.accessibility_status,
    'post-wait accessibility object must preserve the same readiness status')

  const stateRes = await tool.execute({
    action: 'get_window_state',
    app: String(notepadPid),
    screenshot: false,
    include_text: true,
    // Explicit test setup may restore only the scratch window, without activation.
    dispatch: 'foreground',
  })
  assert.ok(stateRes.ok, `get_app_state on scratch notepad should succeed: ${JSON.stringify(stateRes.message)}`)
  assert.ok(Array.isArray(stateRes.elements) && stateRes.elements.length > 0,
    'scratch notepad must expose a non-empty element tree (get_app_state must have cached it)')
  assert.equal(typeof stateRes.accessibility?.tree, 'string', 'include_text:true must expose the native-style formatted accessibility tree')
  assert.ok(['available', 'partial'].includes(stateRes.accessibility_status),
    `a launched Win32 app must report its actual UIA readiness instead of an unqualified success: ${stateRes.accessibility_status}`)
  assert.equal(stateRes.accessibility?.status, stateRes.accessibility_status,
    'accessibility object must expose the same readiness status as the top-level response')
  assert.equal(typeof stateRes.accessibility?.focused_element, 'string', 'include_text:true must expose focused-element context when the provider can identify it')
  assert.equal(typeof stateRes.accessibility?.selected_text, 'string', 'include_text:true must expose selected-text context when the provider supports it')
  assert.ok(Array.isArray(stateRes.accessibility?.selected_elements), 'include_text:true must expose selected accessibility elements')
  assert.ok(Number.isInteger(stateRes.accessibility_revision) && stateRes.accessibility_revision > 0,
    'include_text:true must expose a monotonic accessibility revision')
  assert.equal(stateRes.accessibility?.revision, stateRes.accessibility_revision,
    'accessibility object must expose the same revision as the top-level response')
  assert.equal(stateRes.accessibility_delta?.reset, false,
    'the prior wait observation should provide a base revision for the next full state')
  assert.equal(stateRes.accessibility_delta?.base_revision, waited.post_action_observation?.accessibility_revision,
    'incremental UIA state must explicitly reference its base revision')
  assert.ok(stateRes.elements.every((element) => typeof element.element_id === 'string' && element.element_id.length > 0),
    'every returned UIA element must expose a stable element_id')

  const stableIds = new Set(stateRes.elements.map((element) => element.element_id))
  const repeatedState = await tool.execute({
    action: 'get_window_state',
    app: String(notepadPid),
    screenshot: false,
    include_text: true,
    dispatch: 'foreground',
  })
  assert.equal(repeatedState.ok, true, `second stable-state observation must succeed: ${JSON.stringify(repeatedState)}`)
  assert.ok(repeatedState.accessibility_revision > stateRes.accessibility_revision,
    'accessibility revision must increase on each semantic observation')
  assert.equal(repeatedState.accessibility_delta?.reset, false,
    'same-window repeated observation must stay on the incremental history')
  assert.equal(repeatedState.accessibility_delta?.base_revision, stateRes.accessibility_revision,
    'second observation delta must reference the immediately previous revision')
  assert.ok(repeatedState.accessibility_delta?.unchanged_count > 0,
    'an unchanged scratch window must report stable unchanged UIA elements')
  const repeatedIds = new Set(repeatedState.elements.map((element) => element.element_id))
  assert.ok([...stableIds].some((id) => repeatedIds.has(id)),
    'stable element_id must survive across repeated observations of the same window')

  const textProbe = repeatedState.document_text || repeatedState.elements.find((element) => element.name)?.name || repeatedState.elements.find((element) => element.value)?.value
  if (textProbe) {
    const textCondition = await tool.execute({
      action: 'wait',
      duration_s: 0,
      app: String(notepadPid),
      include_text: true,
      expect: { type: 'text_present', text: String(textProbe).slice(0, 80), timeout_ms: 0 },
    })
    assert.equal(textCondition.ok, true, `live text postcondition must verify when the provider exposes text: ${JSON.stringify(textCondition)}`)
    assert.equal(textCondition.postcondition?.verified, true)
    assert.equal(textCondition.postcondition?.type, 'text_present')
  }

  const windowCondition = await tool.execute({
    action: 'wait',
    duration_s: 0,
    app: String(notepadPid),
    expect: { type: 'window_exists', timeout_ms: 0 },
  })
  assert.equal(windowCondition.ok, true, `live window-exists postcondition must verify: ${JSON.stringify(windowCondition)}`)
  assert.equal(windowCondition.postcondition?.verified, true)

  const valuedElement = repeatedState.elements.find((element) => typeof element.value === 'string' && element.element_id)
  assert.ok(valuedElement, 'scratch Notepad must expose an element suitable for stable-id value verification')
  const valueCondition = await tool.execute({
    action: 'wait',
    duration_s: 0,
    app: String(notepadPid),
    include_text: true,
    expect: { type: 'element_value', element_id: valuedElement.element_id, value: valuedElement.value, timeout_ms: 0 },
  })
  assert.equal(valueCondition.ok, true, `stable element value postcondition must verify: ${JSON.stringify(valueCondition)}`)
  assert.equal(valueCondition.postcondition?.element_id, valuedElement.element_id)

  const failedCondition = await tool.execute({
    action: 'wait',
    duration_s: 0,
    app: String(notepadPid),
    include_text: true,
    expect: { type: 'text_present', text: '__PC_PILOT_IMPOSSIBLE_POSTCONDITION__', timeout_ms: 0 },
  })
  assert.equal(failedCondition.ok, false, 'unmet postcondition must fail the action result')
  assert.equal(failedCondition.error_code, 'postcondition_failed')
  assert.equal(failedCondition.postcondition?.verified, false)

  const actionState = await tool.execute({
    action: 'get_window_state',
    app: String(notepadPid),
    screenshot: false,
    include_text: true,
    dispatch: 'foreground',
  })
  assert.equal(actionState.ok, true, 'postcondition observations must leave the helper ready for a fresh explicit state')
  const elIndex = actionState.elements[0].index
  const t0 = performance.now()
  const clickRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    element: elIndex,
    snapshot_id: actionState.snapshot_id,
    dispatch: 'background',
    overlay: false,
  })
  const durationMs = performance.now() - t0

  assert.ok(clickRes, 'click_element must return a result')
  assert.equal(clickRes.ok, false, `an element without a UIA action pattern must be refused: ${JSON.stringify(clickRes)}`)
  assert.equal(clickRes.error_code, 'background_unavailable')
  // A cached element-index refusal must be fast: it must not rescan or take an
  // unverified fallback through a screen-level control.
  assert.ok(durationMs < 600, `cached element-index refusal took ${Math.round(durationMs)}ms; expected no full-tree rescan`)
} finally {
  // cleanup scratch notepad regardless of outcome
  if (notepadPid > 0) { try { execFileSync('taskkill', ['/PID', String(notepadPid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' }) } catch { /* already gone */ } }
  stopDaemon()
}

console.log('element-cache check PASSED')
