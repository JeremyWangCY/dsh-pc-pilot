import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const helper = fileURLToPath(new URL('../lib/pc-pilot-helper.ps1', import.meta.url))
async function invoke(action, payloadArgs, input, expectedExit = 0) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Action', action, ...payloadArgs], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', d => { stdout += d })
  child.stderr.on('data', d => { stderr += d })
  child.stdin.on('error', () => {})
  if (input !== undefined) child.stdin.end(input)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${action} blocked with explicit JSON and open stdin`))
    }, 8000)
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      try { assert.equal(code, expectedExit, stderr); resolve(JSON.parse(stdout)) } catch (e) { reject(e) }
    })
  })
}
// Keep stdin OPEN deliberately: this catches the inherited-pipe deadlock.
for (const action of ['get_window', 'click', 'type']) {
  const reply = await invoke(action, ['-PayloadJson', JSON.stringify({ app: 'pc-pilot-nonexistent-fixture-93852', text: 'test' })])
  assert.equal(reply.ok, false)
  assert.equal(reply.action, action)
}
const reply = await invoke('list_apps', ['-PayloadStdin'], '{}')
assert.equal(reply.ok, true)
const timed = await invoke('wait', ['-TimeoutMs', '500', '-PayloadJson', '{"duration_s":5}'], undefined, 124)
assert.equal(timed.ok, false)
assert.equal(timed.error_code, 'action_timeout')
assert.equal(timed.outcome, 'unknown')
assert.equal(timed.retry_safe, false)
const helperSource = await (await import('node:fs/promises')).readFile(helper, 'utf8')
assert.match(helperSource, /if \(-not \$Server\) \{[\s\S]*?\[PcPilotDeadline\]::Start/, 'watchdog must be one-shot only and never kill the daemon')
console.log('PASS: explicit JSON ignores open stdin; stdin transport works; real helper watchdog terminates blocked action')
