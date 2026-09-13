import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { defineComputerTool, stopDaemon } from '../lib/index.js'

const tool = defineComputerTool((value) => value, {})

// Schema contract.
const props = tool.parameters.properties
assert.ok(props.action.enum.includes('get_app_identity'))
assert.equal(props.identity_key.type, 'string')
assert.equal(props.verify_signature.type, 'boolean')

// Fast discovery must expose one app-level identity without duplicating it into
// every list_apps window entry.
const appsResult = await tool.execute({ action: 'list_apps' })
assert.equal(appsResult.ok, true, JSON.stringify(appsResult))
assert.ok(Array.isArray(appsResult.apps) && appsResult.apps.length > 0)
for (const app of appsResult.apps) {
  const id = app.identity
  assert.ok(id && typeof id.identity_key === 'string' && id.identity_key.length > 0)
  assert.ok(['win32', 'packaged'].includes(id.kind))
  assert.equal(id.pid, app.pid)
  assert.equal(typeof id.process_name, 'string')
  assert.equal(typeof id.parent_pid, 'number')
  assert.equal(typeof id.process_tree_root_pid, 'number')
  assert.equal(id.signature_status, 'not_checked')
  assert.ok(app.windows.every((window) => window.app_identity === undefined),
    'list_apps windows must not repeat the full app identity payload')
}

// A packaged app, when present on the host, must use AUMID as its stable key.
const packaged = appsResult.apps.find((app) => app.identity?.kind === 'packaged')
if (packaged) {
  assert.ok(packaged.identity.aumid)
  assert.equal(packaged.identity.identity_key, `aumid:${packaged.identity.aumid}`)
}

// Exact identity targeting must return only windows belonging to that identity.
const candidate = appsResult.apps.find((app) =>
  app.identity?.identity_key &&
  app.windows?.some((w) => w.rect?.width >= 50 && w.rect?.height >= 32)
)
assert.ok(candidate, 'host must expose at least one normal application window')
const exactWindows = await tool.execute({
  action: 'list_windows',
  identity_key: candidate.identity.identity_key,
})
assert.equal(exactWindows.ok, true, JSON.stringify(exactWindows))
assert.ok(exactWindows.windows.length > 0)
for (const window of exactWindows.windows) {
  assert.equal(window.app_identity?.identity_key, candidate.identity.identity_key)
}

// The same exact identity can target get_window without title/process ambiguity.
const exactWindow = exactWindows.windows[0]
const exactGet = await tool.execute({
  action: 'get_window',
  hwnd: exactWindow.hwnd,
  identity_key: candidate.identity.identity_key,
})
assert.equal(exactGet.ok, true, JSON.stringify(exactGet))
assert.equal(exactGet.app_identity?.identity_key, candidate.identity.identity_key)

// A HWND from another app must never be accepted under the wrong identity.
const other = appsResult.apps.find((app) =>
  app.identity?.identity_key !== candidate.identity.identity_key &&
  app.windows?.some((w) => w.hwnd)
)
if (other) {
  const mismatch = await tool.execute({
    action: 'get_window',
    hwnd: other.windows[0].hwnd,
    identity_key: candidate.identity.identity_key,
  })
  assert.equal(mismatch.ok, false)
  assert.match(String(mismatch.message || ''), /target_validation_failed/i)
}

// get_app_identity must work on a process with no top-level window.
const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], {
  windowsHide: true,
  stdio: 'ignore',
})
try {
  const headlessIdentity = await tool.execute({
    action: 'get_app_identity',
    app: String(sleeper.pid),
    verify_signature: false,
  })
  assert.equal(headlessIdentity.ok, true, JSON.stringify(headlessIdentity))
  assert.equal(headlessIdentity.identity.pid, sleeper.pid)
  assert.equal(headlessIdentity.identity.kind, 'win32')
  assert.match(headlessIdentity.identity.identity_key, /^win32:/)
  assert.ok(headlessIdentity.identity.executable_path)
  assert.equal(headlessIdentity.identity.signature_status, 'not_checked')
  assert.equal(typeof headlessIdentity.identity.product_name, 'string')
  assert.equal(typeof headlessIdentity.identity.product_version, 'string')
} finally {
  try { sleeper.kill() } catch {}
}

// Detailed identity must verify Authenticode lazily and cache the result.
// explorer.exe is a Windows-signed system binary on supported Windows hosts.
const explorer = appsResult.apps.find((app) => app.name?.toLowerCase() === 'explorer')
if (explorer) {
  const first = await tool.execute({
    action: 'get_app_identity',
    app: String(explorer.pid),
    verify_signature: true,
  })
  assert.equal(first.ok, true, JSON.stringify(first))
  assert.notEqual(first.identity.signature_status, 'not_checked')
  assert.equal(typeof first.identity.product_name, 'string')
  assert.equal(typeof first.identity.product_version, 'string')
  if (first.identity.signature_status === 'Valid') {
    assert.ok(first.identity.publisher)
    assert.ok(first.identity.signer_subject)
    assert.ok(first.identity.signer_thumbprint)
  }

  const t = performance.now()
  const second = await tool.execute({
    action: 'get_app_identity',
    app: String(explorer.pid),
    verify_signature: true,
  })
  const cachedMs = performance.now() - t
  assert.equal(second.ok, true, JSON.stringify(second))
  assert.equal(second.identity.signature_status, first.identity.signature_status)
  assert.equal(second.identity.signer_thumbprint, first.identity.signer_thumbprint)
  assert.ok(cachedMs < 1000, `cached identity verification unexpectedly slow: ${cachedMs.toFixed(1)}ms`)
}

stopDaemon()
console.log('app identity check PASSED')
