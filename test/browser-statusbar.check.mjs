import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const log = path.join(os.tmpdir(), `pcpilot-browser-status-${Date.now()}.jsonl`)
const statePath = path.join(os.tmpdir(), 'dsh-cua', 'status.state')
try { fs.unlinkSync(statePath) } catch { }
const session = spawn(process.execPath, ['scripts/session.mjs', log], { cwd: path.resolve('.'), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
const endpoint = 'ws://127.0.0.1:9/devtools/browser/pc-pilot-status-test'
session.stdin.write(JSON.stringify({ action: 'browser_state', browser_endpoint: endpoint }) + '\n')
const deadline = Date.now() + 5000
while (!fs.existsSync(statePath) && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
}
assert.ok(fs.existsSync(statePath), 'browser action must write status state')
let state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
while (state.show !== false && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 50))
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
}
assert.equal(state.show, false, 'browser action must hide status after completion')
session.kill()
stopDaemon()
console.log('PASS browser statusbar lifecycle')
