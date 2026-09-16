// PC-Pilot — persistent DSH host bundle.
// Registers the global model tool `computer` on the host (web) profile:
// UIA accessibility tree + WGC/PrintWindow screenshots + background synthetic-cursor
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
import { defaultBrowserProvider } from './browser-provider.js'
import { PC_PILOT_SKILL, PC_PILOT_SKILL_HINT } from './pc-pilot-skill.js'
import { normalizeComputerAction, OBSERVE_AFTER_ACTIONS, FOREGROUND_RECOVERY_ACTIONS } from './computer-action.js'
import { normalizedExpectation, evaluatePostconditionObservation, remapStableElementForRecovery } from './postconditions.js'
import { createScreenshotAttacher, PC_PILOT_VISIBLE_IMAGE_HISTORY, prunePcPilotImageHistory, suppressDuplicatePcPilotScreenshot } from './image-context.js'

function resolveTempDir() {
  const t = os.tmpdir()
  if (t && !t.startsWith('undefined') && fs.existsSync(t)) return t
  const candidates = [
    process.env.TEMP,
    process.env.TMP,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local', 'Temp') : null,
    'C:\\Users\\Laptop\\AppData\\Local\\Temp',
    'C:\\Windows\\Temp',
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c
  }
  return t
}
const TEMP_DIR = resolveTempDir()
const attachScreenshot = createScreenshotAttacher({ screenshotDir: path.join(TEMP_DIR, 'dsh-cua') })

// Boot diagnostics: every load/registration step appends here so a silent
// loader failure on the host side can be told apart from a code bug.
const DIAG_LOG = path.join(TEMP_DIR, 'dsh-cua-diag.log')
function diag(msg) {
  try { fs.appendFileSync(DIAG_LOG, new Date().toISOString() + ' pid=' + process.pid + ' ' + msg + '\n') } catch { /* best-effort */ }
}
// ponytail: append-only log is unbounded — drop it past 512KB, nobody reads older detail
try { if (fs.statSync(DIAG_LOG).size > 512 * 1024) fs.unlinkSync(DIAG_LOG) } catch { /* first run */ }
diag('module load ' + import.meta.url)

export const name = 'pc-pilot'
const LOG_TAG = '[pc-pilot]'
// cordis: apply(ctx) touches ctx.tools — declare the dependency so apply runs
// only after the tools service is ready (required since the runtime update).
export const inject = ['tools', 'skills']
export { normalizeComputerAction } from './computer-action.js'
export { evaluatePostconditionObservation, remapStableElementForRecovery } from './postconditions.js'
export { prunePcPilotImageHistory, suppressDuplicatePcPilotScreenshot } from './image-context.js'

// portable: never hardcode the Windows directory; honor SystemRoot
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows'
const PS_EXE = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const HELPER_SOURCE = path.join(__dirname, 'pc-pilot-helper.ps1')
const HELPER_TARGET = path.join(TEMP_DIR, 'pc-pilot-helper.ps1')
const OVERLAY_SOURCE = path.join(__dirname, 'virtual-cursor-overlay.ps1')
const OVERLAY_TARGET = path.join(TEMP_DIR, 'virtual-cursor-overlay.ps1')
const STATUSBAR_SOURCE = path.join(__dirname, 'pcpilot-statusbar.ps1')
const STATUSBAR_TARGET = path.join(TEMP_DIR, 'pcpilot-statusbar.ps1')
const WGC_SOURCE = path.join(__dirname, 'wgc')
const WGC_TARGET = path.join(TEMP_DIR, 'dsh-cua-wgc')

let statusbarProcess = null
let statusbarActive = 0
let statusbarHideAt = 0
let statusbarHideTimer = null
async function setStatusbar(show) {
  try {
    await ensureHelper()
    if (show && (!statusbarProcess || statusbarProcess.exitCode !== null)) {
      statusbarProcess = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', STATUSBAR_TARGET], {
        cwd: SYSTEM_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'],
      })
      statusbarProcess.unref()
    }
    const stateDir = path.join(TEMP_DIR, 'dsh-cua')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'status.state'), JSON.stringify({ ts: Date.now(), show }), { encoding: 'ascii', mode: 0o600 })
  } catch (error) {
    diag('statusbar update failed: ' + error.message)
  }
}

async function beginStatusbar() {
  statusbarActive++
  statusbarHideAt = Math.max(statusbarHideAt, performance.now() + 250)
  if (statusbarHideTimer) {
    clearTimeout(statusbarHideTimer)
    statusbarHideTimer = null
  }
  if (statusbarActive === 1) await setStatusbar(true)
}

function endStatusbar() {
  statusbarActive = Math.max(0, statusbarActive - 1)
  if (statusbarActive > 0) return
  const hide = () => {
    statusbarHideTimer = null
    if (statusbarActive > 0) return
    const remaining = statusbarHideAt - performance.now()
    if (remaining > 0) {
      statusbarHideTimer = setTimeout(hide, Math.ceil(remaining))
      statusbarHideTimer.unref?.()
      return
    }
    void setStatusbar(false)
  }
  const remaining = statusbarHideAt - performance.now()
  if (remaining <= 0) {
    hide()
    return
  }
  statusbarHideTimer = setTimeout(hide, Math.ceil(remaining))
  statusbarHideTimer.unref?.()
}

