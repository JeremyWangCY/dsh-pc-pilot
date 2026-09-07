import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runAction, extractHelperJson } from '../lib/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

const helperPath = path.join(rootDir, 'lib', 'computer-use-helper.ps1')
const indexPath = path.join(rootDir, 'lib', 'index.js')

const helperSrc = fs.readFileSync(helperPath, 'utf8')
const indexSrc = fs.readFileSync(indexPath, 'utf8')

// ---------------------------------------------------------------- 1. lib/index.js portability
assert.ok(
  indexSrc.includes("process.env.SystemRoot || 'C:\\\\Windows'"),
  'lib/index.js must derive the Windows directory from process.env.SystemRoot with a C:\\Windows fallback'
)
assert.ok(
  indexSrc.includes("path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')"),
  'PS_EXE must be built with path.join from SYSTEM_ROOT'
)
assert.ok(
  indexSrc.includes('cwd: SYSTEM_ROOT'),
  'spawn cwd must use SYSTEM_ROOT instead of a hardcoded C:\\Windows'
)
assert.ok(
  !indexSrc.includes("'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"),
  'hardcoded PS_EXE literal must be removed'
)

// Functional: runAction spawns the SystemRoot-derived PS_EXE and parses the reply
const listRes = await runAction('list_apps', {})
assert.ok(listRes, 'runAction(list_apps) should return a parsed reply')
assert.equal(listRes.ok, true, 'runAction(list_apps) should succeed via SystemRoot-derived powershell path')
assert.equal(listRes.action, 'list_apps')

// ---------------------------------------------------------------- 2. resilient JSON extraction
assert.equal(typeof extractHelperJson, 'function', 'extractHelperJson must be exported')

const clean = extractHelperJson('{"ok":true,"action":"list_apps"}')
assert.ok(clean && clean.ok === true, 'clean JSON stdout must parse directly')

const noisy = extractHelperJson(
  'PowerShell banner\nWARNING: some profile noise\n{"ok":false,"action":"click_element","message":"app_not_found: x"}'
)
assert.ok(noisy, 'JSON must be recovered when noise precedes it on stdout')
assert.equal(noisy.ok, false)
assert.equal(noisy.action, 'click_element')
assert.equal(noisy.message, 'app_not_found: x')

const bracesInStrings = extractHelperJson('noise {\nline\n{"a":"value with {braces} inside"}')
assert.ok(bracesInStrings && bracesInStrings.a === 'value with {braces} inside',
  'outermost { } block extraction must tolerate braces inside JSON string values')

assert.equal(extractHelperJson('no structured output here'), null, 'non-JSON stdout must yield null')
assert.equal(extractHelperJson('noise { broken'), null, 'unparseable JSON block must yield null')
assert.equal(extractHelperJson(''), null, 'empty stdout must yield null')

// ---------------------------------------------------------------- 3. helper fixes (static)
// ForceForeground thread-id bug: GetWindowThreadProcessId returns THREAD id; out param is PROCESS id
assert.ok(
  helperSrc.includes('uint fgPid; uint fgTid = GetWindowThreadProcessId(f, out fgPid);'),
  'ForceForeground must capture the foreground THREAD id from the return value'
)
assert.ok(
  helperSrc.includes('uint curPid; uint curTid = GetWindowThreadProcessId(h, out curPid);'),
  'ForceForeground must capture the target THREAD id from the return value'
)
assert.match(
  helperSrc,
  /if \(fgTid != 0 && curTid != 0 && fgTid != curTid\) AttachThreadInput\(curTid, fgTid, true\);/,
  'AttachThreadInput(attach) must use thread ids with zero guards'
)
assert.match(
  helperSrc,
  /if \(fgTid != 0 && curTid != 0 && fgTid != curTid\) AttachThreadInput\(curTid, fgTid, false\);/,
  'AttachThreadInput(detach) must use thread ids with zero guards'
)
assert.ok(
  !helperSrc.includes('GetWindowThreadProcessId(f, out fgTid)') &&
  !helperSrc.includes('GetWindowThreadProcessId(h, out hTid)'),
  'old thread-id-from-out-param bug must be gone'
)

// Parent traversal hop limits in BOTH Test-ElementInWindow and Find-TextInputHwnd
function functionBody(src, name) {
  const marker = 'function ' + name
  const start = src.indexOf(marker)
  assert.ok(start >= 0, 'function ' + name + ' must exist in helper')
  const bodyStart = src.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces around ' + name)
}
const testElBody = functionBody(helperSrc, 'Test-ElementInWindow')
const findInputBody = functionBody(helperSrc, 'Find-TextInputHwnd')
assert.match(testElBody, /while \(\$curr -and \$hops -lt 32\)/,
  'Test-ElementInWindow parent walk must be capped at 32 hops')
assert.match(testElBody, /\$hops\+\+/)
assert.match(findInputBody, /while \(\$curr -and \$hops -lt 32\)/,
  'Find-TextInputHwnd parent walk must be capped at 32 hops')
assert.match(findInputBody, /\$hops\+\+/)

