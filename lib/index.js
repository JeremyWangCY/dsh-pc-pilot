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
import { browserAction } from './browser-session.js'
import { PC_PILOT_SKILL, PC_PILOT_SKILL_HINT } from './pc-pilot-skill.js'

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
    if (statusbarActive === 0 && performance.now() >= statusbarHideAt) void setStatusbar(false)
  }
  const remaining = Math.max(0, statusbarHideAt - performance.now())
  if (remaining <= 0) {
    hide()
    return
  }
  statusbarHideTimer = setTimeout(hide, remaining)
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
    const chunks = []
    const errChunks = []
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
    child.stdin.on('error', (err) => fail('stdin error: ' + err.message))
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
      finish({ ...unknownOutcome(action, stdout ? 'helper returned non-JSON output' : 'helper produced no output'),
        ...(stdout ? { raw: stdout.slice(0, 4000) } : {}), stderr: stderr.slice(0, 4000), exitCode: code })
    })
    timer = setTimeout(() => fail('helper request timed out'), actionTimeoutMs(action) + PROCESS_STARTUP_GRACE_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) { onAbort(); return }
    try {
      child.stdin.end(JSON.stringify(args || {}), 'utf8')
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
      const payload = JSON.stringify({ ...(args || {}), id, action }) + '\n'
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

const toolDescription = `Desktop computer-use tool for the local Windows session (mirrors codex/cua-driver computer use). Inspect and operate real desktop apps through the Windows UI Automation accessibility tree, per-window PNG screenshots, and background synthetic-cursor input that never steals the user's mouse/keyboard.

${PC_PILOT_SKILL_HINT}

Typical loop:
1. list_apps  -- list running apps (pid, name, fast app identity, windows with title/hwnd/rect). Use get_app_identity when verified publisher/signature evidence is needed.
2. get_window_state { window: { id, app }, include_screenshot: true }  -- WITHOUT stealing focus (dispatch defaults to background). The default is a fast screenshot-only state. Pass include_text: true when you need the indexed accessibility tree (elements: index/role/name/value/automation_id/native_window_handle/rect/invokable) or document_text. Every window frame is occlusion-immune: WGC (preferred) or PrintWindow ask the target window to render itself, so a covering window NEVER leaks into the shot and there is no screen-copy degradation; screenshot.error notes when neither tier could render.
3. Act on the state with ChatGPT Windows Computer Use names: click { window, element_index } or click { window, x, y, expected_name }, scroll { window, x, y, scrollX, scrollY }, drag { window, path: [[x, y], ...] }, press_key { window, key }, type_text { window, text }, set_value { window, element_index, value }, and perform_secondary_action { window, element_index, secondary_action }. DSH extensions are wait, screenshot, select_text, clipboard, pointer-hold, and display controls.
4. Window management & utilities: get_window { window }, activate_window { window } (bring to foreground), close_window { window } (graceful WM_CLOSE), list_windows { app }, screenshot { display, x, y, width, height } (full-display capture; per-window observation is occlusion-immune via get_window_state + zoom), zoom { path, x, y, width, height }, switch_display { display }, cursor_position, wait { duration_s }, read_clipboard, write_clipboard { text }, list_displays.

Background vs foreground:
- dispatch defaults to "background": input runs via UIA action patterns (Invoke/Toggle/Selection/ExpandCollapse/RangeValue/Transform), then pixel hit-test, then WM_CHAR/WM_KEY/WM_MOUSEWHEEL messages. The target window is NOT brought to the foreground and the user's real mouse/keyboard is not hijacked. When an app is specified, background coordinate clicks aim at that window's own UIA tree / hwnd — physical occlusion by other windows (e.g. the user working on top) does not affect delivery, so a covered window can be operated fully unattended.
- If a background action has no verified path, return background_unavailable and stop that action. Do not switch to foreground or capture the covering desktop to complete a background task. Foreground dispatch is only for tasks where the user explicitly requested foreground interaction.
- overlay is ON by default: before each input action the helper moves a small codex-style click-through cursor (white rounded-triangle glyph with a blue rim and a soft blue glow centered on the tip) to the target point, so you can see where the AI is about to click/type. A frosted dark status pill is shown top-center of the screen while the helper acts — "PC-Pilot 运行中" with a breathing green dot — so the user can tell at a glance that the AI is operating. Both never take focus and are click-through; the cursor auto-hides 3 seconds after the last action and the pill fades right after it; they reappear on the next action. Pass overlay: false on an action to hide both for that action.

Rules:
- Every action using element_index MUST include the snapshot_id returned by the same get_window_state (click, set_value, type_text, perform_secondary_action, select_text). After a mutation, obtain a new get_window_state before another element action. A stable element_id may additionally be supplied so foreground_once recovery can safely remap the control after an explicit background_unavailable result.
- Use expect when the task has a concrete success condition. Failed postconditions are reported without blindly replaying the mutation. recovery: foreground_once is allowed only after an explicit not_executed/background_unavailable result; unknown outcomes are never replayed.
- Element indexes are only valid for the get_window_state that produced them; after any UI change, navigation, scroll, or delay, refresh state first.
- With app/hwnd, x/y for click, scroll, and drag are always window-local pixels from the target window's top-left, matching ChatGPT Computer Use. Use coordinate_space="screen" only when deliberately supplying absolute screen coordinates; without an app, coordinates are always screen coordinates. Supply expected_name from the observed target to guard against a changed click target.
- app may be a pid number, a process name, or a window-title substring; window_index selects the nth window when several match. list_apps/list_windows/get_window expose app_identity (kind, executable path, AUMID when packaged, parent/tree-root pid). Prefer identity_key for exact continuation targeting after discovery. get_app_identity lazily adds product/version/company metadata and optionally verifies Authenticode signer evidence, both cached by executable.
- Only operate apps and windows the user explicitly asked you to; never submit forms, send messages, make purchases, delete data, or change account/settings without explicit user instruction.

Browser route:
- browser_tabs { browser_endpoint, include_url? } explicitly lists exact tab ids; browser_state without tab_id remains a compatibility alias. With tab_id browser_state returns a bounded semantic page snapshot plus navigation_id/can_go_back/can_go_forward and an event_cursor. browser_events consumes that cursor to return newer sanitized console/network/lifecycle evidence for one exact tab. browser_downloads returns Chromium download progress plus files from the AI-owned profile download directory. browser_history returns a bounded navigation stack; browser_back/browser_forward use exact CDP history entries rather than synthetic keypresses. browser_wait waits for document ready, a URL change from expected_url, or requested page text so workflows do not rely on blind sleeps. browser_read reads the visible text of an exact tab without requiring interactive controls or a screenshot, for JSON/API pages and post-action evidence. browser_navigate replaces the URL of one exact tab and is restricted to that tab's current origin. browser_request is restricted to the current page origin or api.bilibili.com; POST/DELETE requires allow_mutation:true.
- For a browser task without desktop windows, launch_app { app: "msedge.exe", headless: true } starts a NEW isolated AI-owned browser process (fresh per-launch temp profile) and returns its browser_endpoint. It does not inherit the headed profile's login. Use browser_open { browser_endpoint, url } for an exact new tab, then browser_state to verify its URL; close noise tabs (e.g. edge://welcome-*) with browser_close { tab_id }. browser_close closes only the specified tab.
- URLs are HTTP(S) only: browser_open and launch_app { url } reject file:// and other schemes — serve local content over a local HTTP server instead.
- browser_replace replaces editable text and verifies the exact resulting value; pass start/end for a contenteditable editor to select and replace only that character range. When verification cannot be confirmed (controlled input or editor) it returns replacement_verification_failed with needs_observation — observe with browser_state before trusting the field. Supply expected_url from browser_state to reject unexpected navigation. browser_activate activates only the exact returned tab. No implicit foreground fallback is used by browser actions.
- browser_click, browser_type, and browser_key require a tab and element token from the latest browser_state. Tokens are bound to the endpoint, tab, document, and observed name/role; stale or renamed elements are rejected without retry.
- Workflow discipline: retain the verified browser endpoint and exact tab through a multi-step task. Do not open, close, reload, or restart a browser to recover from a local observation failure; re-observe the current tab first, then take the smallest recovery action that the evidence supports.
- Browser task protocol (follow this even with no prior conversation context): (1) start or receive one AI-owned browser endpoint once; list pages and select one exact tab; (2) after every navigation, input, click, scroll, or wait, run browser_state on that same tab before the next mutation; (3) use small observed scroll steps and stop immediately once the target appears—never use a fixed repeated-scroll recipe; (4) use browser_scroll_to_text for an exact rendered label/content and browser_click_text only when state has no semantic token for a visible custom control; both scan the main document and open shadow roots; (5) for submit/like/delete, perform it once, wait for its post-action evidence, then classify the outcome as confirmed, absent, or unknown. If unknown, check the current page and the relevant first-party read endpoint; NEVER submit again automatically; (6) preserve the current tab/window while recovering. Close only tabs/windows created for this task after its requested success or cleanup is independently verified.
- browser_scroll scrolls the page or the largest visible scrollable content container and returns the actual position. browser_scroll_to_text finds a complete text string in the exact tab, scrolls its smallest rendered container into view, and returns found:false when it cannot prove a match. browser_click_text uses a real mouse click on the smallest visible exact-text container for self-drawn web controls that have no semantic element token, and also returns found:false if the text is absent. browser_reload reloads only the exact tab and requires a fresh browser_state before trusting the result. Visible links include a bounded href for evidence-based navigation.
- The endpoint must be an explicit loopback DevTools WebSocket for an AI-owned isolated browser profile. This route does not discover or attach to the user's browser; the only browser process it ever starts is the headless launch_app above.`

// Normalize the single model-facing Computer Use vocabulary into the helper
// payload. This is argument adaptation only: action names stay canonical all
// the way to the native helper.
export function normalizeComputerAction(input = {}) {
  const args = { ...(input || {}) }
  const requestedAction = String(args.action || 'list_apps')
  let action = requestedAction

  // The OpenAI Responses computer tool uses these action spellings, whereas
  // the Windows surface names their canonical counterparts below. Accept both
  // forms so a computer-use loop can move between hosts without translation.
  if (action === 'double_click') {
    action = 'click'
    if (args.click_count === undefined) args.click_count = 2
  } else if (action === 'type') {
    action = 'type_text'
  } else if (action === 'keypress') {
    action = 'press_key'
    if (args.key === undefined && Array.isArray(args.keys) && args.keys.length > 0) args.key = args.keys.map(String).join('+')
  } else if (action === 'move') {
    action = 'mouse_move'
  }
  args.action = action

  // PC-Pilot uses the ChatGPT Windows Computer Use Window shape directly.
  if (args.window && typeof args.window === 'object' && !Array.isArray(args.window)) {
    if (args.hwnd === undefined && args.window.id !== undefined) args.hwnd = args.window.id
    if (args.app === undefined && args.window.app !== undefined) args.app = args.window.app
  }
  if (args.element === undefined && args.element_index !== undefined) args.element = args.element_index
  if (args.button === undefined && args.mouse_button !== undefined) args.button = args.mouse_button
  if (typeof args.button === 'string') {
    const mouseButton = args.button.toLowerCase()
    if (mouseButton === 'l') args.button = 'left'
    else if (mouseButton === 'r') args.button = 'right'
    else if (mouseButton === 'm') args.button = 'middle'
    // OpenAI calls the physical middle button "wheel". The native helper uses
    // Windows' conventional "middle" spelling for the same button.
    else if (mouseButton === 'wheel') args.button = 'middle'
  }
  if (args.screenshot === undefined && args.include_screenshot !== undefined) args.screenshot = args.include_screenshot
  if (args.scroll_x === undefined && args.scrollX !== undefined) args.scroll_x = args.scrollX
  if (args.scroll_y === undefined && args.scrollY !== undefined) args.scroll_y = args.scrollY
  if (action === 'launch_app') {
    if (args.name === undefined) args.name = args.app
    delete args.app
  }
  if (args.screenshot_id === undefined && args.screenshotId !== undefined) args.screenshot_id = args.screenshotId
  if (action === 'perform_secondary_action' && typeof args.secondary_action === 'string') {
    args.secondary_action = args.secondary_action.trim().toLowerCase().replace(/[\s-]+/g, '_')
  }

  // OpenAI's scroll deltas are continuous values. The native Windows helper
  // operates in wheel notches, so reduce them conservatively to one notch per
  // roughly 120 device units instead of treating pixels as notches. A standard
  // action may include both axes: retain both rather than silently choosing the
  // dominant one, then execute them in deterministic X/Y order below.
  if ((requestedAction === 'scroll' || action === 'scroll') && (args.scroll_x !== undefined || args.scroll_y !== undefined)) {
    const sx = Number(args.scroll_x || 0)
    const sy = Number(args.scroll_y || 0)
    const component = (delta, positive, negative) => ({
      amount: Math.max(1, Math.round(Math.abs(delta) / 120)),
      direction: delta > 0 ? positive : negative,
    })
    if (sx !== 0 && sy !== 0) {
      args.scroll_components = [component(sx, 'right', 'left'), component(sy, 'down', 'up')]
      // Keep a canonical first component for helper compatibility; the executor
      // consumes scroll_components so neither axis is discarded.
      Object.assign(args, args.scroll_components[0])
    } else if (sx !== 0) {
      Object.assign(args, component(sx, 'right', 'left'))
    } else if (sy !== 0) {
      Object.assign(args, component(sy, 'down', 'up'))
    }
  }

  if (requestedAction === 'drag' && Array.isArray(args.path) && args.path.length >= 2) {
    const pointXY = (point) => Array.isArray(point)
      ? (point.length >= 2 ? [Number(point[0]), Number(point[1])] : null)
      : (point && typeof point === 'object' && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
          ? [Number(point.x), Number(point.y)] : null)
    const first = pointXY(args.path[0])
    const last = pointXY(args.path.at(-1))
    if (first && last) {
      args.from_x = first[0]
      args.from_y = first[1]
      args.to_x = last[0]
      args.to_y = last[1]
    }
  }

  // The public schema uses the same modifier array as OpenAI computer use.
  // Keep the helper's older comma-separated representation as an internal
  // detail so modifiers cannot be accidentally dropped at this boundary.
  if (['click', 'scroll', 'drag'].includes(requestedAction) &&
      Array.isArray(args.keys) && args.keys.length > 0 && args.modifiers === undefined) {
    args.modifiers = args.keys.map((key) => String(key)).join(',')
  }

  return { requestedAction, action, args }
}

const OBSERVE_AFTER_ACTIONS = new Set(['click', 'drag', 'scroll', 'press_key', 'type_text', 'set_value', 'wait', 'mouse_move'])

const POSTCONDITION_TYPES = new Set([
  'window_exists', 'window_closed', 'accessibility_changed',
  'element_value', 'text_present',
  'browser_url', 'browser_text', 'browser_ready', 'download_completed',
])
const FOREGROUND_RECOVERY_ACTIONS = new Set([
  'click', 'press_key', 'type_text', 'scroll', 'drag', 'mouse_down', 'mouse_up', 'hold_key',
])

function normalizedExpectation(raw) {
  if (raw === undefined || raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expect must be an object')
  const type = String(raw.type || '')
  if (!POSTCONDITION_TYPES.has(type)) throw new Error('expect.type is not supported')
  const timeout_ms = Math.max(0, Math.min(10000, Number(raw.timeout_ms ?? 2500)))
  if (!Number.isFinite(timeout_ms)) throw new Error('expect.timeout_ms must be 0..10000')
  const match = raw.match === undefined ? undefined : String(raw.match)
  if (match !== undefined && !['exact', 'contains', 'prefix'].includes(match)) throw new Error('expect.match must be exact, contains, or prefix')
  const out = { ...raw, type, timeout_ms, ...(match ? { match } : {}) }
  if (['element_value'].includes(type) && (typeof raw.element_id !== 'string' || !raw.element_id)) throw new Error('expect.element_id required')
  if (type === 'element_value' && typeof raw.value !== 'string') throw new Error('expect.value required')
  if (['text_present', 'browser_text'].includes(type) && (typeof raw.text !== 'string' || !raw.text)) throw new Error('expect.text required')
  if (type === 'browser_url' && (typeof raw.url !== 'string' || !raw.url)) throw new Error('expect.url required')
  if (type === 'download_completed' && (typeof raw.filename !== 'string' || !raw.filename)) throw new Error('expect.filename required')
  return out
}

function expectedString(actual, expected, match = 'exact') {
  actual = String(actual ?? '')
  expected = String(expected ?? '')
  if (match === 'contains') return actual.includes(expected)
  if (match === 'prefix') return actual.startsWith(expected)
  return actual === expected
}

export function evaluatePostconditionObservation(expect, observation) {
  const e = normalizedExpectation(expect)
  if (!e) return { ok: true, type: 'none' }
  const base = { type: e.type }
  if (e.type === 'window_exists') {
    return { ...base, ok: observation?.ok === true, observed: observation?.ok === true ? 'present' : 'missing' }
  }
  if (e.type === 'window_closed') {
    const closed = observation?.ok !== true && ['window_not_found', 'app_not_found'].includes(observation?.error_code)
    return { ...base, ok: closed, observed: observation?.ok === true ? 'present' : closed ? 'closed' : 'unknown', ...(observation?.error_code ? { error_code: observation.error_code } : {}) }
  }
  if (e.type === 'accessibility_changed') {
    const delta = observation?.accessibility_delta ?? observation?.accessibility?.delta
    if (!delta || delta.reset) return { ...base, ok: false, reason: 'accessibility_baseline_unavailable' }
    const changed = (delta.added?.length || 0) + (delta.removed?.length || 0) + (delta.changed?.length || 0)
    return { ...base, ok: changed > 0, changed_count: changed, revision: observation?.accessibility_revision ?? observation?.accessibility?.revision }
  }
  if (e.type === 'element_value') {
    const element = Array.isArray(observation?.elements) ? observation.elements.find(item => item?.element_id === e.element_id) : null
    if (!element) return { ...base, ok: false, reason: 'element_not_found', element_id: e.element_id }
    const match = e.match || 'exact'
    return { ...base, ok: expectedString(element.value, e.value, match), element_id: e.element_id, match, observed_value: String(element.value ?? '') }
  }
  if (e.type === 'text_present') {
    const haystack = [
      observation?.document_text,
      ...(Array.isArray(observation?.elements) ? observation.elements.flatMap(item => [item?.name, item?.value]) : []),
    ].filter(Boolean).join('\n')
    return { ...base, ok: haystack.includes(e.text), text: e.text }
  }
  if (e.type === 'browser_url') {
    const match = e.match || 'exact'
    return { ...base, ok: expectedString(observation?.url, e.url, match), match, observed_url: String(observation?.url ?? '') }
  }
  if (e.type === 'browser_text') {
    const haystack = String(observation?.text ?? observation?.body_text ?? observation?.visible_text ?? '')
    return { ...base, ok: haystack.includes(e.text), text: e.text }
  }
  if (e.type === 'browser_ready') {
    return { ...base, ok: observation?.ready_state === 'complete' || observation?.ready === true, ready_state: observation?.ready_state }
  }
  if (e.type === 'download_completed') {
    const match = e.match || 'exact'
    const files = Array.isArray(observation?.files) ? observation.files : []
    const downloads = Array.isArray(observation?.downloads) ? observation.downloads : []
    const file = files.find(item => expectedString(item?.name, e.filename, match))
    const event = downloads.find(item => expectedString(item?.suggested_filename, e.filename, match) && item?.state === 'completed')
    return { ...base, ok: Boolean(file || event), filename: e.filename, match, path: file?.path }
  }
  return { ...base, ok: false, reason: 'unsupported_postcondition' }
}

export function remapStableElementForRecovery(requestArgs, state) {
  if (requestArgs?.element === undefined) return { ok: true, args: { ...requestArgs } }
  if (typeof requestArgs.element_id !== 'string' || !requestArgs.element_id) {
    return { ok: false, reason: 'element_id_required_for_safe_recovery' }
  }
  const found = Array.isArray(state?.elements) ? state.elements.find(item => item?.element_id === requestArgs.element_id) : null
  if (!found) return { ok: false, reason: 'stable_element_not_found' }
  return { ok: true, args: { ...requestArgs, element: found.index, element_index: found.index, snapshot_id: state.snapshot_id } }
}

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
  const reason = sensitiveTransmission
    ? 'The target appears to be a sensitive field; typing would transmit the value to that application.'
    : consequential
      ? 'The observed target appears to submit, publish, purchase, delete, authenticate, or change account state.'
      : open
        ? 'Opening a URL/navigating a browser tab sends a network request to that site under the AI profile.'
        : wholeFieldReplace
          ? 'browser_replace replaces the entire current content of the target field.'
          : undefined
  return {
    class: consequential || sensitiveTransmission || open || wholeFieldReplace ? 'consequential' : 'routine',
    // PC-Pilot currently runs without an approval interlock. Keep the safety
    // classification, flag and reason in the result so a host policy can gate
    // on it later without changing action detection.
    requires_confirmation: false,
    ...(reason ? { reason } : {}),
  }
}

// Verified against local dsh-llm ImageBlock and dsh-tool-fs imageReadContent.
// Only helper-returned screenshot files from its private output directory qualify.
const SCREENSHOT_DIR = path.join(TEMP_DIR, 'dsh-cua')
const MAX_PNG_BYTES = 8 * 1024 * 1024
function screenshotFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('invalid screenshot path')
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== SCREENSHOT_DIR || !/^(shot|disp|zoom)-[a-f0-9]{32}\.png$/i.test(path.basename(resolved))) throw new Error('not a plugin screenshot')
  // Reject symlinks/junctions escaping the plugin directory, including the directory itself.
  if (fs.realpathSync(SCREENSHOT_DIR) !== SCREENSHOT_DIR || fs.realpathSync(resolved) !== resolved || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('redirected screenshot path')
  return resolved
}
async function attachScreenshot(value, args, exec, ctx) {
  if (!value?.ok || !ctx?.get || exec?.signal?.aborted) return value
  const action = args?.action || (Array.isArray(args?.actions) ? 'batch' : 'list_apps')
  const observations = []
  if (action === 'batch' && Array.isArray(value.steps)) {
    const last = value.steps[value.steps.length - 1]
    if (last?.post_action_observation) observations.push(last.post_action_observation)
    if (last) observations.push(last)
  }
  if (value.post_action_observation) observations.push(value.post_action_observation)
  observations.push(value)
  let file
  let sourceFile
  for (const candidate of observations) {
    if (!candidate) continue
    const found = candidate.screenshot?.path || candidate.path
    if (found) { file = found; sourceFile = candidate.source_path; break }
  }
  if (!file) return value
  if (!file) return value
  try {
    const attachments = ctx.get('attachments')
    const llm = ctx.get('llm')
    const limits = attachments?.imageLimits
    if (!attachments?.saveImage || !llm || !limits?.mediaTypes?.includes('image/png')) return value
    const routed = exec?.agent?.session?.requestHeader()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (provider === undefined || model === undefined) return value
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!info?.inputModalities?.includes('image') || exec?.signal?.aborted) return value
    const safePath = screenshotFile(file)
    if (sourceFile) screenshotFile(sourceFile)
    const cap = Math.min(MAX_PNG_BYTES, limits.maxImageBytes, limits.maxMessageImageBytes)
    if (!Number.isFinite(cap) || cap < 33 || !Number.isFinite(limits.maxImageDimension) || !Number.isFinite(limits.maxImagePixels)) return value
    const fd = fs.openSync(safePath, 'r')
    let data
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 33 || stat.size > cap) return value
      // Read at most the validated byte cap, even if the file grows concurrently.
      data = Buffer.alloc(stat.size)
      if (fs.readSync(fd, data, 0, data.length, 0) !== data.length) return value
    } finally { fs.closeSync(fd) }
    if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return value
    const width = data.readUInt32BE(16), height = data.readUInt32BE(20)
    if (!width || !height || width > Math.min(16384, limits.maxImageDimension) || height > Math.min(16384, limits.maxImageDimension) || width * height > Math.min(32000000, limits.maxImagePixels)) return value
    // The service decodes/validates the entire PNG and owns immutable attachment bytes.
    const ref = await attachments.saveImage({ data, mediaType: 'image/png', name: path.basename(safePath) })
    if (exec?.signal?.aborted) return value
    return { ...value, screenshot_attachment: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }) } }
  } catch { return value } // Image enrichment must never turn a completed action into a retry.
}