let helperReady = null
function ensureHelper() {
  helperReady ??= (async () => {
    fs.mkdirSync(path.dirname(HELPER_TARGET), { recursive: true })
    fs.copyFileSync(HELPER_SOURCE, HELPER_TARGET)
    try { fs.copyFileSync(OVERLAY_SOURCE, OVERLAY_TARGET) } catch { /* overlay optional */ }
    try { fs.copyFileSync(STATUSBAR_SOURCE, STATUSBAR_TARGET) } catch { /* status pill optional */ }
    // WGC is an optional framework-dependent bridge. Copy it beside the helper
    // so the PowerShell process can use it without loading package-relative paths.
    try { if (fs.existsSync(WGC_SOURCE)) fs.cpSync(WGC_SOURCE, WGC_TARGET, { recursive: true, force: true }) } catch { /* PrintWindow fallback remains available */ }
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

// Windows PowerShell 5.1 can inherit different console code pages across hosts.
// Keep the Node -> helper wire format ASCII-only so JSON Unicode survives
// identically on local desktops and GitHub-hosted Windows runners.
function stringifyHelperJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (ch) =>
    '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'))
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

// Failures after dispatch cannot prove whether the helper performed the action.
function unknownOutcome(action, message) {
  return { ok: false, action, outcome: 'unknown', message: message + '; outcome unknown; inspect state before retrying' }
}

function actionTimeoutMs(action) {
  return action === 'wait' ? 40000 : 20000
}
// PowerShell compiles its native types before starting its watchdog.
const PROCESS_STARTUP_GRACE_MS = 10000
// On Windows a child can consume a large redirected stdin payload, reply, and close
// quickly enough that libuv reports write EOF before the close/stdout events arrive.
// Give close/stdout a short bounded chance to win before treating stdin error as unknown.
const STDIN_ERROR_GRACE_MS = 250
const HOST_TIMEOUT_MS = 200000

// One-shot helper invocation: JSON payload on stdin, JSON reply on stdout.
export async function runAction(action, args, signal) {
  if (signal?.aborted) return { ok: false, action, message: 'aborted' }
  try {
    await ensureHelper()
  } catch (err) {
    return { ok: false, action, message: 'helper copy failed: ' + err.message }
  }
  if (signal?.aborted) return { ok: false, action, message: 'aborted' }
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(PS_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass',
        '-File', HELPER_TARGET,
        '-Action', String(action),
        '-PayloadStdin', '-TimeoutMs', String(actionTimeoutMs(action)),
      ], {
        cwd: SYSTEM_ROOT,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, action, message: 'spawn failed: ' + err.message })
      return
    }
    let settled = false
    let timer
    let stdinErrorTimer
    let stdinErrorMessage = ''
    const chunks = []
    const errChunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(stdinErrorTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const fail = (message) => {
      if (settled) return
      finish(unknownOutcome(action, message))
      // Settlement does not depend on kill succeeding or a close event arriving.
      try { child.kill() } catch { /* best-effort termination */ }
      child.unref()
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.unref?.()
    }
    const onAbort = () => fail('aborted')
    child.stdin.on('error', (err) => {
      if (settled || stdinErrorTimer) return
      stdinErrorMessage = 'stdin error: ' + err.message
      stdinErrorTimer = setTimeout(() => fail(stdinErrorMessage), STDIN_ERROR_GRACE_MS)
      stdinErrorTimer.unref?.()
    })
    child.stdout.on('data', (d) => { if (!settled) chunks.push(d) })
    child.stderr.on('data', (d) => { if (!settled) errChunks.push(d) })
    child.on('error', (err) => fail('process error: ' + err.message))
    child.on('close', (code) => {
      if (settled) return
      const stdout = Buffer.concat(chunks).toString('utf8').trim()
      const stderr = Buffer.concat(errChunks).toString('utf8')
      const value = stdout && extractHelperJson(stdout)
      if (value) {
        finish(value)
        return
      }
      const failureMessage = stdinErrorMessage || (stdout ? 'helper returned non-JSON output' : 'helper produced no output')
      finish({ ...unknownOutcome(action, failureMessage),
        ...(stdout ? { raw: stdout.slice(0, 4000) } : {}), stderr: stderr.slice(0, 4000), exitCode: code })
    })
    timer = setTimeout(() => fail('helper request timed out'), actionTimeoutMs(action) + PROCESS_STARTUP_GRACE_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    try {
      child.stdin.end(stringifyHelperJson(args || {}), 'ascii')
    } catch (err) {
      fail('stdin write failed: ' + err.message)
    }
  })
}

// ---------------------------------------------------------------- persistent helper daemon (Round 1 latency)
// Spawns ONE PowerShell helper with -Server (JSONL over stdio) and reuses it for
// every action, removing the per-action cold start (PS spawn + Add-Type compile).
// One-shot fallback is permitted only before dispatch. Once a write is attempted,
// transport failure means outcome unknown and must never replay the request.
// Two consecutive daemon failures pin future calls to the one-shot path.

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
    diag('pc-pilot daemon circuit breaker OPEN (failStreak=' + daemon.failStreak + ')')
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
  if (daemon.pending.size > 0 || !daemon.child) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (daemon.pending.size === 0) killDaemon()
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
    // stay covered by the ref'd action-specific per-request timer.
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
    child.stdin.on('error', () => {
      if (daemon.child !== child) return
      killDaemon()
      noteDaemonFailure()
    })
    const teardown = () => {
      if (daemon.child !== child) return
      const hadPending = killDaemon()
      if (hadPending) noteDaemonFailure()  // died mid-request = respawn churn
    }
    child.on('close', teardown)
    child.on('error', (err) => {
      diag('pc-pilot daemon process error: ' + err.message)
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
  if (signal && signal.aborted) return Promise.reject(new Error('aborted'))
  return acquireDaemon().then((child) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      if (daemon.pending.size === 0) armIdleKill()
      return
    }
    if (daemon.child !== child) { reject(new Error('daemon unavailable before dispatch')); return }
    const id = daemon.nextId++
    clearIdleKill()  // any new request clears the idle kill timer
    const entry = { timer: null, settled: false, dispatched: false, resolve: null, reject: null }
    const onAbort = () => {
      // simplest correct abort: settle this request, kill the daemon; next action respawns
      entry.reject(new Error('aborted'))
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
      if (daemon.pending.size === 0) armIdleKill()  // successful request -> re-arm the 300s idle kill timer
    }
    entry.reject = (err) => {
      if (entry.dispatched) finish(resolve, unknownOutcome(action, err.message))
      else finish(reject, err)
    }
    daemon.pending.set(id, entry)
    entry.timer = setTimeout(() => {
      // timeout: do NOT fall back to runAction — a slow legit action would be
      // re-executed in full (mutating actions could fire twice). Settle as a
      // soft failure, count it for the circuit breaker, kill the daemon.
      finish(resolve, unknownOutcome(action, 'daemon request timed out'))
      noteDaemonFailure()
      killDaemon()  // next call respawns
    }, actionTimeoutMs(action))
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    try {
      // id/action LAST: args carrying their own `id` key must not clobber the
      // correlation id
      const payload = stringifyHelperJson({ ...(args || {}), id, action }) + '\n'
      if (signal?.aborted) { onAbort(); return }
      // Even a throwing write can have handed bytes to the transport.
      entry.dispatched = true
      child.stdin.write(payload)
    } catch (err) {
      entry.reject(err)
      killDaemon()
    }
  }))
}

