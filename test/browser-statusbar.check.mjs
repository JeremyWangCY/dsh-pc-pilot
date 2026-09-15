import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const statePath = path.join(os.tmpdir(), 'dsh-cua', 'status.state')
try { fs.unlinkSync(statePath) } catch { }
const endpoint = 'ws://127.0.0.1:9/devtools/browser/pc-pilot-status-test'
const tool = defineComputerTool(value => value, {})
try {
  await tool.execute({ action: 'browser_state', browser_endpoint: endpoint })
  assert.ok(fs.existsSync(statePath), 'browser action must write status state')
  const hideDeadline = Date.now() + 3000
  let state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  while (state.show !== false && Date.now() < hideDeadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  }
  assert.equal(state.show, false, 'browser action must hide status after completion')
} finally {
  stopDaemon()
}
console.log('PASS browser statusbar lifecycle')
