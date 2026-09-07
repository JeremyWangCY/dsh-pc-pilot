// Round 1 latency proof: the persistent PowerShell daemon must remove the
// per-action cold start (PS spawn + Add-Type C# compile). Runs list_apps once
// cold (daemon spawn) and 3 times warm through the SAME execute() path the host
// tool uses, asserts all round-trips succeed and the daemon reuses ONE child
// pid, and prints cold vs warm numbers. No hard wall-time asserts (CI variance).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineComputerTool, getDaemonPid, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

// Static contract: daemon mode exists on both sides of the pipe
const helperSrc = fs.readFileSync(path.join(rootDir, 'lib', 'computer-use-helper.ps1'), 'utf8')
const indexSrc = fs.readFileSync(path.join(rootDir, 'lib', 'index.js'), 'utf8')
const pkgSrc = fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')

assert.ok(helperSrc.includes('[switch]$Server'), 'helper must declare a -Server daemon mode switch')
assert.ok(helperSrc.includes("'invalid request'"), 'helper daemon must reply invalid request for bad lines')
assert.ok(helperSrc.includes('[Console]::In.ReadLineAsync()'), 'helper daemon must read stdin line-by-line with a read timeout')
assert.ok(indexSrc.includes("'-Server'"), 'index.js daemon spawn must pass -Server')
assert.ok(indexSrc.includes('function daemonRequest'), 'index.js must define daemonRequest')
assert.ok(indexSrc.includes('daemon circuit-breaker open'), 'index.js must implement the circuit breaker')
assert.ok(indexSrc.includes('return runAction(action, args || {}, signal)'), 'execute must keep the one-shot runAction fallback')
assert.ok(
  pkgSrc.includes('node test/latency.check.mjs"'),
  'latency check must run LAST in npm test'
)

// The tool must export the fallback contract the existing tests rely on
const { runAction } = await import('../lib/index.js')
assert.equal(typeof runAction, 'function', 'runAction one-shot path must stay exported')

const tool = defineComputerTool((d) => d)

// ---- cold call: spawns the daemon (PS spawn + Add-Type compile) ----
const tCold = performance.now()
const cold = await tool.execute({ action: 'list_apps' })
const coldMs = Math.round(performance.now() - tCold)
assert.equal(cold.ok, true, 'cold daemon list_apps must succeed')
assert.equal(cold.action, 'list_apps')

// ---- warm calls: same child process, no spawn/compile ----
const pid = getDaemonPid()
assert.ok(pid, 'daemon must be alive after the first call')

const warmMs = []
for (let i = 0; i < 3; i++) {
  const t = performance.now()
  const res = await tool.execute({ action: 'list_apps' })
  warmMs.push(Math.round(performance.now() - t))
  assert.equal(res.ok, true, `warm list_apps #${i + 1} must succeed`)
  assert.equal(getDaemonPid(), pid, 'warm calls must reuse the SAME daemon child pid')
}

const warmAvg = Math.round(warmMs.reduce((a, b) => a + b, 0) / warmMs.length)
console.log(`latency: cold=${coldMs}ms  warm avg=${warmAvg}ms  warm calls=[${warmMs.join(', ')}]ms  daemon pid=${pid}`)

process.on('exit', () => { try { stopDaemon() } catch { /* already gone */ } })
console.log('latency check PASSED')
