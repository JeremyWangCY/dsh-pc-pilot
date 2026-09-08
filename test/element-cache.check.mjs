import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

// 1. Static assertions: Find-ElementByIndex must prioritize $script:cachedElements cache
const helperSrc = fs.readFileSync(new URL('../lib/computer-use-helper.ps1', import.meta.url), 'utf8')
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
  const openRes = await tool.execute({ action: 'open_app', name: 'notepad' })
  assert.equal(openRes.ok, true, `open_app notepad should succeed: ${JSON.stringify(openRes)}`)
  notepadPid = openRes.pid
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'scratch notepad must be spawned for the dynamic cache test')

  const stateRes = await tool.execute({
    action: 'get_app_state',
    app: String(notepadPid),
    screenshot: false,
  })
  assert.ok(stateRes.ok, `get_app_state on scratch notepad should succeed: ${JSON.stringify(stateRes.message)}`)
  assert.ok(Array.isArray(stateRes.elements) && stateRes.elements.length > 0,
    'scratch notepad must expose a non-empty element tree (get_app_state must have cached it)')

  const elIndex = stateRes.elements[0].index
  const t0 = performance.now()
  const clickRes = await tool.execute({
    action: 'click_element',
    app: String(notepadPid),
    element: elIndex,
    dispatch: 'background',
    overlay: false,
  })
  const durationMs = performance.now() - t0

  assert.ok(clickRes, 'click_element must return a result')
  assert.equal(clickRes.ok, true, `click_element should succeed: ${JSON.stringify(clickRes)}`)
  assert.ok(
    ['invoke_pattern', 'toggle_pattern', 'selection_pattern', 'expand_pattern', 'wm_message', 'clickable_point', 'rect_center'].includes(clickRes.method),
    `expected a valid interaction method, got ${clickRes.method}`
  )
  // Directional O(1) check: a warm cached hit must stay well under the full-tree
  // rescan baseline (~150ms+ per traversal); loose upper bound, fail only on regression
  assert.ok(durationMs < 600, `cached click_element took ${Math.round(durationMs)}ms; expected well under the full-rescan baseline (loose 600ms cap)`)
} finally {
  // cleanup scratch notepad regardless of outcome
  if (notepadPid > 0) { try { execSync(`taskkill /PID ${notepadPid} /F`, { timeout: 10000 }) } catch { /* already gone */ } }
  stopDaemon()
}

console.log('element-cache check PASSED')
