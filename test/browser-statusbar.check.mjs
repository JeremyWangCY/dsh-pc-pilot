import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const log = path.join(os.tmpdir(), `pcpilot-browser-status-${Date.now()}.jsonl`)
const statePath = path.join(os.tmpdir(), 'dsh-cua', 'status.state')
try { fs.unlinkSync(statePath) } catch { }
const session = spawn(process.execPath, ['scripts/session.mjs', log], { cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
const endpoint = 'ws://127.0.0.1:9/devtools/browser/pc-pilot-status-test'
let stderr = ''
session.stderr.on('data', chunk => { stderr += chunk })
const stepCompleted = new Promise((resolve, reject) => {
  let stdout = ''
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    fn(value)
  }
  const timer = setTimeout(() => finish(reject, new Error(`browser status action timed out: ${stderr.slice(0, 1200)}`)), 20000)
  session.stdout.on('data', chunk => {
    stdout += chunk
    const newline = stdout.indexOf('\n')
    if (newline >= 0) finish(resolve, stdout.slice(0, newline))
  })
  session.once('error', error => finish(reject, error))
  session.once('exit', code => finish(reject, new Error(`browser status session exited before reply: ${code}; ${stderr.slice(0, 1200)}`)))
})
session.stdin.write(JSON.stringify({ action: 'browser_state', browser_endpoint: endpoint }) + '\n')
await stepCompleted
assert.ok(fs.existsSync(statePath), 'browser action must write status state')
const hideDeadline = Date.now() + 3000
let state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
while (state.show !== false && Date.now() < hideDeadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
assert.equal(state.show, false, 'browser action must hide status after completion')
session.kill()
stopDaemon()
console.log('PASS browser statusbar lifecycle')
