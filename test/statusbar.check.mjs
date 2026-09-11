import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { once } from 'node:events'
import { defineComputerTool, stopDaemon } from '../lib/index.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const sample = path.join(os.tmpdir(), `pcpilot-status-${Date.now()}.png`)
execFileSync('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'lib/pcpilot-statusbar.ps1'),'-RenderSample',sample], { windowsHide:true, timeout:10000 })
assert.ok(fs.existsSync(sample), 'successful rendering must produce a PNG')
assert.equal(fs.readFileSync(sample).readUInt32BE(16),320)
const observer = spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'test/fixtures/statusbar-observer.ps1')], { windowsHide:true, stdio:['ignore','pipe','pipe'] })
let output = ''
const ready = new Promise((resolve,reject) => {
  const timer = setTimeout(() => reject(Error('observer startup timeout')), 5000)
  observer.stdout.on('data', data => { output += data; if(output.includes('READY')) { clearTimeout(timer); resolve() } })
  observer.on('error', error => { clearTimeout(timer); reject(error) })
})
try {
  await ready
  const tool = defineComputerTool(v => v, {})
  const result = await tool.execute({ action:'mouse_move', x:10, y:10, dispatch:'background', overlay:true })
  assert.equal(result.method,'overlay_cursor', JSON.stringify(result))
  await once(observer,'exit')
  const report = JSON.parse(output.trim().split(/\r?\n/).at(-1))
  assert.equal(report.seen,true,'real tool action must display status pill')
  assert.equal(report.hidden_after,true,'status pill must hide after activity expires')
  console.log('PASS statusbar: '+JSON.stringify(report))
} finally { if(observer.exitCode === null) observer.kill(); stopDaemon() }