const toolDescription = [
  'Windows computer-use for local desktop apps and PC-Pilot-owned Chromium sessions. Desktop actions are background-first; per-window screenshots are occlusion-immune and do not require bringing the target forward.',
  '',
  PC_PILOT_SKILL_HINT,
  '',
  'Reuse the targets the tool returns: keep the same window object or browser { endpoint, tab_id } object through a task when convenient. The legacy browser_endpoint/tab_id fields remain fully supported. get_window_state is screenshot-first; request include_text only when indexed UIA elements, document text, or accessibility status are needed. Every element_index must use the snapshot_id from the same state.',
  '',
  'Prefer semantic actions over coordinates. With a target window, click/scroll/drag coordinates are window-local; use expected_name when a coordinate target can be named. Background actions never imply an automatic foreground fallback. Use foreground dispatch only when the user explicitly requested foreground control.',
  '',
  'Do not add a redundant observation after every action. When post_action_observation or the action result already contains enough evidence, continue from it. Refresh the current window/tab only when a snapshot or element token is stale, the tool returns needs_observation or an unknown outcome, the target changed, or the next action needs information not present in the current result.',
  '',
  'Browser element tokens and compact @eN refs are bound to their current page. Keep the current browser target and recover in place rather than restarting the browser. For a mutating action whose outcome is unknown, inspect the same target and do not repeat the mutation automatically.',
  '',
  'The tool schema defines the available actions and parameters; use the pc-pilot skill only when the task needs the fuller multi-step/recovery discipline.',
].join('\n')
const CONSEQUENTIAL_TARGET = /\b(buy|purchase|pay|delete|remove|send|submit|publish|post|comment|like|react|follow|share|subscribe|confirm|allow|install|login|log\s*in|sign\s*in|transfer)\b/i
const SENSITIVE_TARGET = /\b(password|passcode|secret|token|api\s*key|private\s*key|one[- ]time\s*code|otp|credit\s*card)\b/i
const MAX_BATCH_ACTIONS = 20
const FORBIDDEN_SYSTEM_KEY = /(^|[+,\s])(win|windows|meta|cmd|command|super|os)(?=$|[+,\s])/i

function forbiddenSystemKey(args, action) {
  if (!['press_key', 'hold_key', 'click', 'scroll', 'drag'].includes(action)) return false
  const candidates = [args?.key, args?.modifiers, ...(Array.isArray(args?.keys) ? args.keys : [])]
  return candidates.some((value) => typeof value === 'string' && FORBIDDEN_SYSTEM_KEY.test(value))
}

function safetyFor(args, action) {
  const target = [args?.expected_name, args?.name, args?.perform].filter(Boolean).join(' ')
  const consequential = ['click', 'browser_click', 'perform_secondary_action'].includes(action) && CONSEQUENTIAL_TARGET.test(target)
  const sensitiveTransmission = ['type_text', 'set_value', 'browser_type', 'browser_replace'].includes(action) && SENSITIVE_TARGET.test(target)
  const open = action === 'browser_open' || (action === 'launch_app' && args?.url)
  const wholeFieldReplace = action === 'browser_replace'
  const fileUpload = action === 'browser_upload'
  const reason = fileUpload
    ? 'Selecting local files makes those files available to the current page; PC-Pilot does not submit the surrounding form automatically.'
    : sensitiveTransmission
    ? 'The target appears to be a sensitive field; typing would transmit the value to that application.'
    : consequential
      ? 'The observed target appears to submit, publish, purchase, delete, authenticate, or change account state.'
      : open
        ? 'Opening a URL/navigating a browser tab sends a network request to that site under the AI profile.'
        : wholeFieldReplace
          ? 'browser_replace replaces the entire current content of the target field.'
          : undefined
  return {
    class: consequential || sensitiveTransmission || open || wholeFieldReplace || fileUpload ? 'consequential' : 'routine',
    // PC-Pilot currently runs without an approval interlock. Keep the safety
    // classification, flag and reason in the result so a host policy can gate
    // on it later without changing action detection.
    requires_confirmation: false,
    ...(reason ? { reason } : {}),
  }
}

// A returned Window is immediately reusable as the target of the next
// Windows Computer Use action. Keep the richer PC-Pilot fields too.
function exposeComputerUseResult(value, action) {
  if (!value) return value
  let exposed = value
  if (typeof value.browser_endpoint === 'string' && value.browser_endpoint) {
    exposed = {
      ...value,
      browser: {
        endpoint: value.browser_endpoint,
        ...(typeof value.tab_id === 'string' && value.tab_id ? { tab_id: value.tab_id } : {}),
      },
    }
  }
  if (action === 'list_apps' && Array.isArray(exposed.apps)) {
    return {
      ...exposed,
      apps: exposed.apps.map((app) => ({
        ...app,
        // A running process id is the most precise identifier this runtime can
        // return, and is accepted directly by later list_windows/window calls.
        id: String(app.pid),
        displayName: app.name,
        isRunning: true,
        windows: Array.isArray(app.windows) ? app.windows.map((window) => ({
          ...window,
          id: window.id ?? window.hwnd,
          app: window.app ?? app.name,
        })) : [],
      })),
    }
  }
  if (!['get_window_state', 'get_window', 'launch_app'].includes(action)) return exposed
  const source = exposed.window && typeof exposed.window === 'object' ? exposed.window : exposed
  const id = source.id ?? source.hwnd ?? exposed.hwnd
  const app = source.app ?? source.process_name ?? exposed.process_name
  if (id === undefined || app === undefined) return exposed
  const next = { ...exposed, window: { ...source, id, app } }
  if (action === 'get_window_state') {
    next.screenshots = exposed.screenshot?.path ? [{
      id: exposed.screenshot_id ?? exposed.screenshot.id,
      path: exposed.screenshot.path,
      originX: exposed.screenshot.window_rect?.x,
      originY: exposed.screenshot.window_rect?.y,
    }] : []
  }
  if (action === 'get_window_state') {
    next.accessibility = exposed.accessibility ?? null
  }
  return next
}

