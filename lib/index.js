// dsh-computer-use — persistent host bundle.
// Registers the global model tool `computer` on the host (web) profile:
// UIA accessibility tree + PrintWindow screenshots + background synthetic-cursor
// input (UIA patterns / WM_CHAR / WM_KEY / WM_MOUSEWHEEL, default) with a codex-style
// white rounded-triangle cursor glyph (blue rim, tip-centered blue glow), click-through;
// real SendInput available via
// dispatch=foreground. Executed through a local Windows PowerShell 5.1 helper bundled
// in this package (copied to %TEMP% once per host start).
//
// Runs as a full Node ESM module inside the host process, so it can spawn
// powershell directly — no subprocess service involved.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// Boot diagnostics: every load/registration step appends here so a silent
// loader failure on the host side can be told apart from a code bug.
const DIAG_LOG = path.join(os.tmpdir(), 'dsh-cua-diag.log')
function diag(msg) {
  try { fs.appendFileSync(DIAG_LOG, new Date().toISOString() + ' pid=' + process.pid + ' ' + msg + '\n') } catch { /* best-effort */ }
}
// ponytail: append-only log is unbounded — drop it past 512KB, nobody reads older detail
try { if (fs.statSync(DIAG_LOG).size > 512 * 1024) fs.unlinkSync(DIAG_LOG) } catch { /* first run */ }
diag('module load ' + import.meta.url)

export const name = 'computer-use'
// cordis: apply(ctx) touches ctx.tools — declare the dependency so apply runs
// only after the tools service is ready (required since the runtime update).
export const inject = ['tools']

// portable: never hardcode the Windows directory; honor SystemRoot
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const PS_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = path.join(__dirname, 'computer-use-helper.ps1')
const HELPER_TARGET = path.join(os.tmpdir(), 'dsh-cua-helper.ps1')
const OVERLAY_SOURCE = path.join(__dirname, 'virtual-cursor-overlay.ps1')
const OVERLAY_TARGET = path.join(os.tmpdir(), 'virtual-cursor-overlay.ps1')

let helperReady = null
function ensureHelper() {
  helperReady ??= (async () => {
    fs.mkdirSync(path.dirname(HELPER_TARGET), { recursive: true })
    fs.copyFileSync(HELPER_SOURCE, HELPER_TARGET)
    try { fs.copyFileSync(OVERLAY_SOURCE, OVERLAY_TARGET) } catch { /* overlay optional */ }
    return HELPER_TARGET
  })()
  return helperReady
}

// ponytail: code-point-safe split; 6000 chars keeps every spawn far under the argv limit
export function splitText(text, max = 6000) {
  const cp = [...String(text || '')]
  const out = []
  for (let i = 0; i < cp.length; i += max) out.push(cp.slice(i, i + max).join(''))
  return out.length ? out : ['']
}

// Parse the helper's reply from raw stdout. PowerShell banners/warnings can be
// prepended to stdout, so if a plain JSON.parse fails, extract the outermost
// { ... } block and try again. Stray braces inside the banner noise are
// tolerated by retrying from each '{' up to the last '}' (capped, best effort).
export function extractHelperJson(stdout) {
  const s = String(stdout || '')
  try {
    const v = JSON.parse(s)
    if (v && typeof v === 'object') return v
  } catch { /* fall through to block extraction */ }
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first === -1 || last <= first) return null
  let idx = first
  for (let tries = 0; idx !== -1 && idx < last && tries < 64; tries++) {
    try {
      const v = JSON.parse(s.slice(idx, last + 1))
      if (v && typeof v === 'object') return v
    } catch { /* try the next '{' */ }
    idx = s.indexOf('{', idx + 1)
  }
  return null
}

