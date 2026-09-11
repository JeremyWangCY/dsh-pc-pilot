import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const launcher = path.join(root, 'test', 'fixtures', 'delegated-native-window.cmd')
const tool = defineComputerTool(value => value, {})
let hwnd = 0

try {
  const launched = await tool.execute({
    action: 'launch_app',
    name: `cmd.exe /c "${launcher}"`,
  })
  assert.equal(launched.ok, true, JSON.stringify(launched))
  assert.ok(Number.isInteger(launched.hwnd) && launched.hwnd > 0, `delegated launch must return an HWND: ${JSON.stringify(launched)}`)
  hwnd = launched.hwnd
  const observed = await tool.execute({ action: 'get_window', hwnd })
  assert.equal(observed.ok, true, JSON.stringify(observed))
  assert.equal(observed.window.title, 'PC-Pilot native test fixture', JSON.stringify(observed))
} finally {
  if (hwnd) {
    try { await tool.execute({ action: 'close_window', hwnd }) } catch { /* best effort cleanup */ }
  }
  try { execFileSync('taskkill', ['/FI', 'WINDOWTITLE eq PC-Pilot native test fixture', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* no fixture remains */ }
  stopDaemon()
}

console.log('delegated-launch check PASSED')
