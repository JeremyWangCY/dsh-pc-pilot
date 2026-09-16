import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(root, 'test', 'fixtures', 'common-file-dialog.ps1')
const tool = defineComputerTool(value => value, {})
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', fixture], {
  windowsHide: true,
  stdio: 'ignore',
})

try {
  let window
  for (let attempt = 0; attempt < 40 && !window; attempt++) {
    const listed = await tool.execute({ action: 'list_windows' })
    window = listed.windows?.find(item => item.pid === child.pid && item.title === 'PC-Pilot Common Dialog Fixture')
    if (!window) await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(window?.hwnd, 'owned Win32 common file dialog must become discoverable')

  const started = Date.now()
  const state = await tool.execute({
    action: 'get_window_state', hwnd: window.hwnd, screenshot: false, include_text: true,
  })
  const elapsed = Date.now() - started
  assert.equal(state.ok, true, JSON.stringify(state))
  assert.ok(elapsed < 10000, `common file dialog accessibility must stay bounded, elapsed=${elapsed}ms`)
  assert.ok(state.elements.some(item => /ControlType\.(Edit|Button|ComboBox)/.test(item.role)),
    'shallow common-dialog observation must retain actionable controls')
} finally {
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { }
  stopDaemon()
}

console.log('common dialog observation check PASSED')
