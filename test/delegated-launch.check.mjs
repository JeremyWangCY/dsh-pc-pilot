import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcher = path.join(root, 'test', 'fixtures', 'delegated-native-window.cmd')
const tool = defineComputerTool(value => value, {})
let fixtureHwnd = 0

try {
  const launched = await tool.execute({
    action: 'launch_app',
    name: `cmd.exe /c "${launcher}"`,
  })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.ok(Number.isInteger(launched.hwnd) && launched.hwnd > 0, `delegated launch must return an HWND: ${JSON.stringify(launched)}`)
  assert.equal(launched.window?.id, launched.hwnd, `delegated launch must return a reusable window id: ${JSON.stringify(launched)}`)
  assert.match(String(launched.window?.app), /powershell/i, `delegated launch must identify the verified window process: ${JSON.stringify(launched)}`)
  assert.equal(launched.background_window_ready, true, `background launch must settle as a renderable non-minimized window: ${JSON.stringify(launched)}`)
  assert.equal(launched.window?.minimized, false, `background launch must not remain minimized: ${JSON.stringify(launched)}`)
  assert.equal(launched.window?.foreground, false, `background launch must not own foreground when it returns: ${JSON.stringify(launched)}`)
  const observed = await tool.execute({ action: 'get_window', window: launched.window })
  assert.equal(observed.ok, true, JSON.stringify(observed))
  assert.equal(observed.window.title, 'PC-Pilot native test fixture', JSON.stringify(observed))
  fixtureHwnd = observed.hwnd
} finally {
  if (fixtureHwnd) {
    try { await tool.execute({ action: 'close_window', hwnd: fixtureHwnd }) } catch { /* best effort cleanup */ }
  }
  try { execFileSync('taskkill', ['/FI', 'WINDOWTITLE eq PC-Pilot native test fixture', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* no fixture remains */ }
  stopDaemon()
}

console.log('delegated-launch check PASSED')