// click_element cursor notification fires for ALL interaction patterns
const clickElStart = helperSrc.indexOf("'click_element' {")
const clickElEnd = helperSrc.indexOf("'set_value' {", clickElStart)
const clickElBody = helperSrc.slice(clickElStart, clickElEnd)
assert.ok(clickElBody.includes('cursor indicator for ALL element interaction patterns'),
  'click_element must document the all-patterns cursor notification')
assert.match(
  clickElBody,
  /\$el = Find-ElementByIndex[\s\S]*?if \(\$dispatch -eq 'background'\) \{[\s\S]*?Notify-Cursor[\s\S]*?\}[\s\S]*?\$ip = \$null[\s\S]*?InvokePattern/,
  'Notify-Cursor must fire before pattern dispatch (Invoke/Toggle/Selection/ExpandCollapse), from the element bounding rect'
)
assert.ok(
  !clickElBody.includes("Notify-Cursor -X (Safe-Int ($el.Current.BoundingRectangle.X"),
  'InvokePattern-branch-only cursor notification must be removed'
)
assert.ok(
  clickElBody.indexOf('Notify-Cursor') < clickElBody.indexOf('InvokePattern]::Pattern'),
  'cursor notification must precede the InvokePattern dispatch in click_element'
)

// open_app argument support
assert.ok(helperSrc.includes('function Split-AppCommand'),
  'helper must define Split-AppCommand for open_app argument handling')
const openAppStart = helperSrc.indexOf("'open_app' {")
const openAppEnd = helperSrc.indexOf('default {', openAppStart)
const openAppBody = helperSrc.slice(openAppStart, openAppEnd)
assert.match(openAppBody, /Split-AppCommand -Name/, 'open_app must split name via Split-AppCommand')
assert.match(openAppBody, /Start-Process -FilePath \$filePath -ArgumentList \$argList -PassThru/,
  'open_app must pass ArgumentList when arguments are present')
assert.match(openAppBody, /Start-Process -FilePath \$filePath -PassThru/,
  'open_app must still support argument-less launches')

// ---------------------------------------------------------------- 4. Split-AppCommand behavior (PowerShell)
function extractFunction(name) {
  const start = helperSrc.indexOf('function ' + name)
  assert.ok(start >= 0, 'function ' + name + ' found')
  let depth = 0
  const bodyStart = helperSrc.indexOf('{', start)
  for (let i = bodyStart; i < helperSrc.length; i++) {
    if (helperSrc[i] === '{') depth++
    else if (helperSrc[i] === '}') {
      depth--
      if (depth === 0) return helperSrc.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced braces around ' + name)
}

const fnFile = path.join(os.tmpdir(), 'dsh-round4-splitappcmd.ps1')
fs.writeFileSync(fnFile, extractFunction('Split-AppCommand'), 'utf8')

const psTest = `
. '${fnFile.replace(/'/g, "''")}'
$r1 = Split-AppCommand -Name 'notepad.exe C:\\foo.txt'
if ($r1[0] -ne 'notepad.exe') { exit 10 }
if ($r1[1].Count -ne 1 -or $r1[1][0] -ne 'C:\\foo.txt') { exit 11 }
$r2 = Split-AppCommand -Name '"C:\\Program Files\\App\\app.exe" --flag "some arg"'
if ($r2[0] -ne 'C:\\Program Files\\App\\app.exe') { exit 12 }
if ($r2[1].Count -ne 2 -or $r2[1][0] -ne '--flag' -or $r2[1][1] -ne 'some arg') { exit 13 }
$r3 = Split-AppCommand -Name 'notepad'
# bare name resolves to the real PATH location (Start-Process fails on bare names);
# falls back to the literal name only when the exe cannot be found on PATH
if ($r3[0] -notmatch 'notepad(\.exe)?') { exit 14 }
if ($r3[1].Count -ne 0) { exit 15 }
$dir = Join-Path $env:TEMP ('dsh-openapp-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $dir -Force
try {
  $exe = Join-Path $dir 'my spaced app.exe'
  Set-Content -Path $exe -Value ''
  $r4 = Split-AppCommand -Name ($exe + ' --go now')
  if ($r4[0] -ne $exe) { exit 16 }
  if ($r4[1].Count -ne 2 -or $r4[1][0] -ne '--go' -or $r4[1][1] -ne 'now') { exit 17 }
  $r5 = Split-AppCommand -Name ('"' + $exe + '"')
  if ($r5[0] -ne $exe) { exit 18 }
  if ($r5[1].Count -ne 0) { exit 19 }
} finally {
  Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
`
try {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psTest], { stdio: 'inherit' })
} finally {
  try { fs.unlinkSync(fnFile) } catch { /* temp cleanup best-effort */ }
}

// ---------------------------------------------------------------- 5. PowerShell AST parse of the helper
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  `$errs = @(); $tokens = $null; ` +
  `[void][System.Management.Automation.Language.Parser]::ParseFile('${helperPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errs); ` +
  `if ($errs.Count -gt 0) { $errs | ForEach-Object { Write-Host $_.Message } ; exit 1 } else { exit 0 }`,
], { stdio: 'inherit' })

console.log('round4-hardening check PASSED')
