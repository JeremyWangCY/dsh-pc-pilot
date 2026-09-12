import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const helperPath = path.join(rootDir, 'lib', 'pc-pilot-helper.ps1')
const overlayPath = path.join(rootDir, 'lib', 'virtual-cursor-overlay.ps1')
const helperSrc = fs.readFileSync(helperPath, 'utf8')
const overlaySrc = fs.readFileSync(overlayPath, 'utf8')

// ============================================================================
// 1. Static Contract Checks for Silent Launch & Accurate Virtual Cursor
// ============================================================================

// 1a. DshWin32 ShellExecuteExW & CreateProcessW with SW_SHOWNOACTIVATE
assert.ok(
  helperSrc.includes('ShellExecuteExW') && helperSrc.includes('SHELLEXECUTEINFO'),
  'DshWin32 must declare ShellExecuteExW with SHELLEXECUTEINFO'
)
assert.ok(
  helperSrc.includes('CreateProcessW') && helperSrc.includes('STARTUPINFO'),
  'DshWin32 must declare CreateProcessW with STARTUPINFO'
)
assert.ok(
  helperSrc.includes('SW_SHOWNOACTIVATE = 4') && helperSrc.includes('STARTF_USESHOWWINDOW = 0x00000001'),
  'DshWin32 must declare SW_SHOWNOACTIVATE = 4 and STARTF_USESHOWWINDOW = 1'
)

// 1b. launch_app silent launch contracts: WindowStyle Minimized (direct at bottom, zero flicker)
const openAppStart = helperSrc.indexOf("'launch_app' {")
const openAppEnd = helperSrc.indexOf('default {', openAppStart)
const openAppBody = helperSrc.slice(openAppStart, openAppEnd)

assert.ok(
  openAppBody.includes('WindowStyle $style') || openAppBody.includes('WindowStyle Minimized'),
  'launch_app must use WindowStyle Minimized for clean background launch without flicker'
)
assert.match(
  openAppBody,
  /\$style\s*=\s*if\s*\(Get-PayloadValue 'activate'.*?\)\s*\{\s*'Normal'\s*}\s*else\s*\{\s*'Minimized'\s*}/s,
  'launch_app activate:true must select a normal foreground launch while the default remains minimized'
)

// Click safety is exercised through real helper functions and action branches.
await import('./background-target.check.mjs')

// 1d. The canonical click branch handles element_index directly.
assert.match(helperSrc, /'click'[\s\S]*?Find-ElementByIndex -Hwnd \$win\.Hwnd -Index \(\[int\]\$rawElement\)/,
  'click must resolve an observed element_index in the canonical action branch')

// 1e. Get-AccessibilityTree provides both rect (window-relative) and screen_rect (screen coordinates)
assert.ok(
  helperSrc.includes('rect = @{ x = $relX; y = $relY; width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }'),
  'Get-AccessibilityTree must provide window-relative rect'
)
assert.ok(
  helperSrc.includes('screen_rect = @{ x = (Safe-Int $rect.X); y = (Safe-Int $rect.Y); width = (Safe-Int $rect.Width); height = (Safe-Int $rect.Height) }'),
  'Get-AccessibilityTree must provide screen_rect'
)

// 1f. virtual-cursor-overlay.ps1 pins overlay to HWND_TOPMOST via SetWindowPos
const b64Match = overlaySrc.match(/\$b64 = "([^"]+)"/)
assert.ok(b64Match, 'overlay script must contain base64 C#')
const decodedCs = Buffer.from(b64Match[1], 'base64').toString('utf8')
assert.ok(
  decodedCs.includes('SetWindowPos(hwnd, (IntPtr)(-1) /* HWND_TOPMOST */, p.X, p.Y, W, H, SWP_NOACTIVATE | SWP_SHOWWINDOW)'),
  'DshVcLayer::Show must call SetWindowPos with HWND_TOPMOST and SWP_NOACTIVATE | SWP_SHOWWINDOW'
)

// ============================================================================
// 2. Live Dynamic Verification on Scratch Notepad
// ============================================================================

const tool = defineComputerTool((def) => def)
let notepadPid = 0
let notepadHwnd = 0

try {
  // 2a. Test silent open_app: verify it returns real pid and hwnd, and does NOT steal foreground
  const openRes = await tool.execute({ action: 'launch_app', name: 'notepad' })
  notepadPid = Number.isSafeInteger(openRes.pid) ? openRes.pid : 0
  assert.equal(openRes.ok, true, `open_app notepad failed: ${JSON.stringify(openRes)}`)
  notepadHwnd = openRes.hwnd
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'open_app must return valid pid')
  assert.ok(Number.isInteger(notepadHwnd) && notepadHwnd > 0, 'open_app must return valid hwnd')
  assert.equal(openRes.window?.id, notepadHwnd, 'launch_app must return a reusable Computer Use window id')
  assert.equal(openRes.window?.app?.toLowerCase(), 'notepad', 'launch_app window must identify the verified process')

  // Verify the newly opened window did NOT steal foreground
  const gwInit = await tool.execute({ action: 'get_window', hwnd: notepadHwnd })
  assert.equal(gwInit.ok, true, 'get_window on scratch notepad must succeed')
  assert.equal(gwInit.window.foreground, false, 'scratch notepad launched silently must NOT be in foreground')

  // 2b. Test get_app_state: verify elements have both rect and screen_rect
  const stateRes = await tool.execute({ action: 'get_window_state', window: openRes.window, screenshot: false, include_text: true, dispatch: 'foreground' })
  assert.equal(stateRes.ok, true, 'get_app_state must succeed')
  assert.ok(Array.isArray(stateRes.elements) && stateRes.elements.length > 0, 'elements must not be empty')
  const el0 = stateRes.elements[0]
  assert.ok(el0.rect && typeof el0.rect.x === 'number' && typeof el0.rect.y === 'number', 'element must have rect {x, y}')
  assert.ok(el0.screen_rect && typeof el0.screen_rect.x === 'number' && typeof el0.screen_rect.y === 'number', 'element must have screen_rect {x, y}')

  // Mutating click contracts use the isolated provider fixture above.
  // Snapshot/cache behavior is covered separately by element-cache and snapshot tests.

} finally {
  if (notepadPid > 0) {
    try { execFileSync('taskkill', ['/PID', String(notepadPid), '/T', '/F'], { timeout: 10000, windowsHide: true, stdio: 'ignore' }) } catch { /* ignore */ }
  }
  stopDaemon()
}

console.log('fix-validation check PASSED')
