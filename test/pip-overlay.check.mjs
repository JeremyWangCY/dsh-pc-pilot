import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(__dirname, '..')

console.log('Running pip-overlay check...')

// 1. Verify pip-overlay.ps1 exists and has Apple design specifications
const pipPath = path.join(repoDir, 'lib', 'pip-overlay.ps1')
assert.ok(fs.existsSync(pipPath), 'pip-overlay.ps1 must exist in lib/')

const pipSrc = fs.readFileSync(pipPath, 'utf8')
assert.ok(pipSrc.includes('CornerRadius="16"'), 'Must have Apple 16px corner radius')
assert.ok(pipSrc.includes('Background="#E61C1C1E"'), 'Must use Apple dark frosted glass background')
assert.ok(pipSrc.includes('BtnClose') && pipSrc.includes('BtnMini') && pipSrc.includes('BtnExpand'), 'Must have 3 Apple traffic light buttons')
assert.ok(pipSrc.includes('#FF5F56') && pipSrc.includes('#FFBD2E') && pipSrc.includes('#27C93F'), 'Traffic lights must use genuine Apple hex colors')
assert.ok(pipSrc.includes('WS_EX_NOACTIVATE'), 'Must apply WS_EX_NOACTIVATE to prevent focus theft')
assert.ok(pipSrc.includes('Live'), 'Must include Live status pill')

// 2. Verify computer-use-helper.ps1 contains Notify-Pip and isolation actions
const helperPath = path.join(repoDir, 'lib', 'computer-use-helper.ps1')
const helperSrc = fs.readFileSync(helperPath, 'utf8')

assert.ok(helperSrc.includes('function Notify-Pip'), 'Helper must define Notify-Pip')
assert.ok(helperSrc.includes('function Ensure-PipOverlayProcess'), 'Helper must define Ensure-PipOverlayProcess')
assert.ok(helperSrc.includes("'toggle_pip'"), 'Helper must support toggle_pip action')
assert.ok(helperSrc.includes("'isolate_window'"), 'Helper must support isolate_window action')

// 3. Test PowerShell execution of pip-overlay script startup and state handling
const pwshCmd = `
\$pip = '${pipPath.replace(/'/g, "''")}'
\$proc = Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File', \$pip, '-HideOnStart') -PassThru
Start-Sleep -Milliseconds 800
Write-Output ('PID: ' + \$proc.Id)
if (-not \$proc.HasExited) {
  Stop-Process -Id \$proc.Id -Force
  Write-Output "PIP_CHECK_OK"
}
`

const pwshOut = execSync('powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "' + pwshCmd.replace(/\n/g, '; ') + '"', {
  encoding: 'utf8'
})

assert.ok(pwshOut.includes('PIP_CHECK_OK'), 'pip-overlay.ps1 must start and cleanly process lifecycle')

console.log('pip-overlay check PASSED')
