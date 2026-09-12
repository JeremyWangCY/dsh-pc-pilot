import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Browser-level ws endpoint only: read DevToolsActivePort from an owned profile.
// No discovery requests, redirects, default browser, foreground activation or logging.
const tokens = new Map()
const locks = new Set()
const CONNECT_TIMEOUT_MS = 10000
const COMMAND_TIMEOUT_MS = 12000
const TTL = 60000
const LIMIT = 500
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'dsh-cua')

// A crashed/degraded renderer can report url "" or ":" through CDP. Never let a
// bogus frame URL masquerade as page state: fall back to the target info URL,
// then to 'unknown' so callers can tell "unreadable" from "readable but empty".
function normalizeUrl(...candidates) {
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && trimmed !== ':') return trimmed
  }
  return 'unknown'
}

// Visible status of a page from what the model can actually act on. An error
// page (site block, no login, crash) exposes a title/body but zero interactive
// controls; report that instead of letting 0 elements read as a quiet success.
function pageStatus(title, elementCount, url, bodyText = '', readyState = '') {
  if (url === 'unknown' && !title && !bodyText) return 'unreadable'
  const t = String(title || '')
  if (/(出错啦|出错了|无法访问|aw,? snap|can't be reached|not available|无法显示)/i.test(t)) return 'page_error'
  if (elementCount === 0) {
    // title can lag or be empty; a 0-control page whose visible body declares an
    // error must not be reported as a plain no_interactive_elements.
    if (/(出错|错误|error|失败|无法访问|cannot|blocked|验证|滑块)/i.test(String(bodyText).slice(0, 160))) return 'page_error'
    if (readyState && readyState !== 'complete') return 'loading'
    return 'no_interactive_elements'
  }
  if (/(错误|error)/i.test(t)) return 'page_error'
  return 'ok'
}

function endpoint(value) {
  if (typeof value !== 'string') throw new Error('browser_endpoint required')
  const u = new URL(value)
  if (u.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(u.hostname) ||
      !u.port || u.username || u.password || u.search || u.hash ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(u.pathname)) {
    throw new Error('Expected explicit loopback browser WebSocket endpoint')
  }
  return u.href
}

async function connect(url, signal, commandTimeoutMs = COMMAND_TIMEOUT_MS) {
  signal?.throwIfAborted()
  const ws = new WebSocket(url)
  const pending = new Map()
  const events = []
  let sequence = 0
  let dead = false
  let rejectOpen
  const close = () => {
    if (dead) return
    dead = true
    rejectOpen?.(new Error(signal?.aborted ? 'CDP aborted' : 'CDP connection closed'))
    signal?.removeEventListener('abort', close)
    for (const p of pending.values()) p.reject(new Error('CDP connection closed or aborted'))
    pending.clear()
    ws.close()
  }
  ws.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data)
      const p = pending.get(message.id)
      if (!p) { if (message.method) events.push(message); return }
      pending.delete(message.id)
      // Never propagate protocol error text: it can contain page or input data.
      if (message.error) p.reject(new Error('CDP command rejected'))
      else p.resolve(message.result)
    } catch { close() }
  })
  ws.addEventListener('error', close)
  ws.addEventListener('close', close)
  signal?.addEventListener('abort', close, { once: true })
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); ws.removeEventListener('open', opened); rejectOpen = null }
      const opened = () => { cleanup(); resolve() }
      const timer = setTimeout(() => { cleanup(); reject(new Error('CDP connect timeout')); close() }, CONNECT_TIMEOUT_MS)
      rejectOpen = error => { cleanup(); reject(error) }
      ws.addEventListener('open', opened, { once: true })
    })
    signal?.throwIfAborted()
  } catch (error) { close(); throw error }
  return {
    close,
    send(method, params = {}, sessionId) {
      signal?.throwIfAborted()
      if (dead) return Promise.reject(new Error('CDP connection closed'))
      return new Promise((resolve, reject) => {
        const id = ++sequence
        // Slow/error pages legitimately need longer than the default; error pages
        // must fail FAST and legibly instead of hanging the whole observation.
        const timeoutMs = Math.max(2000, Math.min(30000, Number(commandTimeoutMs) || COMMAND_TIMEOUT_MS))
        const timer = setTimeout(() => { reject(new Error(`CDP command timeout (${timeoutMs}ms)`)); close() }, timeoutMs)
        pending.set(id, {
          resolve: value => { clearTimeout(timer); resolve(value) },
          reject: error => { clearTimeout(timer); reject(error) },
        })
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })) }
        catch { close() }
      })
    },
    drainEvents() { const copy = events.splice(0); return copy },
  }
}

