import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { browserAction } from '../lib/browser-session.js'

const edge = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
assert.ok(existsSync(edge), 'Set EDGE_PATH to a Chromium/Edge executable')
let submitted = ''
let likes = 0
const server = http.createServer(async (req, res) => {
  if (req.url === '/submit') {
    for await (const data of req) submitted += data
    res.end('ok')
    return
  }
  if (req.url === '/like') { likes++; res.end('ok'); return }
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><meta charset="utf-8"><form>
    <label>Message<input id="message" value="DO_NOT_EXPOSE_VALUE"></label>
    <input aria-label="Password" type="password" value="DO_NOT_EXPOSE_PASSWORD">
    <button type="button" id="like" aria-label="Like ${likes}">Like</button>
    <button type="button" id="rename">Rename</button>
    <button type="button" id="remove">Remove</button>
    <button type="button" id="rolechange">Role change</button>
    <button type="button" id="refresh">Refresh</button>
    <button type="button" id="spa">Change URL</button>
    <button type="button" id="victim">Victim</button>
    <button type="button" id="latest">Latest</button>
    <article id="scroll-target" style="margin-top:3000px">VISIBLE TARGET COMMENT</article></form><script>
    message.value = '';
    message.addEventListener('keydown', async e => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault(); await fetch('/submit', {method:'POST',body:message.value});
        message.setAttribute('aria-label','Submitted');
      }
    });
    like.onclick = async () => { await fetch('/like', {method:'POST'}); like.setAttribute('aria-label','Liked'); };
    rename.onclick = () => victim.textContent = 'Changed';
    remove.onclick = () => victim.remove();
    rolechange.onclick = () => victim.setAttribute('role','link');
    refresh.onclick = () => location.reload();
    spa.onclick = () => history.pushState({}, '', '/changed');
    latest.onclick = () => latest.textContent = 'Latest clicked';
    const host = document.createElement('div'); host.style.cssText='position:fixed;top:0;left:0'; document.body.append(host);
    host.attachShadow({mode:'open'}).innerHTML = '<input aria-label="Shadow editor"><button>Shadow button</button>';
    for(let i=0;i<1200;i++){const el=document.createElement('button');el.hidden=true;el.textContent='hidden';document.body.append(el)}
    </script>`)
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const profile = await mkdtemp(path.join(tmpdir(), 'pc-pilot-cdp-'))
let child
let control
let controlId = 0
const waits = new Map()
async function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++controlId
    const timer = setTimeout(() => { waits.delete(id); reject(new Error('Test CDP timeout')) }, 3000)
    waits.set(id, msg => { clearTimeout(timer); msg.error ? reject(new Error('Test CDP failed')) : resolve(msg.result) })
    control.send(JSON.stringify({ id, method, params }))
  })
}
const pause = () => new Promise(resolve => setTimeout(resolve, 75))
async function eventually(fn) {
  let last
  for (let i = 0; i < 40; i++) {
    try { return await fn() } catch (error) { last = error; await pause() }
  }
  throw last
}
try {
  child = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' })
  let launchError
  child.on('error', error => { launchError = error })
  const portFile = await eventually(async () => {
    if (launchError) throw launchError
    return readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')
  })
  const [port, socketPath] = portFile.trim().split(/\r?\n/)
  const browser_endpoint = `ws://127.0.0.1:${port}${socketPath}`
  control = new WebSocket(browser_endpoint)
  await once(control, 'open')
  control.addEventListener('message', event => {
    const msg = JSON.parse(event.data)
    const handler = waits.get(msg.id)
    if (handler) { waits.delete(msg.id); handler(msg) }
  })
  const { targetId: tab_id } = await command('Target.createTarget', {
    url: `http://127.0.0.1:${server.address().port}/`,
  })
  const { targetId: other } = await command('Target.createTarget', { url: 'about:blank' })
  const args = { browser_endpoint, tab_id, command_timeout_ms: 5000 }
  const state = () => browserAction('browser_state', args)
  const get = (s, name) => {
    const found = s.elements.find(x => x.name === name)
    assert.ok(found, `Missing fixture control: ${name}`)
    return found.element
  }
  const click = (element, options = {}) => browserAction('browser_click', { ...args, element, ...options })
  let s = await eventually(async () => { const value = await state(); get(value, 'Message'); return value })
  const visibleShadow = await browserAction('browser_state', { ...args, include_visible_text: true })
  assert.ok(visibleShadow.visible_text.includes('Shadow button'), 'visible text traverses open shadow roots')
  const scrolled = await browserAction('browser_scroll', { ...args, scroll_y: 120 })
  assert.equal(scrolled.ok, true)
  const textScrolled = await browserAction('browser_scroll_to_text', { ...args, text: 'VISIBLE TARGET COMMENT' })
  assert.equal(textScrolled.found, true)
  assert.equal((await browserAction('browser_scroll_to_text', { ...args, text: 'missing exact text' })).found, false)
  assert.ok((await browserAction('browser_state', { browser_endpoint })).pages.some(p => p.tab_id === tab_id))
  assert.ok(!JSON.stringify(s).includes('DO_NOT_EXPOSE'))
  const message = get(s, 'Message')
  get(s, 'Shadow button')
  assert.ok(s.elements.length < 20, 'hidden controls must not crowd out useful state')
  await browserAction('browser_replace', { ...args, element: get(s, 'Shadow editor'), text: 'shadow replacement' })
  assert.equal(get(await state(), 'Message'), message, 'tokens stable across state/connection')
  const typed = await browserAction('browser_type', { ...args, element: message, text: 'fixture secret 123' })
  assert.ok(typed.screenshot?.path && existsSync(typed.screenshot.path), 'browser mutation returns a fresh screenshot')
  assert.ok(!JSON.stringify(await state()).includes('fixture secret'))
  await assert.rejects(browserAction('browser_replace', { ...args, element: message, text: 'wrong', expected_url: 'https://wrong.invalid/' }), /URL changed/)
  await browserAction('browser_replace', { ...args, element: message, text: 'replacement text', expected_url: s.url })
  await browserAction('browser_key', { ...args, element: message, key: 'Ctrl+Enter' })
  await eventually(() => { assert.equal(submitted, 'replacement text'); return true })
  await click(get(s, 'Like 0'), { confirmation: 'approved' })
  await eventually(() => { assert.equal(likes, 1); return true })
  const victim = get(s, 'Victim')
  await click(get(s, 'Rename'))
  await assert.rejects(click(victim), /stale|rejected/i)
  s = await state()
  const changed = get(s, 'Changed')
  await click(get(s, 'Role change'))
  await assert.rejects(click(changed), /stale|rejected/i)
  s = await state()
  const newRole = get(s, 'Changed')
  assert.notEqual(newRole, changed)
  await browserAction('browser_click', { ...args, element: get(s, 'Remove'), confirmation: 'approved' })
  await assert.rejects(click(newRole), /stale|rejected/i)
  await assert.rejects(browserAction('browser_click', { ...args, tab_id: other, element: message }), /wrong-tab/)
  await assert.rejects(browserAction('browser_state', { ...args, tab_id: 'not-a-tab' }), /not found/)
  await assert.rejects(click('invented-token'), /Stale/)
  const oldRefresh = get(s, 'Refresh')
  await click(oldRefresh)
  s = await eventually(async () => { const value = await state(); get(value, 'Like 1'); return value })
  await assert.rejects(click(oldRefresh), /Stale|rejected/)
  assert.equal(likes, 1, 'click dispatched once; persisted through reload')
  const beforeUrlChange = get(s, 'Message')
  await click(get(s, 'Change URL'))
  await assert.rejects(browserAction('browser_type', { ...args, element: beforeUrlChange, text: 'must not type' }), /Stale/)
  const opened = await browserAction('browser_open', { browser_endpoint, url: `http://127.0.0.1:${server.address().port}/second` })
  assert.notEqual(opened.tab_id, tab_id)
  const openedState = await browserAction('browser_state', { browser_endpoint, tab_id: opened.tab_id })
  assert.ok(openedState.url.endsWith('/second'))
  await browserAction('browser_close', { browser_endpoint, tab_id: opened.tab_id, expected_url: openedState.url })
  await assert.rejects(browserAction('browser_state', { browser_endpoint, tab_id: opened.tab_id }), /not found/)
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(browserAction('browser_state', args, aborted.signal), /abort/i)
  for (const bad of ['ws://example.com:9222/devtools/browser/a', 'http://127.0.0.1:9222/',
    'ws://localhost:9222/devtools/browser/a', 'ws://127.0.0.1:9222/devtools/page/a']) {
    await assert.rejects(browserAction('browser_state', { browser_endpoint: bad }), /loopback/)
  }
  // A loopback server that never completes the WebSocket handshake verifies
  // in-flight abort and connect timeout without depending on browser timing.
  const stalled = http.createServer()
  const sockets = new Set()
  stalled.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  stalled.on('upgrade', (req, socket) => {
    if (req.url.endsWith('/test')) return
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    if (req.url.endsWith('/disconnect')) setTimeout(() => socket.destroy(), 50)
  })
  stalled.listen(0, '127.0.0.1')
  await once(stalled, 'listening')
  try {
    const stalledArgs = { browser_endpoint: `ws://127.0.0.1:${stalled.address().port}/devtools/browser/test` }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 50)
    await assert.rejects(browserAction('browser_state', stalledArgs, abort.signal), /abort|closed/i)
    clearTimeout(timer)
    await assert.rejects(browserAction('browser_state', stalledArgs), /timeout/i)
    const commandArgs = { browser_endpoint: stalledArgs.browser_endpoint.replace('/test', '/command') }
    await assert.rejects(browserAction('browser_state', commandArgs), /command timeout/i)
    const commandAbort = new AbortController()
    const commandTimer = setTimeout(() => commandAbort.abort(), 100)
    await assert.rejects(browserAction('browser_state', commandArgs, commandAbort.signal), /abort|closed/i)
    clearTimeout(commandTimer)
    await assert.rejects(browserAction('browser_state', {
      browser_endpoint: stalledArgs.browser_endpoint.replace('/test', '/disconnect'),
    }), /closed/i)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => stalled.close(resolve))
  }
  console.log('PASS: Edge headless state/tokens/type/Ctrl+Enter/like/reload/name+role+detached+navigation stale/wrong-tab/abort/connect+command timeout/disconnect/endpoint restrictions')
} finally {
  // Browser.close is sent only to the unique profile endpoint spawned above.
  if (control?.readyState === WebSocket.OPEN) {
    try { await command('Browser.close') } catch { /* child fallback below */ }
    control.close()
  }
  if (child?.pid) {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* Browser.close already ended the owned profile tree */ }
  }
  await new Promise(resolve => server.close(resolve))
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
