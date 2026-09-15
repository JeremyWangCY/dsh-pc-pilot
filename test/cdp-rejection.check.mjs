import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A CDP protocol error is control flow for whoever awaits it, but callers are
// allowed to fire and forget. Node makes an unobserved rejection fatal, and that
// is exactly how one intermittent "CDP command rejected" killed the v0.4.2 tag
// run, the 0.4.4 main run and the v0.4.4 tag run across two different branches.
//
// The invariant is verified end to end in a CHILD process that installs no
// unhandledRejection handler of its own. If the plugin's own guard did not hold,
// the child would die with a non-zero exit code and this check would fail. That
// is deliberate: a same-process handler would mask the very bug under test.
const libraryUrl = new URL('../lib/browser-session.js', import.meta.url).href
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const childSource = `
import fs from 'node:fs'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { browserAction } from ${JSON.stringify(libraryUrl)}

// A CDP endpoint that answers every command with a protocol error, which is
// exactly what the failing CI runs produced against a real Edge session.
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64')

function textFrame (text) {
  const payload = Buffer.from(text, 'utf8')
  const length = payload.length
  if (length < 126) return Buffer.concat([Buffer.from([0x81, length]), payload])
  if (length < 65536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(length), 2)
  return Buffer.concat([header, payload])
}

// Minimal client-frame reader: masked text frames carrying { id, method } JSON.
function decodeClientFrame (buffer) {
  if (buffer.length < 2) return null
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (opcode === 0x8) return { consumed: offset + (masked ? 4 : 0) + length, close: true }
  if (!masked) return null
  if (buffer.length < offset + 4 + length) return null
  const mask = buffer.subarray(offset, offset + 4)
  offset += 4
  const payload = Buffer.alloc(length)
  for (let i = 0; i < length; i++) payload[i] = buffer[offset + i] ^ mask[i % 4]
  const consumed = offset + length
  let id
  try { id = JSON.parse(payload.toString('utf8')).id } catch { id = undefined }
  return { id, consumed }
}

const server = http.createServer()
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n'
    + 'Sec-WebSocket-Accept: ' + acceptKey(req.headers['sec-websocket-key'] || '') + '\\r\\n\\r\\n')
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const frame = decodeClientFrame(buffer)
      if (!frame) break
      buffer = buffer.subarray(frame.consumed)
      if (frame.close || frame.id === undefined) continue
      socket.write(textFrame(JSON.stringify({ id: frame.id, error: { code: -32000, message: 'injected' } })))
    }
  })
  socket.on('error', () => {})
})
server.listen(0, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const endpoint = 'ws://127.0.0.1:' + server.address().port + '/devtools/browser/injected'

// 1. An awaited command must still reject with the protocol error for its caller.
let awaitedRejected = false
try {
  await browserAction('browser_state', { browser_endpoint: endpoint, command_timeout_ms: 2000 })
} catch (error) {
  awaitedRejected = /CDP command rejected/.test(String(error && error.message))
}
if (!awaitedRejected) {
  process.stderr.write('awaited command did not reject as expected\\n')
  process.exit(3)
}

// 2. Fire-and-forget commands on the now-poisoned connection must not be fatal.
//    They are spaced out because browserAction serializes on a per-endpoint lock,
//    and a lock conflict is a separate synchronous failure mode rather than the
//    CDP rejection under test.
for (let i = 0; i < 5; i++) {
  browserAction('browser_state', { browser_endpoint: endpoint, command_timeout_ms: 2000 })
  await new Promise((resolve) => setTimeout(resolve, 300))
}
browserAction('browser_tabs', { browser_endpoint: endpoint })
await new Promise((resolve) => setTimeout(resolve, 300))

// 3. Give every microtask, timer and socket teardown a chance to deliver.
await new Promise((resolve) => setTimeout(resolve, 500))

// Synchronous write so the marker survives the hard exit that follows.
fs.writeSync(1, 'child survived\\n')
process.exit(0)
`

let code = 0
let stdout = ''
let stderr = ''
try {
  stdout = execFileSync(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  })
} catch (error) {
  code = typeof error.status === 'number' ? error.status : -1
  stdout = String(error.stdout || '')
  stderr = String(error.stderr || error.message || '')
}

assert.equal(
  code,
  0,
  `a CDP rejection must never be fatal: exit=${code}\nstdout=${stdout}\nstderr=${stderr}`,
)
assert.match(stdout, /child survived/, 'the child must reach the end of its script')
assert.ok(
  !/CDP command rejected/.test(stderr),
  `no CDP rejection may reach the top level:\n${stderr}`,
)

console.log('cdp rejection check PASSED')
