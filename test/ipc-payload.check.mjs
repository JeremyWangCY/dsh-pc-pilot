import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAction, defineComputerTool } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const indexPath = path.join(rootDir, 'lib', 'index.js')
const helperPath = path.join(rootDir, 'lib', 'computer-use-helper.ps1')
const patchPath = path.join(rootDir, 'cordis.patch.yml')

// 1. Export verification
assert.equal(typeof runAction, 'function', 'runAction must be exported as a function')
assert.equal(typeof defineComputerTool, 'function', 'defineComputerTool must be exported as a function')

// 2. Static source contract checks
const indexSrc = fs.readFileSync(indexPath, 'utf8')
const helperSrc = fs.readFileSync(helperPath, 'utf8')
const patchSrc = fs.readFileSync(patchPath, 'utf8')

// cordis.patch.yml naming check
assert.match(
  patchSrc,
  /name:\s*dsh-pc-pilot/,
  'cordis.patch.yml must specify name: dsh-pc-pilot'
)

// lib/index.js stdin streaming checks
assert.ok(
  indexSrc.includes("stdio: ['pipe', 'pipe', 'pipe']"),
  "lib/index.js spawn must use stdio: ['pipe', 'pipe', 'pipe']"
)
assert.ok(
  indexSrc.includes("'-PayloadStdin'"),
  "lib/index.js spawn arguments must include '-PayloadStdin'"
)
assert.ok(
  !indexSrc.includes("'-PayloadJson'"),
  "lib/index.js spawn arguments must not pass '-PayloadJson'"
)
assert.ok(
  indexSrc.includes("child.stdin.end(JSON.stringify(args || {}), 'utf8')"),
  'lib/index.js must stream serialized JSON via child.stdin.end'
)
assert.ok(
  indexSrc.includes("child.stdin.on('error'"),
  "lib/index.js must protect child.stdin with an error handler"
)

// lib/computer-use-helper.ps1 parameter & encoding checks
assert.ok(
  helperSrc.includes('[switch]$PayloadStdin'),
  'computer-use-helper.ps1 must declare [switch]$PayloadStdin parameter'
)
assert.ok(
  helperSrc.includes('[Console]::InputEncoding = [System.Text.Encoding]::UTF8'),
  'computer-use-helper.ps1 must set [Console]::InputEncoding to UTF-8'
)
assert.ok(
  helperSrc.includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'),
  'computer-use-helper.ps1 must set [Console]::OutputEncoding to UTF-8'
)
assert.ok(
  helperSrc.includes('[Console]::In.ReadToEnd()'),
  'computer-use-helper.ps1 must read stdin via [Console]::In.ReadToEnd()'
)

// lib/computer-use-helper.ps1 scroll WM_MOUSEWHEEL & dead overload checks
assert.match(
  helperSrc,
  /SendMessageTimeout\(\$h,\s*0x020A,\s*\$wParam,\s*\$lParam,\s*\[DshWin32\]::SMTO_ABORTIFHUNG,\s*3000,\s*\[ref\]\$res\)/,
  'WM_MOUSEWHEEL scroll path must use SendMessageTimeout with SMTO_ABORTIFHUNG and 3000ms timeout'
)
assert.ok(
  !helperSrc.includes('public static IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)'),
  'Dead 4-argument SendMessageTimeout overload in DshWin32 must be removed'
)

// 3. Verification: unchunked set_value vs chunked type in execute
const tool = defineComputerTool((def) => def)
assert.equal(tool.name, 'computer')
assert.equal(typeof tool.execute, 'function')

// Verify set_value is NEVER chunked, even with large values (>6000 chars)
const largeVal = 'A'.repeat(12000)
const setValueRes = await tool.execute({
  action: 'set_value',
  app: '__dsh_test_nonexistent_window_12345__',
  element: 0,
  value: largeVal,
})
assert.equal(
  'chunks' in setValueRes,
  false,
  'set_value execute must never attach chunks property (must not be chunked)'
)
assert.equal(setValueRes.action, 'set_value')

// Verify type still chunks long text
const largeText = 'B'.repeat(12000)
const typeRes = await tool.execute({
  action: 'type',
  app: '__dsh_test_nonexistent_window_12345__',
  text: largeText,
})
assert.ok(
  'chunks' in typeRes && typeRes.chunks >= 1,
  'type execute must chunk long text when length > 6000'
)

// 4. Verification: Stdin streaming with large (>80KB) JSON payload & Unicode/emoji preservation
const unicodeSignature = '🚀_🌟_Unicode_测试_€_©_🤖_🎉'
// >85KB payload: would fail Windows command-line limit (~32KB) if passed on argv
const largePayloadString = unicodeSignature + '_PADDING_' + 'Z'.repeat(88000)

const streamRes = await runAction('get_app_state', {
  app: largePayloadString,
  window_index: 1,
})

assert.ok(streamRes, 'runAction should return a valid response')
assert.equal(streamRes.ok, false, 'Expected app_not_found for synthetic test app name')
assert.equal(typeof streamRes.message, 'string')
assert.ok(
  streamRes.message.includes('app_not_found:'),
  'Expected app_not_found error message'
)
assert.ok(
  streamRes.message.includes(unicodeSignature),
  'Unicode characters and emojis must be preserved exactly through stdin/stdout round-trip'
)
assert.ok(
  streamRes.message.length > 88000,
  'Large (>80KB) payload must be completely transmitted without truncation'
)

// 5. Verification: -PayloadJson fallback continues to work
const psCmd = 'powershell.exe'
const fallbackOut = execFileSync(psCmd, [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', helperPath,
  '-Action', 'list_apps',
  '-PayloadJson', JSON.stringify({ test_fallback: true }),
], { encoding: 'utf8' })

const fallbackParsed = JSON.parse(fallbackOut.trim())
assert.equal(fallbackParsed.ok, true, '-PayloadJson fallback should execute list_apps successfully')
assert.equal(fallbackParsed.action, 'list_apps')

console.log('ipc-payload check PASSED')
