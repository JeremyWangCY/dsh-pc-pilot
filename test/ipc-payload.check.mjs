import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAction, defineComputerTool } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const indexPath = path.join(rootDir, 'lib', 'index.js')
const helperPath = path.join(rootDir, 'lib', 'pc-pilot-helper.ps1')
const patchPath = path.join(rootDir, 'cordis.patch.yml')

// 1. Export & schema verification
assert.equal(typeof runAction, 'function', 'runAction must be exported as a function')
assert.equal(typeof defineComputerTool, 'function', 'defineComputerTool must be exported as a function')

const bareTool = defineComputerTool()
assert.ok(bareTool.parameters.properties, 'defineComputerTool().parameters must have properties object')
assert.ok(bareTool.parameters.properties.name, 'name property must be present in defineComputerTool().parameters.properties')
assert.equal(bareTool.parameters.properties.name.type, 'string')
assert.match(
  bareTool.parameters.properties.name.description,
  /Application name, executable path, or registered Windows activation protocol/,
  'launch_app name schema must document Windows activation protocol support'
)

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
  indexSrc.includes("child.stdin.end(stringifyHelperJson(args || {}), 'ascii')"),
  'lib/index.js must stream ASCII-safe JSON via child.stdin.end'
)
assert.ok(
  indexSrc.includes('function stringifyHelperJson(value)')
    && indexSrc.includes("padStart(4, '0')"),
  'lib/index.js must escape non-ASCII JSON code units for Windows PowerShell 5.1'
)
assert.ok(
  indexSrc.includes("child.stdin.on('error'"),
  "lib/index.js must protect child.stdin with an error handler"
)

// lib/pc-pilot-helper.ps1 parameter & encoding checks
assert.equal(
  helperSrc.charCodeAt(0),
  0xFEFF,
  'pc-pilot-helper.ps1 must carry a UTF-8 BOM for Windows PowerShell 5.1 source decoding'
)
assert.ok(
  helperSrc.includes('[switch]$PayloadStdin'),
  'pc-pilot-helper.ps1 must declare [switch]$PayloadStdin parameter'
)
assert.ok(
  helperSrc.includes('[Console]::InputEncoding = [System.Text.Encoding]::UTF8'),
  'pc-pilot-helper.ps1 must set [Console]::InputEncoding to UTF-8'
)
assert.ok(
  helperSrc.includes('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8'),
  'pc-pilot-helper.ps1 must set [Console]::OutputEncoding to UTF-8'
)
assert.ok(
  helperSrc.includes('[PcPilotDeadline]::ReadUtf8ToEnd()')
    && helperSrc.includes('Console.OpenStandardInput()'),
  'pc-pilot-helper.ps1 must decode redirected stdin explicitly as UTF-8'
)
assert.ok(
  helperSrc.includes('Console.OpenStandardOutput()')
    && helperSrc.includes('new UTF8Encoding(false).GetBytes'),
  'pc-pilot-helper.ps1 must encode JSON stdout explicitly as UTF-8'
)

// lib/pc-pilot-helper.ps1 scroll WM_MOUSEWHEEL & dead overload checks
assert.match(
  helperSrc,
  /SendMessageTimeout\(\$h,\s*0x020A,\s*\$wParam,\s*\$lParam,\s*\[DshWin32\]::SMTO_ABORTIFHUNG,\s*3000,\s*\[ref\]\$res\)/,
  'WM_MOUSEWHEEL scroll path must use SendMessageTimeout with SMTO_ABORTIFHUNG and 3000ms timeout'
)
assert.ok(
  !helperSrc.includes('public static IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)'),
  'Dead 4-argument SendMessageTimeout overload in DshWin32 must be removed'
)

// 3. Verification: unchunked set_value and direct execution of type without chunking
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

// Verify type is also directly executed WITHOUT chunking
const largeText = 'B'.repeat(12000)
const typeRes = await tool.execute({
  action: 'type_text',
  app: '__dsh_test_nonexistent_window_12345__',
  text: largeText,
})
assert.equal(
  'chunks' in typeRes,
  false,
  'type_text execute must directly execute without chunking loop'
)
assert.equal(typeRes.action, 'type_text')

// 4. Verification: Stdin streaming with large (>80KB) JSON payload & Unicode/emoji preservation.
// Use a deterministic validation error before any desktop/window access so hosted CI and interactive PCs exercise the same transport path.
const unicodeSignature = '??_??_Unicode_??_?_?_??_??'
// >85KB payload: would fail Windows command-line limit (~32KB) if passed on argv
const largePayloadString = unicodeSignature + '_PADDING_' + '7'.repeat(88000)

const streamRes = await runAction('mouse_down', {
  button: largePayloadString,
})

assert.ok(streamRes, 'runAction should return a valid response')
assert.equal(streamRes.ok, false, 'Expected deterministic invalid mouse button rejection')
assert.equal(typeof streamRes.message, 'string')
const transportProbeValidated = streamRes.message.startsWith('invalid mouse button:')
if (!transportProbeValidated) {
  console.error('IPC transport probe diagnostic:', JSON.stringify({
    messagePrefix: streamRes.message.slice(0, 240),
    messageLength: streamRes.message.length,
    errorCode: streamRes.error_code,
    outcome: streamRes.outcome,
    exitCode: streamRes.exitCode,
    stderrPrefix: typeof streamRes.stderr === 'string' ? streamRes.stderr.slice(0, 1200) : '',
    keys: Object.keys(streamRes),
  }))
}
assert.ok(
  transportProbeValidated,
  'Transport probe must fail at button validation before any desktop access'
)
// This check is only about stdin/stdout fidelity after deterministic validation.
assert.ok(
  streamRes.message.toLowerCase().includes(unicodeSignature.toLowerCase()),
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

// 6. Verification: Invalid JSON sent to helper stdin returns clean { ok: false, message: ... }
const invalidJsonOut = execFileSync(psCmd, [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', helperPath,
  '-Action', 'list_apps',
  '-PayloadStdin',
], {
  input: '{ invalid: json syntax',
  encoding: 'utf8',
})

const invalidParsed = JSON.parse(invalidJsonOut.trim())
assert.equal(invalidParsed.ok, false, 'Invalid JSON sent to stdin must return ok: false')
assert.equal(invalidParsed.action, 'list_apps')
assert.ok(
  typeof invalidParsed.message === 'string' && invalidParsed.message.includes('Invalid JSON payload'),
  'Invalid JSON message must indicate Invalid JSON payload'
)

console.log('ipc-payload check PASSED')
