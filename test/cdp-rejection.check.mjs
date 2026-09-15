import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { browserAction } from '../lib/browser-session.js'

// The v0.4.2/v0.4.4 CI flake was an intermittent process exit 1 whose reason was
// constructed at the CDP error path (`CDP command rejected`). This check pins the
// invariant instead of the symptom: no rejection produced by the CDP client may
// ever escape as an unhandled rejection, including a fire-and-forget command on a
// connection that is already dead.
const escaped = []
const onUnhandled = (reason) => escaped.push(String(reason && reason.message ? reason.message : reason))
process.on('unhandledRejection', onUnhandled)

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64')

function textFrame(text) {
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
function decodeClientFrame(buffer) {
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

// Every command is answered with a CDP protocol error, which is exactly what the
// failing CI runs produced on the real Edge session.
const server = http.createServer()
server.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'] || '')}\r\n\r\n`)
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
await once(server, 'listening')

const endpoint = `ws://127.0.0.1:${server.address().port}/devtools/browser/injected`

try {
  // 1. An awaited command that receives a CDP error must reject for the caller.
  await assert.rejects(
    browserAction('browser_state', { browser_endpoint: endpoint, command_timeout_ms: 2000 }),
    /CDP command rejected/,
    'a CDP error response must reject the awaiting caller',
  )

  // 2. The same connection is now poisoned; repeated fire-and-forget commands on
  //    the dead path must not escape. Calling without awaiting is deliberate.
  for (let i = 0; i < 5; i++) {
    browserAction('browser_state', { browser_endpoint: endpoint, command_timeout_ms: 2000 }).catch(() => {})
  }
  browserAction('browser_tabs', { browser_endpoint: endpoint })

  // 3. Let every queued microtask and timer deliver before judging.
  await new Promise((resolve) => setTimeout(resolve, 250))

  assert.deepEqual(escaped, [], 'no CDP rejection may escape as an unhandled rejection')
  console.log('cdp rejection check PASSED')
} finally {
  process.off('unhandledRejection', onUnhandled)
  await new Promise((resolve) => server.close(resolve))
}
