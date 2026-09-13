import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import http from 'node:http'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-pilot-launch-'))
const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const tool = defineComputerTool(v => v, {})
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end('<!doctype html><title>PC Pilot Postcondition</title><body>POSTCONDITION READY</body>')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const fixtureUrl = `http://127.0.0.1:${server.address().port}/ready`
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

  const opened = await tool.execute({
    action: 'browser_open',
    browser_endpoint: endpoint,
    url: fixtureUrl,
    expect: { type: 'browser_ready', timeout_ms: 5000 },
  })
  assert.equal(opened.ok, true, `browser_open ready postcondition must verify: ${JSON.stringify(opened)}`)
  assert.equal(opened.postcondition?.verified, true)
  const tab = opened.tab_id

  const urlCheck = await tool.execute({
    action: 'browser_state',
    browser_endpoint: endpoint,
    tab_id: tab,
    expect: { type: 'browser_url', url: fixtureUrl, match: 'exact', timeout_ms: 1000 },
  })
  assert.equal(urlCheck.ok, true, `browser URL postcondition must verify: ${JSON.stringify(urlCheck)}`)
  assert.equal(urlCheck.postcondition?.observed_url, fixtureUrl)

  const textCheck = await tool.execute({
    action: 'browser_read',
    browser_endpoint: endpoint,
    tab_id: tab,
    expect: { type: 'browser_text', text: 'POSTCONDITION READY', timeout_ms: 1000 },
  })
  assert.equal(textCheck.ok, true, `browser text postcondition must verify: ${JSON.stringify(textCheck)}`)
  assert.equal(textCheck.postcondition?.verified, true)

  const textMiss = await tool.execute({
    action: 'browser_read',
    browser_endpoint: endpoint,
    tab_id: tab,
    expect: { type: 'browser_text', text: '__MISSING_BROWSER_POSTCONDITION__', timeout_ms: 0 },
  })
  assert.equal(textMiss.ok, false)
  assert.equal(textMiss.error_code, 'postcondition_failed')
  assert.equal(textMiss.postcondition?.verified, false)

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
  await new Promise(resolve => server.close(resolve))
  stopDaemon()
  const resolved = path.resolve(profile)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('pc-pilot-launch-'))
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
