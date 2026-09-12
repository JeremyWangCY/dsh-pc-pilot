import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const executable = path.join(rootDir, 'lib', 'wgc', 'dsh-pc-pilot-wgc.exe')
const child = spawn(executable, ['--server'], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
})

const stderr = []
child.stderr.on('data', (chunk) => stderr.push(chunk))

try {
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.stdin.end()
  const exit = await Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('WGC server did not exit after stdin closed')), 5000)),
  ])
  assert.deepEqual(exit, { code: 0, signal: null }, `WGC server exit: ${JSON.stringify(exit)} stderr=${Buffer.concat(stderr).toString('utf8')}`)
  console.log('WGC server lifecycle check PASSED')
} finally {
  if (child.exitCode === null && !child.killed) child.kill()
}
