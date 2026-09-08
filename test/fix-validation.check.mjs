import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const helperPath = path.join(rootDir, 'lib', 'computer-use-helper.ps1')
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

// 1b. open_app silent launch contracts: WindowStyle Minimized (direct at bottom, zero flicker)
const openAppStart = helperSrc.indexOf("'open_app' {")
const openAppEnd = helperSrc.indexOf('default {', openAppStart)
const openAppBody = helperSrc.slice(openAppStart, openAppEnd)

assert.ok(
  openAppBody.includes('WindowStyle $style') || openAppBody.includes('WindowStyle Minimized'),
  'open_app must use WindowStyle Minimized for clean background launch without flicker'
)

// 1c. click coordinate resolution contracts: element center, screen coord detection, window center fallback
const clickStart = helperSrc.indexOf("'click' {")
const clickEnd = helperSrc.indexOf("'click_element' {", clickStart)
const clickBody = helperSrc.slice(clickStart, clickEnd)

assert.ok(
  clickBody.includes('Find-ElementByIndex') && clickBody.includes('BoundingRectangle'),
  'click must resolve element parameter via Find-ElementByIndex and BoundingRectangle'
)
assert.ok(
  clickBody.includes('$r.Left') && clickBody.includes('$r.Right') && clickBody.includes('$r.Top') && clickBody.includes('$r.Bottom'),
  'click must check if coordinates are already within window bounds to prevent double-adding'
)
assert.ok(
  clickBody.includes('Get-OverlayPoint-WindowCenter $win'),
  'click must fall back to window center if coordinates are (0,0) or missing'
)

// 1d. click_element notifies cursor in both background and foreground
const clickElStart = helperSrc.indexOf("'click_element' {")
const clickElEnd = helperSrc.indexOf("'set_value' {", clickElStart)
const clickElBody = helperSrc.slice(clickElStart, clickElEnd)

assert.ok(
  clickElBody.includes("Notify-Cursor -X (Safe-Int ($elRect.X + $elRect.Width / 2)) -Y (Safe-Int ($elRect.Y + $elRect.Height / 2)) -Label ('click element ' + $element)"),
  'click_element must call Notify-Cursor with element center'
)

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
  const openRes = await tool.execute({ action: 'open_app', name: 'notepad' })
  assert.equal(openRes.ok, true, `open_app notepad failed: ${JSON.stringify(openRes)}`)
  notepadPid = openRes.pid
  notepadHwnd = openRes.hwnd
  assert.ok(Number.isInteger(notepadPid) && notepadPid > 0, 'open_app must return valid pid')
  assert.ok(Number.isInteger(notepadHwnd) && notepadHwnd > 0, 'open_app must return valid hwnd')

  // Verify the newly opened window did NOT steal foreground
  const gwInit = await tool.execute({ action: 'get_window', hwnd: notepadHwnd })
  assert.equal(gwInit.ok, true, 'get_window on scratch notepad must succeed')
  assert.equal(gwInit.window.foreground, false, 'scratch notepad launched silently must NOT be in foreground')

  // 2b. Test get_app_state: verify elements have both rect and screen_rect
  const stateRes = await tool.execute({ action: 'get_app_state', app: String(notepadPid), screenshot: false })
  assert.equal(stateRes.ok, true, 'get_app_state must succeed')
  assert.ok(Array.isArray(stateRes.elements) && stateRes.elements.length > 0, 'elements must not be empty')
  const el0 = stateRes.elements[0]
  assert.ok(el0.rect && typeof el0.rect.x === 'number' && typeof el0.rect.y === 'number', 'element must have rect {x, y}')
  assert.ok(el0.screen_rect && typeof el0.screen_rect.x === 'number' && typeof el0.screen_rect.y === 'number', 'element must have screen_rect {x, y}')

  // 2c. Test click with element parameter: verify resolved coordinates are NOT (0,0) and match element center
  const clickElemRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    element: el0.index,
    dispatch: 'background',
    overlay: false
  })
  assert.equal(clickElemRes.ok, true, `click with element must succeed: ${JSON.stringify(clickElemRes)}`)
  assert.ok(clickElemRes.clicked, 'click with element must return clicked coordinates')
  assert.ok(clickElemRes.clicked.x > 0 && clickElemRes.clicked.y > 0, 'click with element must NOT be at (0,0)')
  // Verify clicked coordinates match the element center in screen space
  const expectedCenterX = Math.floor(el0.screen_rect.x + el0.screen_rect.width / 2)
  const expectedCenterY = Math.floor(el0.screen_rect.y + el0.screen_rect.height / 2)
  assert.ok(
    Math.abs(clickElemRes.clicked.x - expectedCenterX) <= 2,
    `clicked X ${clickElemRes.clicked.x} must match element center ${expectedCenterX}`
  )
  assert.ok(
    Math.abs(clickElemRes.clicked.y - expectedCenterY) <= 2,
    `clicked Y ${clickElemRes.clicked.y} must match element center ${expectedCenterY}`
  )

  // 2d. Test click without coordinates or element: falls back to window center (never 0,0)
  const clickCenterRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    dispatch: 'background',
    overlay: false
  })
  assert.equal(clickCenterRes.ok, true, 'click without coordinates must succeed')
  assert.ok(clickCenterRes.clicked.x > 0 && clickCenterRes.clicked.y > 0, 'click without coordinates must NOT be at (0,0)')
  const curGw = await tool.execute({ action: 'get_window', hwnd: notepadHwnd })
  const winRect = curGw.rect
  const winCenterX = Math.floor(winRect.x + winRect.width / 2)
  const winCenterY = Math.floor(winRect.y + winRect.height / 2)
  assert.ok(
    Math.abs(clickCenterRes.clicked.x - winCenterX) <= 5,
    `clicked X ${clickCenterRes.clicked.x} must match window center ${winCenterX}`
  )
  assert.ok(
    Math.abs(clickCenterRes.clicked.y - winCenterY) <= 5,
    `clicked Y ${clickCenterRes.clicked.y} must match window center ${winCenterY}`
  )

  // 2e. Test click with screen coordinates: verify no double-adding
  const testSx = winCenterX
  const testSy = winCenterY
  const clickScreenRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    x: testSx,
    y: testSy,
    dispatch: 'background',
    overlay: false
  })
  assert.equal(clickScreenRes.ok, true, 'click with screen coordinates must succeed')
  assert.equal(clickScreenRes.clicked.x, testSx, 'click with screen coords must preserve screen X without double-adding')
  assert.equal(clickScreenRes.clicked.y, testSy, 'click with screen coords must preserve screen Y without double-adding')

  // 2f. Test click with window-local coordinates: verify proper offset to screen
  const localX = 50
  const localY = 60
  const clickLocalRes = await tool.execute({
    action: 'click',
    app: String(notepadPid),
    x: localX,
    y: localY,
    dispatch: 'background',
    overlay: false
  })
  assert.equal(clickLocalRes.ok, true, 'click with local coordinates must succeed')
  assert.equal(clickLocalRes.clicked.x, winRect.x + localX, 'local X must be offset by window Left')
  assert.equal(clickLocalRes.clicked.y, winRect.y + localY, 'local Y must be offset by window Top')

} finally {
  if (notepadPid > 0) {
    try { execSync(`taskkill /PID ${notepadPid} /F 2>nul || exit 0`, { timeout: 10000 }) } catch { /* ignore */ }
  }
  stopDaemon()
}

console.log('fix-validation check PASSED')
