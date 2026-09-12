import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const isWindows = process.platform === 'win32'
const packed = JSON.parse(execFileSync(
  isWindows ? (process.env.ComSpec || 'cmd.exe') : 'npm',
  isWindows ? ['/d', '/s', '/c', 'npm pack --dry-run --json'] : ['pack', '--dry-run', '--json'],
  {
  encoding: 'utf8',
  windowsHide: true,
  }
))
const paths = new Set(packed[0]?.files?.map((file) => file.path) || [])

assert.ok(paths.has('lib/wgc/dsh-pc-pilot-wgc.exe'), 'runtime WGC executable must be packaged')
assert.ok(!paths.has('lib/wgc/dsh-pc-pilot-wgc.pdb'), 'debug PDB must not be packaged')
for (const file of paths) {
  assert.ok(!file.startsWith('artifacts/'), `diagnostic artifact must not be packaged: ${file}`)
  assert.ok(!/(^|\/)scripts\/.*bili/i.test(file), `one-off Bilibili script must not be packaged: ${file}`)
}

console.log(`package contents check PASSED (${paths.size} files)`)