// One-shot helper invocation: JSON payload on stdin, JSON reply on stdout.
export async function runAction(action, args, signal) {
  try {
    await ensureHelper()
  } catch (err) {
    return { ok: false, action, message: 'helper copy failed: ' + err.message }
  }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PS_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', HELPER_TARGET,
        '-Action', String(action),
        '-PayloadStdin',
      ], {
        cwd: SYSTEM_ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, action, message: 'spawn failed: ' + err.message })
      return
    }
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(args || {}), 'utf8')
    const chunks = []
    const errChunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    child.stderr.on('data', (d) => errChunks.push(d))
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
    }, 180000)
    if (signal) {
      const onAbort = () => { try { child.kill() } catch { /* ignore */ } }
      signal.addEventListener('abort', onAbort, { once: true })
      child.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, action, message: 'process error: ' + err.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8')
      if (stdout) {
        const value = extractHelperJson(stdout)
        if (value) {
          resolve(value)
          return
        }
        resolve({ ok: false, action, message: 'helper returned non-JSON output', raw: stdout.slice(0, 4000), stderr: stderr.slice(0, 4000), exitCode: code })
        return
      }
      resolve({ ok: false, action, message: 'helper produced no output', stderr: stderr.slice(0, 4000), exitCode: code })
    })
  })
}

// ---------------------------------------------------------------- persistent helper daemon (Round 1 latency)
// Spawns ONE PowerShell helper with -Server (JSONL over stdio) and reuses it for
// every action, removing the per-action cold start (PS spawn + Add-Type compile).
// The one-shot runAction stays untouched as the fallback: execute() falls back to
// it on any daemon error, and two consecutive daemon failures trip a circuit
// breaker that pins the one-shot path for the rest of the host session.

const daemon = { child: null, buf: '', pending: new Map(), nextId: 1, failStreak: 0, broken: false }

export function getDaemonPid() {
  return daemon.child && daemon.child.pid ? daemon.child.pid : null
}

export function stopDaemon() {
  killDaemon()
}

function killDaemon() {
  const child = daemon.child
  daemon.child = null
  daemon.buf = ''
  clearIdleKill()
  const hadPending = daemon.pending.size > 0
  // entry.reject runs finish(), which marks settled, clears the timer and
  // deletes the id (safe to delete from a Map during iteration)
  for (const entry of daemon.pending.values()) {
    entry.reject(new Error('daemon stopped'))
  }
  daemon.pending.clear()
  if (child) {
    try { child.kill() } catch { /* already gone */ }
  }
  return hadPending
}

function noteDaemonFailure() {
  daemon.failStreak++
  if (daemon.failStreak >= 2) {
    daemon.broken = true
    diag('computer-use daemon circuit breaker OPEN (failStreak=' + daemon.failStreak + ')')
  }
}

// Idle lifecycle lives on the node side: the helper's PS blocking reads cannot
// enforce an idle exit (judge-proven), so after each successful request we arm
// a 300s kill timer using the same kill/cleanup path as abort. Any new request
// clears the timer first.
const DAEMON_IDLE_MS = 300000
let idleTimer = null
function clearIdleKill() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}
function armIdleKill() {
  clearIdleKill()
  idleTimer = setTimeout(() => {
    idleTimer = null
    killDaemon()
  }, DAEMON_IDLE_MS)
  if (idleTimer.unref) idleTimer.unref()
}

