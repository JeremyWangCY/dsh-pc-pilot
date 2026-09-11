import assert from 'node:assert/strict'
import fs from 'node:fs'
import { execSync } from 'node:child_process'
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
  assert.equal(openRes.ok, true, `open_app notepad should succeed: ${JSON.stringify(openRes)}`)
  notepadPid = openRes.pid
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'scratch notepad must be spawned for the dynamic cache test')

  const stateRes = await tool.execute({
    action: 'get_window_state',
    app: String(notepadPid),
    screenshot: false,
    // Explicit test setup may restore only the scratch window, without activation.
    dispatch: 'foreground',
  })
  assert.ok(stateRes.ok, `get_app_state on scratch notepad should succeed: ${JSON.stringify(stateRes.message)}`)
  assert.ok(Array.isArray(stateRes.elements) && stateRes.elements.length > 0,
    'scratch notepad must expose a non-empty element tree (get_app_state must have cached it)')

  const elIndex = stateRes.elements[0].index
  const t0 = performance.now()
  const clickRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    element: elIndex,
    snapshot_id: stateRes.snapshot_id,
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
  if (notepadPid > 0) { try { execSync(`taskkill /PID ${notepadPid} /F`, { timeout: 10000, windowsHide: true }) } catch { /* already gone */ } }
  stopDaemon()
}

console.log('element-cache check PASSED')
