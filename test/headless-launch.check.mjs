import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-pilot-launch-'))
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const tool = defineComputerTool(v => v, {})
let endpoint
let launchedPid = 0
const started = performance.now()
try {
  const rejected = await tool.execute({ action: 'browser_shutdown', browser_endpoint: 'ws://127.0.0.1:9222/devtools/browser/not-owned' })
  assert.equal(rejected.ok, false, JSON.stringify(rejected))
  assert.equal(rejected.error_code, 'browser_not_owned', JSON.stringify(rejected))
  const launched = await tool.execute({ action: 'launch_app', name: `"${edge}" --user-data-dir="${profile}"`, headless: true, overlay: false })
  launchedPid = Number.isSafeInteger(launched.pid) ? launched.pid : 0
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.equal(launched.headless, true)
  endpoint = launched.browser_endpoint
  assert.ok(endpoint)
  const windows = await tool.execute({ action: 'list_windows' })
  assert.equal(windows.ok, true)
  assert.ok(!windows.windows.some(w => Number(w.pid) === launched.pid), 'headless process must not expose a desktop window')
  const state = await tool.execute({ action: 'browser_state', browser_endpoint: endpoint })
  assert.equal(state.ok, true, JSON.stringify(state))
  assert.ok(state.pages.length)
  const shutdown = await tool.execute({ action: 'browser_shutdown', browser_endpoint: endpoint })
  assert.equal(shutdown.ok, true, JSON.stringify(shutdown))
  assert.equal(shutdown.browser_closed, true, JSON.stringify(shutdown))
  endpoint = undefined
  console.log(`PASS headless helper launch: no desktop window; CDP reachable; elapsed=${Math.round(performance.now() - started)}ms`)
} finally {
  if (endpoint) {
    try {
      const socket = new WebSocket(endpoint)
      await once(socket, 'open')
      socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
      await Promise.race([once(socket, 'close'), new Promise(resolve => setTimeout(resolve, 2000))])
      socket.close()
    } catch { /* PID cleanup below is the fallback */ }
  }
  if (launchedPid > 0) {
    try {
      execFileSync('taskkill', ['/PID', String(launchedPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* Browser.close already ended the test process tree */ }
  }
  stopDaemon()
  const resolved = path.resolve(profile)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('pc-pilot-launch-'))
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