let acquireInFlight = null
function acquireDaemon() {
  if (daemon.broken) return Promise.reject(new Error('daemon circuit-breaker open'))
  if (daemon.child) return Promise.resolve(daemon.child)
  // single-flight: concurrent first calls must share ONE spawn, not leak helpers
  if (acquireInFlight) return acquireInFlight
  const p = ensureHelper().then(() => new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(PS_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', HELPER_TARGET,
        '-Server',
      ], {
        cwd: SYSTEM_ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      noteDaemonFailure()
      reject(err)
      return
    }
    daemon.child = child
    daemon.buf = ''
    // The daemon must NEVER keep the host event loop alive: on host exit the
    // child's stdin closes and the helper exits via EOF. In-flight requests
    // stay covered by the ref'd 150s per-request timer.
    child.unref()
    child.stdout.unref()
    child.stderr.unref()
    child.stderr.resume() // drain any unhandled CLR/native stderr to prevent OS pipe buffer stall
    child.stdin.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      // dying child's trailing stdout must not interleave into a respawned
      // child's JSONL framing: only feed the buffer while this IS the current child
      if (daemon.child !== child) return
      daemon.buf += chunk
      let idx
      while ((idx = daemon.buf.indexOf('\n')) !== -1) {
        const line = daemon.buf.slice(0, idx).trim()
        daemon.buf = daemon.buf.slice(idx + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        const entry = daemon.pending.get(msg.id)
        if (entry) {
          // finish() marks settled, clears the timer and removes the listener
          daemon.pending.delete(msg.id)
          daemon.failStreak = 0
          entry.resolve(msg)
        }
      }
    })
    child.stdin.on('error', () => {})
    const teardown = () => {
      if (daemon.child !== child) return
      const hadPending = killDaemon()
      if (hadPending) noteDaemonFailure()  // died mid-request = respawn churn
    }
    child.on('close', teardown)
    child.on('error', (err) => {
      diag('computer-use daemon process error: ' + err.message)
      if (daemon.child !== child) return
      killDaemon()  // rejects pending requests
      noteDaemonFailure()
    })
    resolve(child)
  }))
  acquireInFlight = p
  p.catch(() => {}).then(() => { if (acquireInFlight === p) acquireInFlight = null })
  return p
}

function daemonRequest(action, args, signal) {
  if (daemon.broken) return Promise.reject(new Error('daemon circuit-breaker open'))
  if (signal && signal.aborted) return Promise.reject(new Error('aborted'))
  return acquireDaemon().then((child) => new Promise((resolve, reject) => {
    const id = daemon.nextId++
    clearIdleKill()  // any new request clears the idle kill timer
    const entry = { timer: null, settled: false, resolve: null, reject: null }
    const onAbort = () => {
      // simplest correct abort: settle this request, kill the daemon; next action respawns
      finish(reject, new Error('aborted'))
      killDaemon()
    }
    const finish = (fn, value) => {
      if (entry.settled) return
      entry.settled = true
      clearTimeout(entry.timer)
      daemon.pending.delete(id)
      if (signal) signal.removeEventListener('abort', onAbort)
      fn(value)
    }
    entry.resolve = (msg) => {
      finish(resolve, msg)
      armIdleKill()  // successful request -> re-arm the 300s idle kill timer
    }
    entry.reject = (err) => finish(reject, err)
    daemon.pending.set(id, entry)
    entry.timer = setTimeout(() => {
      // timeout: do NOT fall back to runAction — a slow legit action would be
      // re-executed in full (mutating actions could fire twice). Settle as a
      // soft failure, count it for the circuit breaker, kill the daemon.
      finish(resolve, { ok: false, action, message: 'daemon request timed out' })
      noteDaemonFailure()
      killDaemon()  // next call respawns
    }, 150000)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      // id/action LAST: args carrying their own `id` key must not clobber the
      // correlation id
      child.stdin.write(JSON.stringify({ ...(args || {}), id, action }) + '\n')
    } catch (err) {
      finish(reject, err)
      killDaemon()
    }
  }))
}

