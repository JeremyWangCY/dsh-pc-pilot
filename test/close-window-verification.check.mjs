import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturePath = path.join(root, 'test', 'fixtures', 'close-resistant-window.ps1')
const tool = defineComputerTool(value => value, {})
let fixturePid = 0

try {
  const launched = await tool.execute({ action: 'launch_app', name: `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${fixturePath}"`, overlay: false })
  fixturePid = Number.isSafeInteger(launched.pid) ? launched.pid : 0
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.ok(launched.window, JSON.stringify(launched))

  const closed = await tool.execute({ action: 'close_window', window: launched.window, overlay: false })
  assert.equal(closed.ok, false, JSON.stringify(closed))
  assert.equal(closed.outcome, 'unknown', JSON.stringify(closed))
  assert.equal(closed.error_code, 'window_close_unconfirmed', JSON.stringify(closed))
  assert.equal(closed.close_dispatched, true, JSON.stringify(closed))
  assert.equal(closed.closed, false, JSON.stringify(closed))
  assert.equal(closed.needs_observation, true, JSON.stringify(closed))
} finally {
  if (fixturePid > 0) {
    try { execFileSync('taskkill', ['/PID', String(fixturePid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* fixture already exited */ }
  }
  stopDaemon()
}

console.log('close-window verification check PASSED')