// This is a deliberately limited DOM name/role approximation, not a full AX tree.
// Never returns editable text; it may inspect its length so callers can verify
// that a controlled editor actually contains input without leaking the text.
function describe(el) {
  const tag = el.localName
  const actionLabel = /^(发布|发送|提交)$/.test((el.innerText || '').replace(/\s+/g, ' ').trim())
  const role = el.getAttribute('role') || (actionLabel ? 'button' : null) || ({ button: 'button', a: 'link', textarea: 'textbox',
    select: 'combobox', input: ['checkbox', 'radio'].includes(el.type) ? el.type :
      ['button', 'submit', 'reset'].includes(el.type) ? 'button' : 'textbox' }[tag]) ||
    (el.isContentEditable ? 'textbox' : 'generic')
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
    .map(id => el.ownerDocument.getElementById(id)?.textContent || '').join(' ')
  const name = (labelled || el.getAttribute('aria-label') ||
    Array.from(el.labels || []).map(x => x.textContent).join(' ') ||
    el.getAttribute('title') || (el.closest('[contenteditable]') || ['input', 'textarea', 'select'].includes(tag)
      ? '' : el.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const href = tag === 'a' && el.href ? el.href : undefined
  const editable = role === 'textbox'
  const editor = editable && (el.matches('[contenteditable="true"]') || el.querySelector?.('[contenteditable="true"]'))
  const rawValue = el.value ?? (editor ? (editor.innerText || editor.textContent || '') : (el.innerText || el.textContent || ''))
  const hasValue = editable ? Boolean(String(rawValue).trim()) : undefined
  const disabled = Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true')
  const valuePreview = editable ? String(el.value != null ? el.value : (el.innerText || el.textContent || '')).slice(0, 5000) : ''
  const box = el.getBoundingClientRect()
  const rect = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) }
  return { role, name, rect, ...(href ? { href: href.slice(0, 2000) } : {}), ...(editable ? { has_value: hasValue, value_preview: valuePreview } : {}), ...(disabled ? { disabled: true } : {}) }
}

function keySpec(value) {
  const parts = typeof value === 'string' ? value.split('+').map(part => part.trim()).filter(Boolean) : []
  const rawName = parts.pop() || ''
  const specialNames = { enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', arrowleft: 'ArrowLeft', arrowup: 'ArrowUp', arrowright: 'ArrowRight', arrowdown: 'ArrowDown', home: 'Home', end: 'End', space: 'Space' }
  const name = specialNames[rawName.toLowerCase()] || rawName
  let modifiers = 0
  for (const part of parts) {
    const bit = { alt: 1, ctrl: 2, control: 2, meta: 4, win: 4, windows: 4, shift: 8 }[part.toLowerCase()]
    if (!bit || (modifiers & bit)) throw new Error('Unsupported key')
    modifiers |= bit
  }
  const special = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Space: 32 }
  if (/^[a-z]$/i.test(name)) return { key: modifiers & 8 ? name.toUpperCase() : name.toLowerCase(), code: `Key${name.toUpperCase()}`, modifiers, windowsVirtualKeyCode: name.toUpperCase().charCodeAt(0) }
  if (!(name in special)) throw new Error('Unsupported key')
  return { key: name === 'Space' ? ' ' : name, code: name, modifiers,
    windowsVirtualKeyCode: special[name] }
}