const toolDescription = `Desktop computer-use tool for the local Windows session (mirrors codex/cua-driver computer use). Inspect and operate real desktop apps through the Windows UI Automation accessibility tree, per-window PNG screenshots, and background synthetic-cursor input that never steals the user's mouse/keyboard.

Typical loop:
1. list_apps  -- list running apps (pid, name, windows with title/hwnd/rect).
2. get_app_state { app, screenshot: true }  -- WITHOUT stealing focus (dispatch defaults to background). Builds an indexed accessibility tree (elements: index/role/name/value/automation_id/rect/invokable), returns document_text when the app exposes it, and saves a window screenshot at screenshot.path (read with read_image). screenshot.window_rect is the window's screen origin. screenshot.error notes black/blank frames (DirectComposition/UWP or minimized).
3. Act on the state: click_element { app, element }, click { app, x, y }, mouse_down { app, x, y, button }, mouse_up { app, x, y, button }, set_value { app, element, value }, type { app, text }, key { app, key, modifiers }, hold_key { app, key, duration_ms, modifiers }, scroll { app, x, y, amount, direction }, drag { app, from_x, from_y, to_x, to_y }, or open_app { name }.
4. Utilities: read_clipboard, write_clipboard { text }, list_displays.

Background vs foreground:
- dispatch defaults to "background": input runs via UIA action patterns (Invoke/Toggle/Selection/ExpandCollapse/RangeValue/Transform), then pixel hit-test, then WM_CHAR/WM_KEY/WM_MOUSEWHEEL messages. The target window is NOT brought to the foreground and the user's real mouse/keyboard is not hijacked.
- If a background action cannot be done at a point (canvas click, WinUI/Chromium with no native edit HWND, unsupported drag), the helper returns background_unavailable: true with an explanatory message. Choose dispatch per task: stay background whenever it gets the job done (it never disturbs the user); switch to "foreground" (real SendInput, moves the user's cursor and brings the window forward) only when the task genuinely needs it — the user asked for real mouse/keyboard control, or an action essential to the task has no background path. Never silently retry in a loop: when you do go foreground, say so, and finish the affected step in one pass.
- overlay is ON by default: before each input action the helper moves a small codex-style click-through cursor (white rounded-triangle glyph with a blue rim and a soft blue glow centered on the tip) to the target point, so you can see where the AI is about to click/type. It never takes focus and clicks pass through it; it moves to each new point and auto-hides 3 seconds after the last action, so it disappears when the turn ends and reappears on the next action. Pass overlay: false on an action to hide it for that action.

Rules:
- Element indexes are only valid for the get_app_state that produced them; after any UI change, navigation, scroll, or delay, refresh state first.
- x/y (click/scroll/drag) are window-local pixels from the window's top-left; add window.rect.x / window.rect.y for screen coordinates.
- app may be a pid number, a process name, or a window-title substring; window_index selects the nth window when several match.
- Only operate apps and windows the user explicitly asked you to; never submit forms, send messages, make purchases, delete data, or change account/settings without explicit user instruction.`

export function defineComputerTool(defineTool) {
  const parameters = {
      action: {
        type: 'string',
        required: true,
        enum: [
          'list_apps', 'get_app_state', 'click_element', 'click', 'type', 'key',
          'scroll', 'drag', 'set_value', 'open_app',
          'read_clipboard', 'write_clipboard', 'mouse_down', 'mouse_up', 'hold_key', 'list_displays',
        ],
        description: 'What to do on the desktop.',
      },
      app: { type: 'string', description: 'Target app: pid number, process name, or window-title substring (omit for global input).' },
      name: { type: 'string', description: 'Application name or executable path (for open_app).' },
      window_index: { type: 'number', description: '1-based window index when the app has several matching windows (optional).' },
      element: { type: 'number', description: 'Element index from the latest get_app_state (click_element / set_value).' },
      x: { type: 'number', description: 'Window-local X (with app) or screen X (without app).' },
      y: { type: 'number', description: 'Window-local Y (with app) or screen Y (without app).' },
      text: { type: 'string', description: 'Text to type via unicode input.' },
      key: { type: 'string', description: 'Key name for key action: Return, Enter, Escape, Tab, Backspace, Delete, Home, End, PageUp, PageDown, ArrowUp/Down/Left/Right, Space, PrintScreen, CapsLock, F1-F24, a-z, 0-9, punctuation.' },
      modifiers: { type: 'string', description: 'Comma-separated modifier keys for key action: ctrl, shift, alt, win.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for mouse_down/mouse_up (default left).' },
      duration_ms: { type: 'number', description: 'Hold duration in milliseconds for hold_key (default 500, max 10000).' },
      amount: { type: 'number', description: 'Scroll wheel notches (positive integer, default 3).' },
      direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction (default down).' },
      from_x: { type: 'number', description: 'Drag start window-local X.' },
      from_y: { type: 'number', description: 'Drag start window-local Y.' },
      to_x: { type: 'number', description: 'Drag end window-local X.' },
      to_y: { type: 'number', description: 'Drag end window-local Y.' },
      value: { type: 'string', description: 'Text value to set on the target element (set_value).' },
      screenshot: { type: 'boolean', description: 'Capture a per-window PNG screenshot in get_app_state (default true).' },
      dispatch: { type: 'string', enum: ['background', 'foreground'], description: 'background (default): UIA patterns + WM_CHAR/WM_KEY/WM_MOUSEWHEEL, never steals focus. foreground: real SendInput, brings window forward — pick it per task only when the user asked for real control or the essential action has no background path, and say so. Some actions report background_unavailable when the target has no background path.' },
      overlay: { type: 'boolean', description: 'Show the small codex-style click-through cursor glyph at the action point (default true). Set false to hide it.' },
  }

  const toolDef = {
    name: 'computer',
    description: toolDescription,
    parameters,
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        let text
        try {
          text = JSON.stringify(value, null, 1)
        } catch (e) {
          text = String(value)
        }
        if (text.length > 400000) text = text.slice(0, 400000) + '\n...[truncated JSON]'
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      const action = String(((args && args.action) || 'list_apps'))
      const signal = exec ? exec.signal : undefined
      try {
        // persistent daemon first (no per-action cold start)
        return await daemonRequest(action, args || {}, signal)
      } catch (err) {
        if (signal && signal.aborted) {
          return { ok: false, action, message: 'aborted' }
        }
        // any daemon failure -> one-shot fallback
        return runAction(action, args || {}, signal)
      }
    },
  }

  const dt = typeof defineTool === 'function' ? defineTool : (loadDefineToolSync() || ((t) => ({ ...t, parameters: { type: 'object', properties: t.parameters } })))
  const res = dt(toolDef)
  if (res && res.parameters && !res.parameters.properties) {
    res.parameters = { type: 'object', properties: res.parameters }
  }
  return res
}