// A returned Window is immediately reusable as the target of the next
// Windows Computer Use action. Keep the richer PC-Pilot fields too.
function exposeComputerUseResult(value, action) {
  if (!value) return value
  if (action === 'list_apps' && Array.isArray(value.apps)) {
    return {
      ...value,
      apps: value.apps.map((app) => ({
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
  if (!['get_window_state', 'get_window', 'launch_app'].includes(action)) return value
  const source = value.window && typeof value.window === 'object' ? value.window : value
  const id = source.id ?? source.hwnd ?? value.hwnd
  const app = source.app ?? source.process_name ?? value.process_name
  if (id === undefined || app === undefined) return value
  const next = { ...value, window: { ...source, id, app } }
  if (action === 'get_window_state') {
    next.screenshots = value.screenshot?.path ? [{
      id: value.screenshot_id ?? value.screenshot.id,
      path: value.screenshot.path,
      originX: value.screenshot.window_rect?.x,
      originY: value.screenshot.window_rect?.y,
    }] : []
  }
  if (action === 'get_window_state') {
    next.accessibility = value.accessibility ?? null
  }
  return next
}

export function defineComputerTool(defineTool, ctx) {
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
          'perform_secondary_action', 'activate_window',
          // OpenAI Responses computer-use spellings, normalized to the same
          // canonical desktop actions before dispatch.
          'double_click', 'type', 'keypress', 'move',
          // PC-Pilot extensions without a corresponding Windows CU method.
          'wait', 'screenshot', 'close_window', 'select_text',
          'read_clipboard', 'write_clipboard', 'mouse_down', 'mouse_up', 'hold_key', 'list_displays',
          'zoom', 'switch_display', 'cursor_position', 'get_app_identity',
          'browser_open', 'browser_navigate', 'browser_activate', 'browser_close', 'browser_shutdown', 'browser_tabs', 'browser_events', 'browser_downloads', 'browser_history', 'browser_back', 'browser_forward', 'browser_wait', 'browser_state', 'browser_read', 'browser_request', 'browser_click', 'browser_click_text', 'browser_type', 'browser_replace', 'browser_key', 'browser_scroll', 'browser_scroll_to_text', 'browser_reload',
        ],
        description: 'What to do on the desktop.',
      },
      actions: { type: 'array', items: { type: 'json' }, description: `Ordered computer-use actions to execute sequentially (maximum ${MAX_BATCH_ACTIONS}); execution stops at the first failed or uncertain step.` },
      app: { type: 'string', description: 'Target app: pid number, process name, or window-title substring (omit for global input). get_app_identity also accepts a pid encoded as a string even when the process has no top-level window.' },
      identity_key: { type: 'string', description: 'Exact app identity returned by list_apps/list_windows/get_window/get_app_identity. Prefer this over process-name/title matching when continuing work in a known app. Packaged apps use aumid:<AUMID>; Win32 apps use win32:<full executable path>.' },
      verify_signature: { type: 'boolean', description: 'get_app_identity only: verify the executable Authenticode signature and return signer publisher/subject/thumbprint. Default true; results are cached by executable path.' },
      hwnd: { type: 'number', description: 'Target window handle (HWND) for direct targeting (activate_window, close_window, get_window, get_app_identity, or input actions).' },
      window: { type: 'object', properties: { id: { type: 'number' }, app: { type: 'string' } }, additionalProperties: false, description: 'ChatGPT Computer Use Window compatibility object. Its id maps to hwnd and app maps to the target app.' },
      name: { type: 'string', description: 'Application name, executable path, or registered Windows activation protocol such as ms-settings:display (for launch_app). A protocol/delegated launch returns a window only when one newly-created window can be identified safely.' },
      activate: { type: 'boolean', description: 'launch_app only: start normally and allow the app to become foreground. Default false launches minimized in the background; use true only when the user asked to bring the app forward or foreground UIA is essential.' },
      url: { type: 'string', description: 'Initial URL passed to a Chromium browser launched by launch_app.' },
      window_index: { type: 'number', description: '1-based window index when the app has several matching windows (optional).' },
      snapshot_id: { type: 'string', description: 'Required for every action using element_index: copy snapshot_id from the same get_window_state. Mutations invalidate the snapshot; refresh get_window_state before the next element action.' },
      element: { type: 'number', description: 'Internal element index field; use element_index.' },
      element_index: { type: 'number', description: 'Element index from the latest get_window_state for click, set_value, perform_secondary_action, select_text, or type_text.' },
      browser_element: { type: 'string', description: 'Element token from the latest browser_state; use this for browser_click/browser_type/browser_key.' },
      expected_name: { type: 'string', description: 'For click: expected UI element name at the target point; guards against clicking a changed target.' },
      coordinate_space: { type: 'string', enum: ['screen', 'window'], description: 'For click with app/hwnd: window-relative is the default and matches Computer Use; screen explicitly uses absolute screen coordinates. Without app/hwnd coordinates are always screen-relative.' },
      x: { type: 'number', description: 'Window-local X (with app) or screen X (without app).' },
      y: { type: 'number', description: 'Window-local Y (with app) or screen Y (without app).' },
      text: { type: 'string', description: 'Text to type via unicode input, or text payload to write to clipboard for write_clipboard.' },
      start: { type: 'number', description: 'browser_replace only: zero-based start character for a contenteditable range replacement.' },
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
      path: { oneOf: [
        { type: 'string' },
        { type: 'array', items: { oneOf: [
          { type: 'array', items: { type: 'number' } },
          { type: 'object', properties: { x: { type: 'number', required: true }, y: { type: 'number', required: true } }, additionalProperties: false },
        ] } },
      ], description: 'For drag: standard computer-use ordered path, using [x, y] pairs or {x, y} points; foreground follows every point. For zoom: source screenshot path.' },
      scroll_x: { type: 'number', description: 'Standard computer-use horizontal wheel delta; positive scrolls right and negative scrolls left.' },
      scroll_y: { type: 'number', description: 'Standard computer-use vertical wheel delta; positive scrolls down and negative scrolls up.' },
      scrollX: { type: 'number', description: 'ChatGPT Computer Use alias for scroll_x.' },
      scrollY: { type: 'number', description: 'ChatGPT Computer Use alias for scroll_y.' },
      value: { type: 'string', description: 'Text value to set on the target element (set_value).' },
      start: { type: 'number', description: 'Character offset for select_text (start of the range, or caret when length is 0).' },
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
      recovery: { type: 'string', enum: ['none', 'foreground_once'], description: 'Optional deterministic recovery. foreground_once retries only when the background attempt explicitly reports not_executed + background_unavailable. Unknown outcomes are never replayed; element recovery requires element_id so a fresh index/snapshot can be remapped safely.' },
      screenshot: { type: 'boolean', description: 'Internal screenshot field; use include_screenshot for get_window_state.' },
      include_screenshot: { type: 'boolean', description: 'Capture a per-window PNG screenshot in get_window_state (default true).' },
      include_text: { type: 'boolean', description: 'Include the indexed UI Automation tree and document text in get_window_state (default false, matching ChatGPT Computer Use screenshot-first observations). With a window-targeted wait, also include it in the post-wait observation. accessibility.status distinguishes available, partial, and unavailable UIA trees.' },
      screenshot_id: { type: 'string', description: 'Optional ID of the screenshot/state used to choose coordinates. Expired or wrong-window IDs are rejected.' },
      screenshotId: { type: 'string', description: 'Camel-case alias for screenshot_id.' },
      dispatch: { type: 'string', enum: ['background', 'foreground'], description: 'background (default): UIA patterns + WM_CHAR/WM_KEY/WM_MOUSEWHEEL, never steals focus. foreground: real SendInput, brings window forward — pick it per task only when the user asked for real control or the essential action has no background path, and say so. Some actions report background_unavailable when the target has no background path.' },
      overlay: { type: 'boolean', description: 'Show the small codex-style click-through cursor glyph and the top-center "PC-Pilot 运行中" status pill with a breathing green dot (default true). Set false to hide both.' },
      browser_endpoint: { type: 'string', description: 'Explicit loopback DevTools WebSocket endpoint of an AI-owned isolated browser profile; required for browser_* actions.' },
      tab_id: { type: 'string', description: 'Exact tab id returned by browser_state; required for browser actions except listing tabs.' },
      expected_url: { type: 'string', description: 'Exact observed page URL; reject browser operation if navigation changed it.' },
      headless: { type: 'boolean', description: 'launch_app Chromium only: launch without any desktop window, using a separate persistent AI profile. Continue through browser_* actions.' },
      include_url: { type: 'boolean', description: 'browser_tabs or browser_state without tab_id: also return each tab url/title (default false — ids only).' },
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
      if (e.type === 'download_completed') return browserAction('browser_downloads', { browser_endpoint }, signal)
      if (!tab_id) return { ok: false, outcome: 'not_executed', error_code: 'postcondition_target_missing', message: 'tab_id required for browser postcondition' }
      if (e.type === 'browser_ready') return browserAction('browser_wait', { browser_endpoint, tab_id, browser_wait_for: 'ready', browser_wait_timeout_ms: Math.min(30000, e.timeout_ms) }, signal)
      if (e.type === 'browser_text') return browserAction('browser_read', { browser_endpoint, tab_id }, signal)
      return browserAction('browser_state', { browser_endpoint, tab_id }, signal)
    }

    const target = { app: requestArgs.app, identity_key: requestArgs.identity_key, hwnd: requestArgs.hwnd, window_index: requestArgs.window_index, dispatch: 'background' }
    if (e.type === 'window_exists' || e.type === 'window_closed') {
      if (!target.app && target.hwnd === undefined) return { ok: false, error_code: 'postcondition_target_missing' }
      try { return await daemonRequest('get_window', target, signal) }
      catch { return { ok: false, outcome: 'not_executed' } }
    }
    if (!target.app && target.hwnd === undefined) return { ok: false, error_code: 'postcondition_target_missing' }
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
      if (action.startsWith('browser_')) {
        await beginStatusbar()
        try {
          const browserArgs = { ...requestArgs }
          if (browserArgs.element === undefined && browserArgs.browser_element !== undefined) browserArgs.element = browserArgs.browser_element
          if (action === 'browser_shutdown' && !ownedBrowserEndpoints.has(browserArgs.browser_endpoint)) {
            return { ok: false, action: normalized.requestedAction, outcome: 'not_executed', error_code: 'browser_not_owned', message: 'browser_shutdown is limited to an isolated browser launched by this PC-Pilot tool instance.' }
          }
          const browserResult = await browserAction(action, browserArgs, signal)
          if (action === 'browser_shutdown' && browserResult.ok) ownedBrowserEndpoints.delete(browserArgs.browser_endpoint)
          const browserObservation = browserResult.screenshot
            ? { ok: true, action: 'screenshot', outcome: 'completed', screenshot: browserResult.screenshot }
             : (['browser_tabs', 'browser_events', 'browser_downloads', 'browser_history', 'browser_wait', 'browser_state', 'browser_read', 'browser_request', 'browser_open', 'browser_navigate', 'browser_back', 'browser_forward', 'browser_activate', 'browser_close', 'browser_shutdown'].includes(action) ? null : { ok: false, action: 'screenshot', outcome: 'unknown', error_code: 'observation_failed', message: 'browser mutation completed without a post-action screenshot' })
          const observationFailed = browserObservation?.ok === false
          const value = { ...browserResult, ok: browserResult.ok !== false && !observationFailed, action, outcome: browserResult.outcome || (observationFailed ? 'unknown' : action === 'browser_state' ? 'completed' : 'dispatched'),
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
    for (const key of ['app', 'identity_key', 'hwnd', 'window_index', 'snapshot_id', 'browser_endpoint', 'tab_id', 'dispatch', 'overlay', 'display', 'confirmation', 'include_text', 'wait_for', 'recovery']) {
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
          text = JSON.stringify(value, null, 1)
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
      const result = await attachScreenshot(value, args, exec, ctx)
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
  if (syncTool) {
    try { registerWith(syncTool) } catch (e) { diag('register threw: ' + (e && e.stack || e)); console.error(LOG_TAG + ' registration failed:', e) }
    return
  }
  loadDefineToolAsync().then(registerWith).catch((e) => {
    diag('registration FAILED: ' + (e && e.stack || e))
    console.error(LOG_TAG + ' registration failed:', e)
  })
}