async function capturePageScreenshot(send) {
  try {
    const metrics = await send('Page.getLayoutMetrics')
    const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
    if (!shot?.data) return null
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    const file = path.join(SCREENSHOT_DIR, `disp-${randomUUID().replaceAll('-', '')}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'), { flag: 'wx', mode: 0o600 })
    const viewport = metrics?.cssVisualViewport || metrics?.cssContentSize || {}
    const width = Math.max(1, Math.round(viewport.clientWidth || viewport.width || 1))
    const height = Math.max(1, Math.round(viewport.clientHeight || viewport.height || 1))
    return { path: file, screenshot_id: randomUUID().replaceAll('-', ''), width, height, viewport: { coordinate_space: 'browser_viewport', x: 0, y: 0, width, height, scale: 1 }, method: 'cdp_page_capture_screenshot' }
  } catch {
    return null
  }
}

/**
 * browserAction(action, { browser_endpoint, tab_id?, element?, text?, key? }, signal?)
 * state without tab_id lists pages; all other calls require an exact tab_id.
 * Tokens live in this Node process, expire after 60s without state refresh, and
 * are invalidated by navigation/detachment or name/role changes. No input retries.
 */
export async function browserAction(action, args = {}, signal) {
  if (!['browser_open', 'browser_navigate', 'browser_activate', 'browser_close', 'browser_shutdown', 'browser_state', 'browser_read', 'browser_request', 'browser_click', 'browser_click_text', 'browser_type', 'browser_replace', 'browser_key', 'browser_scroll', 'browser_scroll_to_text', 'browser_reload'].includes(action)) throw new Error('Unsupported browser action')
  const url = endpoint(args.browser_endpoint)
  if (args.tab_id !== undefined && (typeof args.tab_id !== 'string' || !args.tab_id)) throw new Error('Exact tab_id required')
  if (['browser_activate', 'browser_close'].includes(action) && !args.tab_id) throw new Error('Exact tab_id required')
  if (!['browser_shutdown', 'browser_state', 'browser_read', 'browser_request', 'browser_open', 'browser_navigate', 'browser_activate', 'browser_close', 'browser_scroll', 'browser_scroll_to_text', 'browser_click_text', 'browser_reload'].includes(action) && (!args.tab_id || typeof args.element !== 'string')) throw new Error('tab_id and element token required')
  if (action === 'browser_open' && (!args.url || !['http:', 'https:'].includes(new URL(args.url).protocol))) throw new Error('HTTP(S) URL required')
  if (action === 'browser_navigate' && (!args.url || !['http:', 'https:'].includes(new URL(args.url).protocol))) throw new Error('HTTP(S) URL required')
  if (['browser_type', 'browser_replace'].includes(action) && typeof args.text !== 'string') throw new Error('text required')
  if (action === 'browser_scroll_to_text' && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 2000)) throw new Error('non-empty text up to 2000 characters required')
  if (action === 'browser_click_text' && (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 200)) throw new Error('non-empty text up to 200 characters required')
  if (args.capture_network_wait_ms !== undefined && (!Number.isFinite(Number(args.capture_network_wait_ms)) || Number(args.capture_network_wait_ms) < 0 || Number(args.capture_network_wait_ms) > 10000)) throw new Error('capture_network_wait_ms must be 0..10000')
  const key = action === 'browser_key' ? keySpec(args.key) : null
  signal?.throwIfAborted()
  if (locks.has(url)) throw new Error('Browser endpoint busy')
  locks.add(url)
  let cdp
  let mutationStarted = false
  const budget = AbortSignal.timeout(15000)
  const combined = signal ? AbortSignal.any([signal, budget]) : budget
  // Per-call CDP command budget: error pages / heavy pages can exceed the
  // default; clamp to 2s..30s so a hung page still fails legibly and fast.
  const commandTimeoutMs = Math.max(2000, Math.min(30000, Number(args.command_timeout_ms) || 0)) || COMMAND_TIMEOUT_MS
  try {
    for (const [token, item] of tokens) if (item.expires < Date.now()) tokens.delete(token)
    cdp = await connect(url, combined, commandTimeoutMs)
    if (action === 'browser_shutdown') {
      mutationStarted = true
      for (const [token, item] of tokens) if (item.url === url) tokens.delete(token)
      await cdp.send('Browser.close')
      return { ok: true, browser_closed: true, outcome: 'completed' }
    }
    if (action === 'browser_open') {
      mutationStarted = true
      const { targetId } = await cdp.send('Target.createTarget', { url: args.url, background: true })
      return { ok: true, tab_id: targetId, requested_url: args.url, outcome: 'dispatched', observation_required: true }
    }
    const { targetInfos } = await cdp.send('Target.getTargets')
    const pages = targetInfos.filter(t => t.type === 'page')
    if (action === 'browser_state' && args.tab_id === undefined) {
      // Privacy default: a dirty shared profile leaks session state through tab
      // URLs/titles (ntp queries, sync dialogs). List ids only; opt in with
      // include_url when the task genuinely needs to match a tab by its URL.
      const listed = pages.map(t => args.include_url
        ? { tab_id: t.targetId, url: normalizeUrl(t.url), title: t.title }
        : { tab_id: t.targetId })
      return { pages: listed, include_url: !!args.include_url }
    }
    if (!pages.some(t => t.targetId === args.tab_id)) throw new Error('Exact page tab_id not found')
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: args.tab_id, flatten: true })
    const send = (method, params) => cdp.send(method, params, sessionId)
    const { frameTree } = await send('Page.getFrameTree')
    // A crashed or blocked renderer reports url "" or ":" here; normalize once
    // and reuse for the expected_url guard, token binding and the state reply.
    const pageUrl = normalizeUrl(frameTree.frame.url, pages.find(t => t.targetId === args.tab_id)?.url)
    if (args.expected_url !== undefined && args.expected_url !== pageUrl) throw new Error('Page URL changed; refresh browser_state before acting')
    if (action === 'browser_read') {
      const live = await send('Runtime.evaluate', { expression: `(() => ({ title: document.title || '', text: (document.body?.innerText || document.body?.textContent || '').slice(0, 50000), readyState: document.readyState }))()`, returnByValue: true })
      const value = live?.result?.value || {}
      return { tab_id: args.tab_id, url: pageUrl, title: value.title || '', ready_state: value.readyState || '', text: value.text || '', outcome: 'completed', ok: true }
    }
    if (action === 'browser_request') {
      const target = new URL(args.url || '')
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('HTTP(S) URL required')
      const current = new URL(pageUrl)
      if (target.origin !== current.origin && target.hostname !== 'api.bilibili.com') throw new Error('browser_request target origin is not allowed')
      const method = String(args.method || 'GET').toUpperCase()
      if (!['GET','POST','DELETE'].includes(method)) throw new Error('Unsupported browser_request method')
      if (method !== 'GET' && args.allow_mutation !== true) throw new Error('browser_request mutation requires allow_mutation:true')
      const response = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{const f=${JSON.stringify(target.href)};const method=${JSON.stringify(method)};const form=${JSON.stringify(args.form||{})};if(${JSON.stringify(Boolean(args.csrf_from_cookie))}){const m=document.cookie.match(/(?:^|;\\s*)bili_jct=([^;]+)/);if(m)form.csrf=decodeURIComponent(m[1])}const r=await fetch(f,{method,credentials:'include',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:method==='GET'?undefined:new URLSearchParams(form).toString()});return{status:r.status,text:(await r.text()).slice(0,50000)}})()` })
      const value = response?.result?.value || {}
      let business = {}; try { business = JSON.parse(value.text || '') } catch {}
      return { tab_id: args.tab_id, url: target.href, status: value.status, business_code: business.code, business_message: business.message, response_text: value.text, outcome: 'completed', ok: value.status >= 200 && value.status < 400 }
    }
    if (action === 'browser_navigate') {
      const target = new URL(args.url)
      const current = new URL(pageUrl)
      const sameBilibiliSite = current.hostname.endsWith('.bilibili.com') && target.hostname.endsWith('.bilibili.com')
      if (target.origin !== current.origin && !sameBilibiliSite) throw new Error('browser_navigate target origin is not allowed')
      mutationStarted = true
      const result = await send('Page.navigate', { url: target.href })
      for (const [token, item] of tokens) if (item.url === url && item.tab === args.tab_id) tokens.delete(token)
      return { tab_id: args.tab_id, requested_url: target.href, frame_id: result.frameId, outcome: 'dispatched', observation_required: true, ok: true }
    }
    if (action === 'browser_close') {
      mutationStarted = true
      const { success } = await cdp.send('Target.closeTarget', { targetId: args.tab_id })
      if (!success) throw new Error('Tab close failed')
      for (const [token, item] of tokens) if (item.url === url && item.tab === args.tab_id) tokens.delete(token)
      return { ok: true, tab_id: args.tab_id, outcome: 'completed' }
    }
    if (action === 'browser_activate') {
      mutationStarted = true
      await cdp.send('Target.activateTarget', { targetId: args.tab_id })
      return { ok: true, tab_id: args.tab_id, outcome: 'completed' }
    }
    const { executionContextId } = await send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'pc-pilot-dom',
    })
    const { root } = await send('DOM.getDocument', { depth: 0 })
    const documentId = root.backendNodeId
    const call = async (objectId, functionDeclaration, arguments_ = []) => {
      const result = await send('Runtime.callFunctionOn', { objectId, functionDeclaration,
        arguments: arguments_.map(value => ({ value })), returnByValue: true })
      if (result.exceptionDetails) throw new Error('Element stale or DOM operation rejected')
      return result.result.value
    }
    if (action === 'browser_state') {
      // Collect visible controls in-page once, including open shadow roots. Avoid
      // three protocol roundtrips per invisible node on large Chromium pages.
      const collected = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => {
        const nodes = []; let visited = 0;
        function walk(root) {
          for (const el of root.querySelectorAll('*')) {
            if (++visited > 50000 || nodes.length > ${LIMIT}) { nodes.scanTruncated = true; return; }
             if ((el.matches('button,a[href],input,textarea,select,[role],[tabindex],[contenteditable="true"]') ||
                 /^(发布|发送|提交)$/.test((el.innerText || '').replace(/\s+/g, ' ').trim())) &&
                el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' && el.type !== 'hidden') nodes.push(el);
            if (el.shadowRoot) walk(el.shadowRoot);
          }
        }
         walk(document);
         // Long comment feeds can contain hundreds of reply/like links before
         // the active editor and submit controls. Keep actionable controls in
         // the bounded snapshot instead of letting document order hide them.
         const priority = el => el.matches('button,input,textarea,select,[contenteditable="true"],[role="button"],[role="textbox"]') ? 0 : 1;
         nodes.sort((a,b) => priority(a) - priority(b));
         return nodes;
      })()` })
      if (collected.exceptionDetails) throw new Error('Page observation failed')
      const properties = await send('Runtime.getProperties', { objectId: collected.result.objectId, ownProperties: true })
      const controls = properties.result.filter(p => /^\d+$/.test(p.name) && p.value?.objectId)
      // targetInfo title lags behind loading; the live document title decides
      // whether an error page is recognizable as such.
       const live = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => { const visibleText = ${args.include_visible_text ? `(() => { const out = []; const seen = new Set(); const roots = [document]; for (let i = 0; i < roots.length; i++) for (const host of roots[i].querySelectorAll('*')) if (host.shadowRoot) roots.push(host.shadowRoot); for (const root of roots) { const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode()) && out.join(' ').length < 10000) { const text = (node.nodeValue || '').replace(/\\s+/g, ' ').trim(); const parent = node.parentElement; if (!text || !parent || seen.has(text)) continue; const rect = parent.getBoundingClientRect(); if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth && getComputedStyle(parent).visibility !== 'hidden') { seen.add(text); out.push(text); } } } return out.join(' '); })()` : `''`}; return { title: document.title || '', body: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, ${args.include_body_text ? 20000 : 300}), visibleText, readyState: document.readyState }; })()`,
        returnByValue: true })
      const liveTitle = live?.result?.value?.title || ''
      const bodyText = live?.result?.value?.body || ''
      const visibleText = live?.result?.value?.visibleText || ''
      const readyState = live?.result?.value?.readyState || ''
      const elements = []
      for (const control of controls.slice(0, LIMIT)) {
        const object = control.value
        const info = await call(object.objectId, `function(){
          if (!this.isConnected || !this.getClientRects().length || getComputedStyle(this).visibility === 'hidden' || this.type === 'hidden') return null;
          return (${describe})(this);
        }`)
        if (!info) continue
        if (!args.include_editable_text && info.value_preview !== undefined) delete info.value_preview
        const { node } = await send('DOM.describeNode', { objectId: object.objectId })
        let token
        for (const [id, item] of tokens) {
          if (item.url === url && item.tab === args.tab_id && item.documentId === documentId && item.pageUrl === pageUrl &&
              item.backendNodeId === node.backendNodeId && item.name === info.name && item.role === info.role) { token = id; break }
        }
        token ||= randomUUID()
        tokens.set(token, { url, tab: args.tab_id, documentId, pageUrl, backendNodeId: node.backendNodeId,
          ...info, expires: Date.now() + TTL })
        elements.push({ element: token, ...info })
      }
      while (tokens.size > 4000) tokens.delete(tokens.keys().next().value)
      const title = liveTitle || pages.find(t => t.targetId === args.tab_id)?.title || ''
      const elements_out = elements
      const status = pageStatus(title, elements_out.length, pageUrl, bodyText, readyState)
      const authRequired = /(登录后|请先登录|登录即可|扫码登录|立即登录)/i.test(bodyText)
      const editableCount = elements_out.filter(item => item.role === 'textbox').length
      const stateScreenshot = args.with_screenshot ? await capturePageScreenshot(send) : null
      return {
        tab_id: args.tab_id,
        url: pageUrl,
        title,
        ready_state: readyState,
        auth_required: authRequired,
        editable_count: editableCount,
        // page_status makes a blocked/crashed/degraded page legible instead of
        // reading as a quiet success with zero elements. The visible body text
        // gives the model direct evidence of what the page actually says.
        page_status: status,
         ...((args.include_body_text || elements_out.length === 0 || status !== 'ok') && bodyText ? { body_text: bodyText } : {}),
        ...(args.include_visible_text && visibleText ? { visible_text: visibleText } : {}),
        elements: elements_out,
        truncated: controls.length > LIMIT || properties.result.some(p => p.name === 'scanTruncated' && p.value?.value),
        scope: 'main document and open shadow roots; scan capped at 50000 nodes',
        ...(stateScreenshot ? { screenshot: stateScreenshot } : { ...(args.with_screenshot ? { screenshot_error: 'page capture unavailable' } : {}) }),
      }
    }
    if (action === 'browser_scroll') {
      if (!args.tab_id) throw new Error('tab_id required')
      const dx = Number(args.scroll_x ?? 0)
      const dy = Number(args.scroll_y ?? (args.direction === 'up' ? -700 : args.direction === 'down' ? 700 : 0))
      if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 10000 || Math.abs(dy) > 10000) throw new Error('scroll delta out of range')
      mutationStarted = true
      const moved = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => {
        const amount = ${JSON.stringify(dy)};
        const visible = el => { const r = el.getBoundingClientRect(); return r.width > 120 && r.height > 120 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
        const scrollables = [...document.querySelectorAll('*')].filter(el => {
          if (!visible(el) || el.scrollHeight <= el.clientHeight + 4) return false;
          const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY);
        }).map(el => { const r = el.getBoundingClientRect(); return { el, area: Math.max(0, Math.min(innerWidth,r.right)-Math.max(0,r.left)) * Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top)) }; }).sort((a,b) => b.area-a.area);
        const target = scrollables[0]?.el;
        if (target) { target.scrollBy(0, amount); return { container: target.tagName.toLowerCase(), class_name: String(target.className || '').slice(0,120), top: target.scrollTop, height: target.scrollHeight, viewport: target.clientHeight }; }
        window.scrollBy(0, amount); return { container: 'document', x: window.scrollX, y: window.scrollY, height: Math.max(document.body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0), viewport: innerHeight };
      })()`, returnByValue: true })
      const screenshot = await capturePageScreenshot(send)
      const position = moved?.result?.value || {}
      return { tab_id: args.tab_id, ok: true, outcome: 'completed', scroll_x: dx, scroll_y: dy, scroll_position: position, ...(screenshot ? { screenshot } : { screenshot_error: 'post-action page capture unavailable' }) }
    }
    if (action === 'browser_scroll_to_text') {
      // This is intentionally a read-directed scroll only: it never clicks or
      // edits. Prefer the smallest visible rendered element containing the
      // complete requested text, so a matching page wrapper cannot win.
      mutationStarted = true
      const located = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => {
        const needle = ${JSON.stringify(args.text.trim())};
        const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const candidates = [];
        let seen = 0;
        const roots = [document]; for (let i = 0; i < roots.length; i++) for (const host of roots[i].querySelectorAll('*')) if (host.shadowRoot) roots.push(host.shadowRoot);
        outer: for (const root of roots) for (const el of root.querySelectorAll('*')) {
          if (++seen > 50000) break outer;
          const text = compact(el.innerText);
          if (!text.includes(needle)) continue;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue;
          candidates.push({ el, textLength: text.length, area: rect.width * rect.height });
        }
        candidates.sort((a, b) => a.textLength - b.textLength || a.area - b.area);
        const chosen = candidates[0];
        if (!chosen) return { found: false, scanned: seen };
        chosen.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        const rect = chosen.el.getBoundingClientRect();
        return { found: true, scanned: seen, tag: chosen.el.tagName.toLowerCase(), class_name: String(chosen.el.className || '').slice(0, 160), rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, scroll: { x: window.scrollX, y: window.scrollY } };
      })()`, returnByValue: true })
      const screenshot = await capturePageScreenshot(send)
      return { tab_id: args.tab_id, ok: true, outcome: 'completed', ...(located?.result?.value || { found: false }), ...(screenshot ? { screenshot } : { screenshot_error: 'post-action page capture unavailable' }) }
    }
    if (action === 'browser_click_text') {
      // Some web apps draw tabs and menu items with plain containers, so no
      // ARIA/button token exists. This remains constrained to an exact visible
      // label in the already selected tab and reports the chosen geometry.
      mutationStarted = true
      const located = await send('Runtime.evaluate', { contextId: executionContextId, expression: `(() => {
        const needle = ${JSON.stringify(args.text.trim())};
        const compact = value => String(value || '').replace(/\\s+/g, ' ').trim();
        const choices = []; let seen = 0;
        const roots = [document]; for (let i = 0; i < roots.length; i++) for (const host of roots[i].querySelectorAll('*')) if (host.shadowRoot) roots.push(host.shadowRoot);
        outer: for (const root of roots) for (const source of root.querySelectorAll('*')) {
          if (++seen > 50000) break outer;
          if (compact(source.innerText) !== needle) continue;
          const el = source.closest('button,a,[role="button"],[tabindex],li,div,span') || source;
          const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
          if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || style.visibility === 'hidden' || style.display === 'none') continue;
          choices.push({ el, textLength: compact(el.innerText).length, area: rect.width * rect.height });
        }
        choices.sort((a, b) => a.textLength - b.textLength || a.area - b.area);
        const chosen = choices[0]; if (!chosen) return { found: false, scanned: seen };
        chosen.el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        const rect = chosen.el.getBoundingClientRect(); return { found: true, scanned: seen, tag: chosen.el.tagName.toLowerCase(), class_name: String(chosen.el.className || '').slice(0, 160), point: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } };
      })()`, returnByValue: true })
      const value = located?.result?.value || { found: false }
      if (value.found) {
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: value.point.x, y: value.point.y })
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: value.point.x, y: value.point.y, button: 'left', buttons: 1, clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: value.point.x, y: value.point.y, button: 'left', buttons: 0, clickCount: 1 })
      }
      const screenshot = await capturePageScreenshot(send)
      return { tab_id: args.tab_id, ok: true, outcome: 'completed', ...value, ...(screenshot ? { screenshot } : { screenshot_error: 'post-action page capture unavailable' }) }
    }
    if (action === 'browser_reload') {
      mutationStarted = true
      await send('Page.reload', { ignoreCache: Boolean(args.ignore_cache) })
      return { tab_id: args.tab_id, ok: true, outcome: 'dispatched', observation_required: true }
    }
    const item = tokens.get(args.element)
    if (!item || item.url !== url || item.tab !== args.tab_id || item.documentId !== documentId || item.pageUrl !== pageUrl) throw new Error('Stale or wrong-tab element token')
    const { object } = await send('DOM.resolveNode', { backendNodeId: item.backendNodeId, executionContextId })
    const beforeText = ['browser_type', 'browser_replace'].includes(action)
      ? await call(object.objectId, `function(){ const e=this.matches('[contenteditable="true"]') ? this : this.querySelector?.('[contenteditable="true"]'); return this.value != null ? this.value : (e ? (e.innerText || e.textContent || '') : (this.innerText || this.textContent || '')); }`)
      : ''
    mutationStarted = true
    if (args.capture_network) await send('Network.enable')
    const clickPoint = await call(object.objectId, `function(expected, action, trusted){
      const info = (${describe})(this);
      if (!this.isConnected || info.name !== expected.name || info.role !== expected.role ||
          !this.getClientRects().length || getComputedStyle(this).visibility === 'hidden' ||
          this.matches(':disabled') || this.closest('[inert]') || this.getAttribute('aria-disabled') === 'true') throw new Error('stale');
      if (action === 'browser_click' && trusted) {
        this.scrollIntoView({ block: 'center', inline: 'center' });
        const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      if (action === 'browser_click') { this.click(); return null; }
      if (['browser_type', 'browser_replace'].includes(action) && !(this.isContentEditable ||
          (this.localName === 'textarea' && !this.readOnly) ||
          (this.localName === 'input' && !this.readOnly && ['text','search','email','url','tel','password','number'].includes(this.type)))) throw new Error('not editable');
      this.focus({preventScroll:true});
      if (this.getRootNode().activeElement !== this) throw new Error('focus failed');
      if (action === 'browser_replace') {
        const start = Number.isInteger(arguments?.[2]) ? arguments[2] : null;
        const end = Number.isInteger(arguments?.[3]) ? arguments[3] : null;
        if (start !== null || end !== null) {
          const editable = this.matches('[contenteditable="true"]') ? this : this.querySelector?.('[contenteditable="true"]');
          if (!editable) throw new Error('range replacement requires contenteditable editor');
          const text = editable.innerText || editable.textContent || '';
          if (start === null || end === null || start < 0 || end < start || end > text.length) throw new Error('invalid replacement range');
          const range = editable.ownerDocument.createRange();
          const walker = editable.ownerDocument.createTreeWalker(editable, NodeFilter.SHOW_TEXT);
          let pos = 0, a = null, b = null, ao = 0, bo = 0, node;
          while ((node = walker.nextNode())) { const next = pos + node.nodeValue.length; if (!a && start <= next) { a=node; ao=start-pos; } if (!b && end <= next) { b=node; bo=end-pos; break; } pos=next; }
          if (!a || !b) throw new Error('replacement range not found');
          range.setStart(a, ao); range.setEnd(b, bo); const selection=this.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else if (this.isContentEditable) {
          const editable = this.matches('[contenteditable="true"]') ? this : this.querySelector?.('[contenteditable="true"]');
          if (!editable) throw new Error('contenteditable editor not found');
          const range = editable.ownerDocument.createRange(); range.selectNodeContents(editable);
          const selection = editable.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else {
          this.select();
          if (this.selectionStart !== 0 || this.selectionEnd !== this.value.length) throw new Error('selection failed');
        }
      }
    }`, [{ name: item.name, role: item.role }, action, Boolean(args.trusted_input), args.start, args.end])
    if (action === 'browser_click' && args.trusted_input) {
      const point = clickPoint && Number.isFinite(clickPoint.x) && Number.isFinite(clickPoint.y) ? clickPoint : null
      if (!point) throw new Error('click target geometry unavailable')
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
      // Some framework controls (notably dynamically mounted editors) attach
      // their submit handler through a delegated DOM listener that does not
      // react to CDP mouse input after a rerender. Keep this fallback explicit
      // and opt-in so ordinary trusted clicks retain physical semantics.
      if (args.dom_fallback) await call(object.objectId, 'function(){ this.click(); }')
    }
    if (['browser_type', 'browser_replace'].includes(action)) await send('Input.insertText', { text: args.text })
    if (action === 'browser_type') {
      await call(object.objectId, `function(){
        if (!this.isContentEditable && !this.querySelector?.('[contenteditable="true"]'))
          this.dispatchEvent(new Event('input', { bubbles: true }));
        if (!this.isContentEditable && !this.querySelector?.('[contenteditable="true"]'))
          this.dispatchEvent(new Event('change', { bubbles: true }));
      }`)
      const verified = await call(object.objectId, `function(expected, before){
        const e=this.matches('[contenteditable="true"]') ? this : this.querySelector?.('[contenteditable="true"]');
        const value = this.value != null ? this.value : '';
        const text = e ? (e.innerText || e.textContent || '') : (this.isContentEditable || !(this.localName === 'input' || this.localName === 'textarea')
          ? (this.innerText || this.textContent || '') : value);
        return text === expected || text === before + expected || text.endsWith(expected);
      }`, [args.text, beforeText])
      if (!verified) return { tab_id: args.tab_id, ok: false, outcome: 'unknown', error_code: 'type_verification_failed', needs_observation: true,
        message: 'Text input was dispatched but the editable value did not contain the requested text; observe the field before proceeding' }
    }
      if (action === 'browser_replace') {
      // Verification must cover every editable branch: <input>/<textarea> value,
      // contenteditable textContent, and custom widgets that only mirror the
      // text through a child. Controlled (React) inputs get an input event so
      // the framework commits before we read back.
      await call(object.objectId, `function(){
        if (!this.isContentEditable && !this.querySelector?.('[contenteditable="true"]')) {
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }`)
      const expectedReplacement = Number.isInteger(args.start) && Number.isInteger(args.end)
        ? `${String(beforeText).slice(0, args.start)}${args.text}${String(beforeText).slice(args.end)}` : args.text
      const verified = await call(object.objectId, `function(expected){
        const e=this.matches('[contenteditable="true"]') ? this : this.querySelector?.('[contenteditable="true"]');
        const value = this.value != null ? this.value : '';
        const text = e ? (e.innerText || e.textContent || '') : (this.isContentEditable || !(this.localName === 'input' || this.localName === 'textarea')
          ? (this.innerText || this.textContent || '') : value);
        const text2 = ((e ? (e.innerText || e.textContent || '') : (this.innerText || '') )).replace(/\\u00a0/g, ' ');
        return value === expected || text === expected || text2 === expected;
      }`, [expectedReplacement])
      if (!verified) {
        // The text was inserted, but the resulting value could not be confirmed.
        // Never report this as success: flag it for post-mutation observation so
        // the caller must browser_state before trusting the field content.
        return {
          tab_id: args.tab_id,
          ok: false,
          outcome: 'unknown',
          error_code: 'replacement_verification_failed',
          needs_observation: true,
          message: 'Replacement text was inserted but the resulting field value could not be verified (controlled input or editor); run browser_state and observe the field before proceeding',
        }
      }
    }
    if (action === 'browser_key') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...key })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    }
    const screenshot = await capturePageScreenshot(send)
    // A submit handler may schedule its request after a render commit. Let a
    // caller extend this bounded evidence window instead of treating a late
    // response as a reason to restart the whole browser workflow.
    if (args.capture_network) await new Promise(resolve => setTimeout(resolve, Number(args.capture_network_wait_ms) || 1500))
    const rawNetwork = args.capture_network ? cdp.drainEvents().filter(e => ['Network.responseReceived','Network.loadingFailed'].includes(e.method)) : []
    const network = args.capture_network ? await Promise.all(rawNetwork.map(async e => {
      if (e.method === 'Network.loadingFailed') return { method: e.method, error: e.params.errorText, url: (() => { try { const u=new URL(e.params.url); return u.origin+u.pathname } catch { return 'unknown' } })() }
      const out = { method: e.method, url: (() => { try { const u=new URL(e.params.response.url); return u.origin+u.pathname } catch { return 'unknown' } })(), status: e.params.response.status, mime_type: e.params.response.mimeType }
      if (out.url.endsWith('/x/v2/reply/add')) { try { const b=await send('Network.getResponseBody',{requestId:e.params.requestId}); const j=JSON.parse(b.body); out.business_code=j.code; out.business_message=typeof j.message==='string'?j.message.slice(0,160):undefined; if(j.data&&typeof j.data==='object') out.business_data_keys=Object.keys(j.data).slice(0,20); if(j.data?.rpid!==undefined) out.comment_id=String(j.data.rpid) } catch {} }
      return out
    })) : undefined
    return { tab_id: args.tab_id, ok: true, ...(args.trusted_input && action === 'browser_click' ? { click_point: clickPoint } : {}), ...(network ? { network_events: network } : {}), ...(screenshot ? { screenshot } : { screenshot_error: 'post-action page capture unavailable' }) }
  } catch (error) {
    if (mutationStarted) error.outcome = 'unknown'
    throw error
  } finally {
    cdp?.close()
    locks.delete(url)
  }
}