function loadDefineToolSync() {
  try {
    const req = createRequire(import.meta.url)
    const mod = req('@deepseek-ai/dsh-tools')
    diag('defineTool via createRequire: ' + (mod && mod.defineTool ? 'OK' : 'defineTool MISSING'))
    return mod.defineTool || null
  } catch (e) {
    try {
      const runtimePath = path.join(process.env.APPDATA || '', 'com.jeremy.deepx-workbench', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
      const req = createRequire(import.meta.url)
      const mod = req(runtimePath)
      if (mod && mod.defineTool) return mod.defineTool
    } catch { /* ignore */ }
    diag('createRequire path failed: ' + (e && e.message))
    return null
  }
}

async function loadDefineToolAsync() {
  const attempts = []
  const runtimePath = 'file:///' + path.join(process.env.APPDATA || '', 'com.jeremy.deepx-workbench', 'runtime', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js').replace(/\\/g, '/')
  for (const spec of ['@deepseek-ai/dsh-tools', runtimePath]) {
    try {
      const m = await import(spec)
      diag('defineTool via dynamic import OK')
      return m.defineTool
    } catch (e) {
      attempts.push(spec.substring(0, 44) + ': ' + (e && e.message))
    }
  }
  throw new Error('defineTool unavailable - ' + attempts.join(' | '))
}

export function apply(ctx) {
  diag('apply called; ctx.tools=' + (ctx.tools ? 'present' : 'MISSING') + ' register=' + typeof ctx.tools?.register)
  if (typeof ctx.tools?.register !== 'function') {
    console.error('[computer-use] ctx.tools.register unavailable on host ctx; computer tool NOT registered')
    return
  }
  const registerWith = (defineTool) => {
    ctx.tools.register(defineComputerTool(defineTool))
    diag('computer tool registered OK')
    console.log('[computer-use] computer tool registered globally (persistent profile plugin; helper at ' + HELPER_TARGET + ')')
  }
  const syncTool = loadDefineToolSync()
  if (syncTool) {
    try { registerWith(syncTool) } catch (e) { diag('register threw: ' + (e && e.stack || e)); console.error('[computer-use] registration failed:', e) }
    return
  }
  loadDefineToolAsync().then(registerWith).catch((e) => {
    diag('registration FAILED: ' + (e && e.stack || e))
    console.error('[computer-use] registration failed:', e)
  })
}