export function defineComputerTool(defineTool, ctx, options = {}) {
  // Cordis host contexts are guarded service proxies: merely reading an
  // uninjected optional property throws. Browser overrides belong to this
  // function's explicit options bag, so never probe the host context for one.
  const browserProvider = options.browserProvider || defaultBrowserProvider
  // Endpoints are capabilities for the isolated Chromium process PC-Pilot
  // launched in this tool instance. Keep ownership local: a caller cannot use
  // browser_shutdown to terminate an arbitrary loopback debugging browser.
  const ownedBrowserEndpoints = new Map()
  const parameters = {
      action: {
        type: 'string',
        enum: [
          // ChatGPT Windows Computer Use action names. These are the only
          // model-facing desktop action names.
          'list_apps', 'list_windows', 'get_window', 'launch_app', 'get_window_state',
          'click', 'press_key', 'type_text', 'scroll', 'set_value', 'drag',
          'perform_secondary_action', 'activate_window', 'minimize_window',
          // OpenAI Responses computer-use spellings, normalized to the same
          // canonical desktop actions before dispatch.
          'double_click', 'type', 'keypress', 'move',
          // PC-Pilot extensions without a corresponding Windows CU method.
          'wait', 'screenshot', 'close_window', 'select_text',
          'read_clipboard', 'write_clipboard', 'mouse_down', 'mouse_up', 'hold_key', 'list_displays',
          'zoom', 'switch_display', 'cursor_position', 'get_app_identity',
          'browser_open', 'browser_navigate', 'browser_activate', 'browser_close', 'browser_shutdown', 'browser_tabs', 'browser_events', 'browser_downloads', 'browser_history', 'browser_back', 'browser_forward', 'browser_wait', 'browser_state', 'browser_observe', 'browser_read', 'browser_request', 'browser_click', 'browser_click_point', 'browser_click_text', 'browser_type', 'browser_replace', 'browser_upload', 'browser_key', 'browser_scroll', 'browser_scroll_to_text', 'browser_reload',
        ],
        description: 'What to do on the desktop.',
      },
      actions: { type: 'array', items: { type: 'json' }, description: `Ordered computer-use actions to execute sequentially (maximum ${MAX_BATCH_ACTIONS}); execution stops at the first failed or uncertain step. A step may use when as a precondition and expect as a verified postcondition, so short predictable sequences can avoid a model round trip without becoming a workflow DSL.` },
      app: { type: 'string', description: 'Target app: pid number, process name, or window-title substring (omit for global input). get_app_identity also accepts a pid encoded as a string even when the process has no top-level window.' },
      identity_key: { type: 'string', description: 'Exact app identity returned by list_apps/list_windows/get_window/get_app_identity. Prefer this over process-name/title matching when continuing work in a known app. Packaged apps use aumid:<AUMID>; Win32 apps use win32:<full executable path>.' },
      verify_signature: { type: 'boolean', description: 'get_app_identity only: verify the executable Authenticode signature and return signer publisher/subject/thumbprint. Default true; results are cached by executable path.' },
      hwnd: { type: 'number', description: 'Target window handle (HWND) for direct targeting (activate_window, close_window, get_window, get_app_identity, or input actions).' },
      window: { type: 'object', properties: { id: { type: 'number' }, app: { type: 'string' } }, additionalProperties: false, description: 'ChatGPT Computer Use Window compatibility object. Its id maps to hwnd and app maps to the target app.' },
      name: { type: 'string', description: 'Application name, executable path, or registered Windows activation protocol such as ms-settings:display (for launch_app). A protocol/delegated launch returns a window only when one newly-created window can be identified safely.' },
      activate: { type: 'boolean', description: 'launch_app only: start normally and allow the app to become foreground. Default false keeps the new window normally renderable but non-activated and places it behind the active work; use true only when the user explicitly asked to bring it forward.' },
      url: { type: 'string', description: 'Initial URL passed to a Chromium browser launched by launch_app.' },
      window_index: { type: 'number', description: '1-based window index when the app has several matching windows (optional).' },
      snapshot_id: { type: 'string', description: 'Required for actions using element_index. Use a fresh snapshot_id from the state that supplied that element, including post_action_observation when available; mutations invalidate older snapshots.' },
      element: { type: 'number', description: 'Internal element index field; use element_index.' },
      element_index: { type: 'number', description: 'Element index from the latest get_window_state for click, set_value, perform_secondary_action, select_text, or type_text.' },
      browser_element: { type: 'string', description: 'Element token or short @eN ref from the latest browser_state/browser_observe; use this for browser_click/browser_type/browser_replace/browser_upload/browser_key.' },
      files: { type: 'array', items: { type: 'string' }, description: 'browser_upload only: 1-20 explicit absolute local file paths. PC-Pilot selects them on an already-observed file input but does not submit the surrounding form.' },
      expected_name: { type: 'string', description: 'For click: expected UI element name at the target point; guards against clicking a changed target.' },
      coordinate_space: { type: 'string', enum: ['screen', 'window'], description: 'For click with app/hwnd: window-relative is the default and matches Computer Use; screen explicitly uses absolute screen coordinates. Without app/hwnd coordinates are always screen-relative.' },
      x: { type: 'number', description: 'Window-local X (with app) or screen X (without app).' },
      y: { type: 'number', description: 'Window-local Y (with app) or screen Y (without app).' },
      text: { type: 'string', description: 'Text to type via unicode input, or text payload to write to clipboard for write_clipboard.' },
      end: { type: 'number', description: 'browser_replace only: exclusive end character for a contenteditable range replacement.' },
      key: { type: 'string', description: 'Key name or chord for press_key: Return, Enter, Escape, ctrl+c, Control_L+a, alt+f4, ctrl+shift+p, Tab, Backspace, Delete, Home, End, PageUp, PageDown, Arrow keys, Space, PrintScreen, CapsLock, F1-F24, a-z, 0-9, punctuation.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Optional key chord or mouse modifiers, for example ["CTRL", "A"] or ["SHIFT"].' },
      modifiers: { type: 'string', description: 'Comma-separated modifier keys for key action: ctrl, shift, alt, win.' },
      button: { type: 'string', enum: ['left', 'right', 'middle', 'wheel', 'back', 'forward'], description: 'Mouse button for click and mouse_down/mouse_up (default left). wheel is the OpenAI name for the middle button; back and forward are the physical extended buttons.' },
      mouse_button: { type: 'string', enum: ['left', 'right', 'middle', 'wheel', 'back', 'forward', 'l', 'r', 'm'], description: 'ChatGPT Computer Use alias for button.' },
      click_count: { type: 'number', description: 'Click repetitions for click: 1 single (default), 2 double, 3 triple.' },
      duration_ms: { type: 'number', description: 'Hold duration in milliseconds for hold_key (default 500, max 10000).' },
      amount: { type: 'number', description: 'Scroll wheel notches (positive integer, default 3).' },
      direction: { type: 'string', enum: ['down', 'up', 'left', 'right'], description: 'Scroll direction (default down).' },
      from_x: { type: 'number', description: 'Drag start window-local X.' },
      from_y: { type: 'number', description: 'Drag start window-local Y.' },
      to_x: { type: 'number', description: 'Drag end window-local X.' },
      to_y: { type: 'number', description: 'Drag end window-local Y.' },
      path: { type: 'array', items: {
        type: 'object',
        properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } },
        additionalProperties: false,
      }, description: 'For drag: standard computer-use ordered path using {x, y} points; foreground follows every point.' },
      screenshot_path: { type: 'string', description: 'For zoom: absolute source screenshot path returned by screenshot or get_window_state.' },
      scroll_x: { type: 'number', description: 'Standard computer-use horizontal wheel delta; positive scrolls right and negative scrolls left.' },
      scroll_y: { type: 'number', description: 'Standard computer-use vertical wheel delta; positive scrolls down and negative scrolls up.' },
      scrollX: { type: 'number', description: 'ChatGPT Computer Use alias for scroll_x.' },
      scrollY: { type: 'number', description: 'ChatGPT Computer Use alias for scroll_y.' },
      value: { type: 'string', description: 'Text value to set on the target element (set_value).' },
      start: { type: 'number', description: 'Character offset for select_text (start of range, or caret when length is 0), or zero-based start character for browser_replace range replacement.' },
      length: { type: 'number', description: 'Character count for select_text (0 places the caret only).' },
      perform: { type: 'string', description: 'Internal action field; use secondary_action.' },
      secondary_action: { type: 'string', description: 'Action for perform_secondary_action: invoke (aliases press/click), toggle (alias switch), select, add_to_selection, remove_from_selection, expand, collapse, focus (alias set_focus), scroll_up, scroll_down, scroll_left, scroll_right.' },
      display: { type: 'number', description: '1-based display index for screenshot/switch_display (default: primary).' },
      width: { type: 'number', description: 'Region/crop size in pixels (screenshot region, zoom crop).' },
      height: { type: 'number', description: 'Region/crop size in pixels (screenshot region, zoom crop).' },
      duration_s: { type: 'number', description: 'Seconds to wait for the wait action (0-30, default 1).' },
      wait_for: { type: 'string', enum: ['accessibility_present', 'accessibility_available'], description: 'Optional wait condition for a target window. accessibility_present waits for any usable UIA descendant; accessibility_available waits for a complete tree. Timeout returns wait_condition_timeout with the last accessibility_status and is safe to retry.' },
      element_id: { type: 'string', description: 'Stable UIA element identity returned by get_window_state. Optional for normal snapshot-bound actions; required to safely remap an element during foreground_once recovery.' },
      expect: { type: 'object', properties: {
        type: { type: 'string', enum: ['window_exists', 'window_closed', 'accessibility_changed', 'element_value', 'text_present', 'browser_url', 'browser_text', 'browser_ready', 'download_completed'] },
        element_id: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, filename: { type: 'string' },
        match: { type: 'string', enum: ['exact', 'contains', 'prefix'] },
        timeout_ms: { type: 'number' },
      }, additionalProperties: false, description: 'Optional postcondition. PC-Pilot observes after the action and returns postcondition.ok; a failed postcondition never blindly replays a possibly completed mutation.' },
      when: { type: 'object', properties: {
        type: { type: 'string', enum: ['window_exists', 'window_closed', 'accessibility_changed', 'element_value', 'text_present', 'browser_url', 'browser_text', 'browser_ready', 'download_completed'] },
        element_id: { type: 'string' }, value: { type: 'string' }, text: { type: 'string' }, url: { type: 'string' }, filename: { type: 'string' },
        match: { type: 'string', enum: ['exact', 'contains', 'prefix'] },
        timeout_ms: { type: 'number' },
      }, additionalProperties: false, description: 'Optional precondition checked before the action. Default timeout is 0 (check current state once); set timeout_ms only when a bounded wait is useful. If unmet, the action is not executed. In actions batches this is a lightweight gate, not a branching workflow language.' },
      recovery: { type: 'string', enum: ['none', 'foreground_once'], description: 'Optional deterministic recovery. foreground_once retries only when the background attempt explicitly reports not_executed + background_unavailable. Unknown outcomes are never replayed; element recovery requires element_id so a fresh index/snapshot can be remapped safely.' },
      screenshot: { type: 'boolean', description: 'Internal screenshot field; use include_screenshot for get_window_state.' },
      include_screenshot: { type: 'boolean', description: 'Capture a per-window PNG screenshot in get_window_state (default true).' },
      include_text: { type: 'boolean', description: 'Include the indexed UI Automation tree and document text in get_window_state (default false, matching ChatGPT Computer Use screenshot-first observations). With a window-targeted wait, also include it in the post-wait observation. accessibility.status distinguishes available, partial, and unavailable UIA trees.' },
      screenshot_id: { type: 'string', description: 'ID of the screenshot/state used to choose coordinates. Desktop coordinate actions and browser_click_point bind to this observed frame; expired, wrong-window, wrong-tab, or changed-document IDs are rejected.' },
      screenshotId: { type: 'string', description: 'Camel-case alias for screenshot_id.' },
      dispatch: { type: 'string', enum: ['background', 'foreground'], description: 'background (default): UIA patterns + WM_CHAR/WM_KEY/WM_MOUSEWHEEL, never steals focus. foreground: real SendInput, brings window forward — pick it per task only when the user asked for real control or the essential action has no background path, and say so. Some actions report background_unavailable when the target has no background path.' },
      overlay: { type: 'boolean', description: 'Show the small codex-style click-through cursor glyph and the top-center "PC-Pilot 运行中" status pill with a breathing green dot (default true). Set false to hide both.' },
      browser: { type: 'object', properties: { endpoint: { type: 'string' }, tab_id: { type: 'string' } }, additionalProperties: false, description: 'Reusable browser target returned by PC-Pilot. Pass it back unchanged instead of repeating browser_endpoint/tab_id when convenient.' },
      browser_endpoint: { type: 'string', description: 'Explicit loopback DevTools WebSocket endpoint of an AI-owned isolated browser profile; browser.endpoint is the reusable object form.' },
      tab_id: { type: 'string', description: 'Exact tab id returned by browser state/open; browser.tab_id is the reusable object form.' },
      expected_url: { type: 'string', description: 'Exact observed page URL; reject browser operation if navigation changed it.' },
      headless: { type: 'boolean', description: 'launch_app Chromium only: launch without any desktop window, using a separate persistent AI profile. Continue through browser_* actions.' },
      include_url: { type: 'boolean', description: 'browser_tabs or browser_state without tab_id: also return each tab url/title (default false — ids only).' },
      with_screenshot: { type: 'boolean', description: 'browser_state/browser_observe only: include a CDP viewport screenshot with screenshot_id. Use that exact id for browser_click_point.' },
      browser_wait_for: { type: 'string', enum: ['ready', 'url_change', 'text'], description: 'browser_wait condition: document ready, URL changed from expected_url, or page text contains text.' },
      browser_wait_timeout_ms: { type: 'number', description: 'browser_wait timeout in milliseconds (0-30000, default 10000).' },
      event_cursor: { type: 'string', description: 'Opaque cursor returned by browser_state/browser_events/browser_downloads; pass it back to receive only newer browser events while preserving reset/truncation detection.' },
      command_timeout_ms: { type: 'number', description: 'browser_* only: per-CDP-command timeout in milliseconds (2000-30000, default 12000). Raise for slow pages; error pages still fail fast.' },
      capture_network_wait_ms: { type: 'number', description: 'browser_click with capture_network only: bounded post-click evidence wait in milliseconds (0-10000, default 1500). Use for a known asynchronous submit before declaring its outcome unknown.' },
  }

  async function observeAfterAction(action, requestArgs, signal) {
    if (!OBSERVE_AFTER_ACTIONS.has(action)) return null
    const observationArgs = requestArgs.app
      ? { app: requestArgs.app, hwnd: requestArgs.hwnd, window_index: requestArgs.window_index, screenshot: true, include_text: requestArgs.include_text === true, dispatch: 'background' }
      : { display: requestArgs.display, dispatch: 'background' }
    try {
      const value = await daemonRequest(requestArgs.app ? 'get_window_state' : 'screenshot', observationArgs, signal)
      return value?.path && !value.screenshot ? { ...value, screenshot: { path: value.path, screenshot_id: value.screenshot_id, width: value.width, height: value.height, rect: value.rect, viewport: value.viewport } } : value
    } catch (err) {
      if (signal?.aborted) return { ok: false, outcome: 'not_executed', error_code: 'observation_aborted', message: 'post-action observation aborted' }
      try {
        const value = await runAction(requestArgs.app ? 'get_window_state' : 'screenshot', observationArgs, signal)
        return value?.path && !value.screenshot ? { ...value, screenshot: { path: value.path, screenshot_id: value.screenshot_id, width: value.width, height: value.height, rect: value.rect, viewport: value.viewport } } : value
      } catch (fallbackErr) {
        return { ok: false, outcome: 'unknown', error_code: 'observation_failed', message: fallbackErr.message || err.message }
      }
    }
  }

  async function observeForPostcondition(expect, requestArgs, actionResult, signal) {
    const e = normalizedExpectation(expect)
    if (!e) return null
    const browser = e.type.startsWith('browser_') || e.type === 'download_completed'
    if (browser) {
      const browser_endpoint = requestArgs.browser_endpoint
      const tab_id = requestArgs.tab_id || actionResult?.tab_id
      if (!browser_endpoint) return { ok: false, outcome: 'not_executed', error_code: 'postcondition_target_missing', message: 'browser_endpoint required for browser postcondition' }
      if (e.type === 'download_completed') return browserProvider.execute('browser_downloads', { browser_endpoint }, signal)
      if (!tab_id) return { ok: false, outcome: 'not_executed', error_code: 'postcondition_target_missing', message: 'tab_id required for browser postcondition' }
      if (e.type === 'browser_ready') return browserProvider.execute('browser_wait', { browser_endpoint, tab_id, browser_wait_for: 'ready', browser_wait_timeout_ms: Math.min(30000, e.timeout_ms) }, signal)
      if (e.type === 'browser_text') return browserProvider.execute('browser_read', { browser_endpoint, tab_id }, signal)
      return browserProvider.execute('browser_state', { browser_endpoint, tab_id }, signal)
    }

    const target = { app: requestArgs.app, identity_key: requestArgs.identity_key, hwnd: requestArgs.hwnd, window_index: requestArgs.window_index, dispatch: 'background' }
    if (e.type === 'window_exists' || e.type === 'window_closed') {
      if (!target.app && !target.identity_key && target.hwnd === undefined) return { ok: false, error_code: 'postcondition_target_missing' }
      try { return await daemonRequest('get_window', target, signal) }
      catch { return { ok: false, outcome: 'not_executed' } }
    }
    if (!target.app && !target.identity_key && target.hwnd === undefined) return { ok: false, error_code: 'postcondition_target_missing' }
    const stateArgs = { ...target, screenshot: false, include_text: true }
    try { return await daemonRequest('get_window_state', stateArgs, signal) }
    catch { return runAction('get_window_state', stateArgs, signal) }
  }

  async function verifyPostcondition(expect, requestArgs, actionResult, signal) {
    const e = normalizedExpectation(expect)
    if (!e) return null
    const started = Date.now()
    let lastObservation = actionResult?.post_action_observation || null
    let lastEvaluation = lastObservation ? evaluatePostconditionObservation(e, lastObservation) : null
    if (lastEvaluation?.ok) return { ...lastEvaluation, verified: true, waited_ms: 0 }
    if (e.type === 'accessibility_changed' && lastObservation?.accessibility_delta && !lastObservation.accessibility_delta.reset) {
      return { ...lastEvaluation, verified: false, waited_ms: 0 }
    }
    while (true) {
      signal?.throwIfAborted?.()
      lastObservation = await observeForPostcondition(e, requestArgs, actionResult, signal)
      lastEvaluation = evaluatePostconditionObservation(e, lastObservation)
      if (lastEvaluation.ok) {
        return { ...lastEvaluation, verified: true, waited_ms: Date.now() - started }
      }
      if (e.type === 'accessibility_changed' && lastEvaluation.reason === 'accessibility_baseline_unavailable') {
        return { ...lastEvaluation, verified: false, waited_ms: Date.now() - started }
      }
      if (Date.now() - started >= e.timeout_ms) {
        return { ...lastEvaluation, verified: false, waited_ms: Date.now() - started, timed_out: true }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  async function verifyPrecondition(raw, requestArgs, signal) {
    const prepared = raw && typeof raw === 'object' && !Array.isArray(raw) && raw.timeout_ms === undefined
      ? { ...raw, timeout_ms: 0 }
      : raw
    const condition = normalizedExpectation(prepared)
    if (!condition) return null
    const started = Date.now()
    while (true) {
      signal?.throwIfAborted?.()
      let observation
      try {
        observation = await observeForPostcondition(condition, requestArgs, null, signal)
      } catch (err) {
        return {
          type: condition.type,
          ok: false,
          verified: false,
          reason: 'observation_failed',
          message: err?.message || String(err),
          waited_ms: Date.now() - started,
        }
      }
      const evaluation = evaluatePostconditionObservation(condition, observation)
      if (evaluation.ok) return { ...evaluation, verified: true, waited_ms: Date.now() - started }
      if (condition.type === 'accessibility_changed' && evaluation.reason === 'accessibility_baseline_unavailable') {
        return { ...evaluation, verified: false, waited_ms: Date.now() - started }
      }
      if (Date.now() - started >= condition.timeout_ms) {
        return {
          ...evaluation,
          verified: false,
          waited_ms: Date.now() - started,
          ...(condition.timeout_ms > 0 ? { timed_out: true } : {}),
          ...(observation?.error_code ? { observation_error_code: observation.error_code } : {}),
        }
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  async function maybeRecoverForeground(result, requestArgs, action, invokeNative, signal) {
    if (requestArgs.recovery !== 'foreground_once') return result
    if (requestArgs.dispatch === 'foreground' || !FOREGROUND_RECOVERY_ACTIONS.has(action)) return result
    if (result?.ok !== false || result?.outcome !== 'not_executed' || result?.error_code !== 'background_unavailable') return result

    let retryArgs = { ...requestArgs, dispatch: 'foreground', recovery: 'none' }
    if (retryArgs.element !== undefined) {
      const target = { app: retryArgs.app, identity_key: retryArgs.identity_key, hwnd: retryArgs.hwnd, window_index: retryArgs.window_index, screenshot: false, include_text: true, dispatch: 'background' }
      let state
      try { state = await daemonRequest('get_window_state', target, signal) }
      catch { state = await runAction('get_window_state', target, signal) }
      const remapped = remapStableElementForRecovery(retryArgs, state)
      if (!remapped.ok) {
        return { ...result, recovery: { attempted: false, mode: 'foreground_once', reason: remapped.reason } }
      }
      retryArgs = remapped.args
    }
    const retry = await invokeNative(retryArgs)
    return {
      ...retry,
      recovery: {
        attempted: true,
        mode: 'foreground_once',
        from_error_code: 'background_unavailable',
        recovered: retry?.ok === true,
        ...(retryArgs.element !== undefined ? { remapped_element_index: retryArgs.element, element_id: requestArgs.element_id } : {}),
      },
    }
  }

  async function executeSingleAction(args, exec, options = {}) {
      const normalized = normalizeComputerAction(args)
      const action = normalized.action
      const requestArgs = normalized.args
      const signal = exec ? exec.signal : undefined
      let expectation
      try { expectation = normalizedExpectation(requestArgs.expect) }
      catch (err) {
        return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'invalid_postcondition', message: err.message }
      }
      let precondition
      try {
        const rawWhen = requestArgs.when && typeof requestArgs.when === 'object' && !Array.isArray(requestArgs.when) && requestArgs.when.timeout_ms === undefined
          ? { ...requestArgs.when, timeout_ms: 0 }
          : requestArgs.when
        precondition = normalizedExpectation(rawWhen)
      } catch (err) {
        return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'invalid_precondition', message: err.message }
      }
      if (forbiddenSystemKey(requestArgs, action)) {
        return {
          ok: false,
          action: normalized.requestedAction,
          outcome: 'not_executed',
          error_code: 'unsupported_system_key',
          message: 'Windows/Meta/Command system keys are not supported by PC-Pilot computer use.',
          safety: { class: 'routine', requires_confirmation: false },
        }
      }
      let preconditionResult = null
      if (precondition) {
        try { preconditionResult = await verifyPrecondition(requestArgs.when, requestArgs, signal) }
        catch (err) {
          if (signal?.aborted) return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'precondition_aborted', message: 'Precondition observation aborted.' }
          return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'precondition_observation_failed', message: err?.message || String(err) }
        }
        if (!preconditionResult?.ok) {
          return {
            ok: false,
            action: normalized.requestedAction,
            outcome: 'not_executed',
            error_code: preconditionResult?.reason === 'observation_failed' ? 'precondition_observation_failed' : 'precondition_not_met',
            retry_safe: true,
            message: 'Precondition was not verified; the action was not executed.',
            precondition: preconditionResult,
            safety: safetyFor(args, normalized.requestedAction),
          }
        }
      }
      if (action.startsWith('browser_')) {
        await beginStatusbar()
        try {
          const browserArgs = { ...requestArgs }
          if (browserArgs.element === undefined && browserArgs.browser_element !== undefined) browserArgs.element = browserArgs.browser_element
          if (action === 'browser_shutdown' && !ownedBrowserEndpoints.has(browserArgs.browser_endpoint)) {
            return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'browser_not_owned', message: 'browser_shutdown is limited to an isolated browser launched by this PC-Pilot tool instance.' }
          }
          const browserResult = await browserProvider.execute(action, browserArgs, signal)
          if (action === 'browser_shutdown' && browserResult.ok) ownedBrowserEndpoints.delete(browserArgs.browser_endpoint)
          const browserObservation = browserResult.screenshot
            ? { ok: true, action: 'screenshot', outcome: 'completed', screenshot: browserResult.screenshot }
             : (['browser_tabs', 'browser_events', 'browser_downloads', 'browser_history', 'browser_wait', 'browser_state', 'browser_observe', 'browser_read', 'browser_request', 'browser_open', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_activate', 'browser_close', 'browser_shutdown'].includes(action) ? null : { ok: false, action: 'screenshot', outcome: 'unknown', error_code: 'observation_failed', message: 'browser mutation completed without a post-action screenshot' })
          const observationFailed = browserObservation?.ok === false
          const resultEndpoint = browserResult.browser_endpoint || browserArgs.browser_endpoint
          const resultTab = browserResult.tab_id || browserArgs.tab_id
          const browserTarget = typeof resultEndpoint === 'string' && resultEndpoint
            ? { endpoint: resultEndpoint, ...(typeof resultTab === 'string' && resultTab ? { tab_id: resultTab } : {}) }
            : null
          const value = { ...browserResult, ...(browserTarget ? { browser: browserTarget } : {}), ok: browserResult.ok !== false && !observationFailed, action, outcome: browserResult.outcome || (observationFailed ? 'unknown' : ['browser_state', 'browser_observe'].includes(action) ? 'completed' : 'dispatched'),
            ...(preconditionResult ? { precondition: preconditionResult } : {}),
            ...(browserObservation ? { post_action_observation: browserObservation } : {}) }
          if (value.ok && expectation) {
            value.postcondition = await verifyPostcondition(expectation, browserArgs, value, signal)
            if (!value.postcondition?.ok) {
              value.ok = false
              value.outcome = 'unknown'
              value.error_code = 'postcondition_failed'
              value.message = 'Browser action completed but the requested postcondition was not verified.'
            }
          }
          value.safety = safetyFor(args, normalized.requestedAction)
          return normalized.requestedAction === action ? value : { ...value, action: normalized.requestedAction, normalized_action: action }
        } catch (err) {
          return { ok: false, action: normalized.requestedAction, outcome: err.outcome || 'not_executed', error_code: 'browser_action_rejected', message: err.message }
        } finally {
          endStatusbar()
        }
      }
      try {
        // Persistent daemon first (no per-action cold start). A pre-dispatch
        // daemon failure may use the one-shot fallback; post-dispatch failures
        // resolve as unknown and are never replayed.
        const invokeNative = async (nativeArgs) => {
          try { return await daemonRequest(action, nativeArgs, signal) }
          catch (err) { return runAction(action, nativeArgs, signal) }
        }
        let value
        if (action === 'scroll' && Array.isArray(requestArgs.scroll_components) && requestArgs.scroll_components.length > 1) {
          const completed = []
          for (const component of requestArgs.scroll_components) {
            const nativeArgs = { ...requestArgs, ...component }
            delete nativeArgs.scroll_components
            const part = await invokeNative(nativeArgs)
            if (!part?.ok || ['unknown', 'not_executed'].includes(part.outcome)) {
              value = completed.length === 0 ? part : {
                ...part,
                ok: false,
                outcome: 'unknown',
                error_code: 'partial_scroll',
                completed_components: completed,
                message: 'A multi-axis scroll completed only some axes; re-observe before retrying.',
              }
              break
            }
            completed.push({ direction: component.direction, amount: component.amount })
          }
          value ??= { ok: true, action: 'scroll', outcome: 'completed', scroll_components: completed, message: 'Completed multi-axis scroll.' }
        } else {
          value = await invokeNative(requestArgs)
        }
        let result = exposeComputerUseResult(normalized.requestedAction === action ? value : { ...value, action: normalized.requestedAction, normalized_action: action }, action)
        result = await maybeRecoverForeground(result, requestArgs, action, invokeNative, signal)
        result = exposeComputerUseResult(normalized.requestedAction === action ? result : { ...result, action: normalized.requestedAction, normalized_action: action }, action)
        if (preconditionResult) result.precondition = preconditionResult
        if (action === 'launch_app' && result?.headless && result?.browser_profile_owned && typeof result.browser_endpoint === 'string' && Number.isSafeInteger(result.pid)) {
          ownedBrowserEndpoints.set(result.browser_endpoint, { pid: result.pid })
        }
        if (options.observe !== false && result?.ok && OBSERVE_AFTER_ACTIONS.has(action)) {
          const semanticExpectation = expectation && ['accessibility_changed', 'element_value', 'text_present'].includes(expectation.type)
          result.post_action_observation = await observeAfterAction(action, semanticExpectation ? { ...requestArgs, include_text: true } : requestArgs, signal)
          if (!result.post_action_observation?.ok) {
            result.ok = false
            result.outcome = 'unknown'
          }
        }
        if (result?.ok && expectation) {
          result.postcondition = await verifyPostcondition(expectation, requestArgs, result, signal)
          if (!result.postcondition?.ok) {
            result.ok = false
            result.outcome = 'unknown'
            result.error_code = 'postcondition_failed'
            result.message = 'Action completed but the requested postcondition was not verified.'
          }
        }
        result.safety ??= safetyFor(args, action)
        return result
      } catch (err) {
        if (signal && signal.aborted) {
          return { ok: false, action: normalized.requestedAction, message: 'aborted' }
        }
        return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'native_action_rejected', message: err.message }
      }
  }

  async function executeAction(args, exec) {
    if (!Array.isArray(args?.actions)) return executeSingleAction(args, exec)
    if (args.actions.length > MAX_BATCH_ACTIONS) {
      return { ok: false, action: 'batch', outcome: 'not_executed', error_code: 'batch_limit_exceeded', max_actions: MAX_BATCH_ACTIONS, message: `At most ${MAX_BATCH_ACTIONS} actions may be sent in one batch.` }
    }
    const inherited = {}
    for (const key of ['app', 'identity_key', 'hwnd', 'window_index', 'snapshot_id', 'browser', 'browser_endpoint', 'tab_id', 'dispatch', 'overlay', 'display', 'confirmation', 'include_text', 'wait_for', 'recovery']) {
      if (args[key] !== undefined) inherited[key] = args[key]
    }
    const steps = []
    let lastRequest
    for (let index = 0; index < args.actions.length; index++) {
      const item = args.actions[index]
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.action !== 'string') {
        steps.push({ ok: false, action: 'batch', outcome: 'not_executed', error_code: 'invalid_batch_step', message: 'Each batch item must be an action object.' })
        return { ok: false, action: 'batch', outcome: 'not_executed', failed_index: index, completed_count: index, steps }
      }
      if (Array.isArray(item.actions)) {
        steps.push({ ok: false, action: item.action, outcome: 'not_executed', error_code: 'nested_batch_not_allowed', message: 'Nested action batches are not allowed.' })
        return { ok: false, action: 'batch', outcome: 'not_executed', failed_index: index, completed_count: index, steps }
      }
      const request = { ...inherited, ...item }
      const step = await executeSingleAction(request, exec, { observe: false })
      steps.push(step)
      if (!step?.ok || ['unknown', 'not_executed'].includes(step.outcome)) {
        return { ok: false, action: 'batch', outcome: step.outcome || 'not_executed', failed_index: index, completed_count: index, steps }
      }
      lastRequest = request
    }
    const lastAction = steps.length > 0 ? normalizeComputerAction(lastRequest).action : null
    if (lastAction && OBSERVE_AFTER_ACTIONS.has(lastAction)) {
      const observation = await observeAfterAction(lastAction, normalizeComputerAction(lastRequest).args, exec?.signal)
      if (observation) steps.at(-1).post_action_observation = observation
      if (!observation?.ok) {
        steps.at(-1).ok = false
        steps.at(-1).outcome = observation?.outcome === 'not_executed' ? 'not_executed' : 'unknown'
      }
    }
    const finalStep = steps.at(-1)
    const uncertain = finalStep && ['unknown', 'not_executed'].includes(finalStep.outcome)
    return { ok: !uncertain, action: 'batch', outcome: uncertain ? finalStep.outcome : 'completed', completed_count: steps.length, steps,
      ...(steps.at(-1)?.post_action_observation ? { post_action_observation: steps.at(-1).post_action_observation } : {}) }
  }

  const toolDef = {
    name: 'computer',
    description: toolDescription,
    parameters,
    timeoutMs: HOST_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        let text
        try {
          const { screenshot_attachment: _attachment, ...modelValue } = value || {}
          text = JSON.stringify(modelValue, null, 1)
        } catch (e) {
          text = String(value)
        }
        if (text.length > 400000) text = text.slice(0, 400000) + '\n...[truncated JSON]'
        const blocks = [{ type: 'text', text }]
        if (value?.screenshot_attachment) blocks.push({ type: 'image', attachment: value.screenshot_attachment })
        return blocks
      },
    },
    async execute(args, exec) {
      const startedAt = new Date().toISOString()
      const started = performance.now()
      const value = await executeAction(args, exec)
      const attached = await attachScreenshot(value, args, exec, ctx)
      const result = suppressDuplicatePcPilotScreenshot(attached, exec?.agent?.session)
      try {
        const keepExisting = result?.screenshot_attachment
          ? Math.max(0, PC_PILOT_VISIBLE_IMAGE_HISTORY - 1)
          : PC_PILOT_VISIBLE_IMAGE_HISTORY
        const pruned = prunePcPilotImageHistory(exec?.agent?.session, keepExisting)
        if (pruned.pruned > 0) {
          diag(`image history pruned=${pruned.pruned} remaining_before_current=${pruned.remaining}`)
        }
      } catch (error) {
        // Context hygiene must never turn a completed computer action into a retry.
        diag('image history prune failed: ' + (error?.message || String(error)))
      }
      return { ...result, timing: { started_at: startedAt, finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started) } }

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
  diag('apply called; ctx.tools=' + (ctx.tools ? 'present' : 'MISSING') + ' register=' + typeof ctx.tools?.register + ' ctx.skills=' + (ctx.skills ? 'present' : 'MISSING'))
  if (typeof ctx.tools?.register !== 'function') {
    console.error(LOG_TAG + ' ctx.tools.register unavailable on host ctx; computer tool NOT registered')
    return
  }
  if (typeof ctx.skills?.register === 'function') {
    ctx.skills.register(PC_PILOT_SKILL)
    diag('pc-pilot runtime skill registered OK')
  } else {
    diag('ctx.skills.register unavailable; pc-pilot skill NOT registered')
  }
  const registerWith = (defineTool) => {
    ctx.tools.register(defineComputerTool(defineTool, ctx))
    diag('computer tool registered OK')
    console.log(LOG_TAG + ' computer tool registered globally (persistent profile plugin; helper at ' + HELPER_TARGET + ')')
    ensureHelper().catch(() => { /* helper distribution failed; nothing to bootstrap */ })
  }
  const syncTool = loadDefineToolSync()
  try {
    // defineComputerTool has a deterministic plain-object fallback, so tool
    // registration never depends on an async module-resolution race.
    registerWith(syncTool || null)
  } catch (e) {
    diag('register threw: ' + (e && e.stack || e))
    console.error(LOG_TAG + ' registration failed:', e)
  }
}
