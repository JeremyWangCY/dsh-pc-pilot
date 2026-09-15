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
const downloadedFiles = []
const server = http.createServer(async (req, res) => {
  if (req.url === '/submit') {
    for await (const data of req) submitted += data
    res.end('ok')
    return
  }
  if (req.url === '/like') { likes++; res.end('ok'); return }
  if (req.url === '/download') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Disposition', 'attachment; filename="pc-pilot-fixture.txt"')
    res.end('pc-pilot download fixture')
    return
  }
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
    <a id="download" href="/download">Download file</a>
    <article id="scroll-target" style="margin-top:3000px">VISIBLE TARGET COMMENT</article></form><script>
    message.value = '';
    message.addEventListener('keydown', async e => {
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault(); await fetch('/submit', {method:'POST',body:message.value});
        message.setAttribute('aria-label','Submitted');
      }
    });
    like.onclick = async () => { console.log('fixture-like-clicked'); await fetch('/like', {method:'POST'}); like.setAttribute('aria-label','Liked'); };
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
  const getRef = (s, name) => {
    const found = s.elements.find(x => x.name === name)
    assert.ok(found, `Missing fixture control: ${name}`)
    assert.match(found.ref, /^@e[1-9]\d*$/)
    return found.ref
  }
  const click = (element, options = {}) => browserAction('browser_click', { ...args, element, ...options })
  let s = await eventually(async () => { const value = await state(); get(value, 'Message'); return value })
  assert.ok(typeof s.navigation_id === 'string' && s.navigation_id, 'browser_state exposes navigation identity')
  assert.match(s.observation_id, /^[a-f0-9]{32}$/i, 'browser_state exposes observation identity')
  assert.ok(s.elements.every(item => /^@e[1-9]\d*$/.test(item.ref)), 'browser_state exposes short semantic refs')
  const semanticObservation = await browserAction('browser_observe', args)
  assert.notEqual(semanticObservation.observation_id, s.observation_id)
  assert.ok(semanticObservation.elements.every(item => item.element === undefined), 'browser_observe omits raw UUID element tokens')
  assert.ok(s.elements.every(item => typeof item.element === 'string' && item.element), 'browser_state preserves raw element tokens for compatibility')
  assert.equal(getRef(semanticObservation, 'Message'), getRef(s, 'Message'), 'same live element keeps its short ref across observations')
  const messageRef = getRef(semanticObservation, 'Message')
  assert.equal(typeof s.can_go_back, 'boolean')
  assert.equal(typeof s.can_go_forward, 'boolean')
  const initialBrowserSession = s.browser_session_id
  const assertBrowserSessionStable = async label => {
    const value = await browserAction('browser_tabs', { browser_endpoint })
    assert.equal(value.browser_session_id, initialBrowserSession, `persistent browser session changed during ${label}`)
  }
  const tabs = await browserAction('browser_tabs', { browser_endpoint, include_url: true })
  assert.equal(tabs.ok, true)
  assert.ok(tabs.tab_count >= 2 && tabs.pages.some(page => page.tab_id === tab_id), 'browser_tabs lists exact page targets')
  const readyWait = await browserAction('browser_wait', { ...args, browser_wait_for: 'ready', browser_wait_timeout_ms: 2000 })
  assert.equal(readyWait.ok, true)
  assert.equal(readyWait.ready_state, 'complete')
  const textWait = await browserAction('browser_wait', { ...args, browser_wait_for: 'text', text: 'VISIBLE TARGET COMMENT', browser_wait_timeout_ms: 2000 })
  assert.equal(textWait.ok, true)
  const missedWait = await browserAction('browser_wait', { ...args, browser_wait_for: 'text', text: 'TEXT THAT WILL NEVER APPEAR', browser_wait_timeout_ms: 50 })
  assert.equal(missedWait.ok, false)
  assert.equal(missedWait.error_code, 'browser_wait_timeout')
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
  const typed = await browserAction('browser_type', { ...args, element: messageRef, text: 'fixture secret 123' })
  assert.ok(typed.screenshot?.path && existsSync(typed.screenshot.path), 'browser mutation returns a fresh screenshot')
  await assertBrowserSessionStable('typing')
  assert.ok(!JSON.stringify(await state()).includes('fixture secret'))
  await assert.rejects(browserAction('browser_replace', { ...args, element: message, text: 'wrong', expected_url: 'https://wrong.invalid/' }), /URL changed/)
  await browserAction('browser_replace', { ...args, element: message, text: 'replacement text', expected_url: s.url })
  await browserAction('browser_key', { ...args, element: message, key: 'Ctrl+Enter' })
  await eventually(() => { assert.equal(submitted, 'replacement text'); return true })
  await assertBrowserSessionStable('replace-and-key')
  const eventCursorBeforeLike = s.event_cursor
  await click(get(s, 'Like 0'), { confirmation: 'approved' })
  await eventually(() => { assert.equal(likes, 1); return true })
  const eventEvidence = await eventually(async () => {
    const value = await browserAction('browser_events', { ...args, event_cursor: eventCursorBeforeLike })
    assert.ok(value.events.some(event => event.kind === 'response' && event.url.endsWith('/like') && event.status === 200), 'browser_events captures newer network evidence')
    assert.ok(value.events.some(event => event.kind === 'console' && event.text.includes('fixture-like-clicked')), 'browser_events captures newer console evidence')
    return value
  })
  assert.equal(eventEvidence.browser_session_id, initialBrowserSession, 'browser_events must stay on the same persistent session')
  assert.equal(eventEvidence.events_reset, false)
  const noDuplicateEvents = await browserAction('browser_events', { ...args, event_cursor: eventEvidence.event_cursor })
  assert.equal(noDuplicateEvents.events.length, 0, 'event cursor prevents replaying old evidence')
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
  const beforeUrlRef = getRef(s, 'Message')
  const originalUrl = s.url
  await click(get(s, 'Change URL'))
  await assert.rejects(browserAction('browser_type', { ...args, element: beforeUrlChange, text: 'must not type' }), /Stale/)
  await assert.rejects(browserAction('browser_type', { ...args, element: beforeUrlRef, text: 'must not type' }), /ref|Stale/i)
  const urlChanged = await browserAction('browser_wait', { ...args, browser_wait_for: 'url_change', expected_url: originalUrl, browser_wait_timeout_ms: 2000 })
  assert.equal(urlChanged.ok, true)
  assert.ok(urlChanged.url.endsWith('/changed'))
  const historyChanged = await browserAction('browser_history', args)
  assert.equal(historyChanged.ok, true)
  assert.equal(historyChanged.can_go_back, true)
  assert.ok(historyChanged.entries.some(entry => entry.url.endsWith('/changed')), 'browser_history exposes current SPA history entry')
  const back = await browserAction('browser_back', args)
  assert.equal(back.ok, true)
  const backWait = await browserAction('browser_wait', { ...args, browser_wait_for: 'url_change', expected_url: urlChanged.url, browser_wait_timeout_ms: 2000 })
  assert.equal(backWait.ok, true)
  assert.equal(backWait.url, originalUrl)
  const historyBack = await browserAction('browser_history', args)
  assert.equal(historyBack.can_go_forward, true)
  const forward = await browserAction('browser_forward', args)
  assert.equal(forward.ok, true)
  const forwardWait = await browserAction('browser_wait', { ...args, browser_wait_for: 'url_change', expected_url: originalUrl, browser_wait_timeout_ms: 2000 })
  assert.equal(forwardWait.ok, true)
  assert.ok(forwardWait.url.endsWith('/changed'))
  s = await eventually(async () => { const value = await state(); get(value, 'Download file'); return value })
  await click(get(s, 'Download file'))
  const downloadState = await eventually(async () => {
    const value = await browserAction('browser_downloads', { browser_endpoint })
    const completed = value.downloads.find(item => item.suggested_filename === 'pc-pilot-fixture.txt' && item.state === 'completed')
    assert.ok(completed, 'browser_downloads tracks completed Chromium download')
    const file = value.files.find(item => item.name === 'pc-pilot-fixture.txt')
    assert.ok(file && existsSync(file.path) && file.bytes > 0, 'browser_downloads exposes completed file path')
    return value
  })
  downloadedFiles.push(...downloadState.files.map(file => file.path))
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
  console.log('PASS: Edge headless persistent-session/events/downloads/tabs/history/back-forward/waits/state/tokens/type/Ctrl+Enter/like/reload/name+role+detached+navigation stale/wrong-tab/abort/connect+command timeout/disconnect/endpoint restrictions')
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
  for (const file of downloadedFiles) await rm(file, { force: true })
  await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
