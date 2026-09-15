import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineComputerTool, getDaemonPid, runAction, stopDaemon } from './index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const systemRoot = process.env.SystemRoot || 'C:\\Windows'
const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const helper = path.join(__dirname, 'pc-pilot-helper.ps1')
const wgc = path.join(__dirname, 'wgc', 'dsh-pc-pilot-wgc.exe')

function nodeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 12)
}

export function getRuntimeStatus({ browserProvider } = {}) {
  const daemonPid = getDaemonPid()
  return {
    ok: true,
    name: 'pc-pilot',
    version: pkg.version,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    daemon: { running: Boolean(daemonPid), pid: daemonPid || null },
    providers: {
      desktop: process.platform === 'win32' ? 'windows-native' : 'unavailable',
      browser: browserProvider?.name || 'cdp-session',
    },
  }
}

export async function doctor({ probe = false, signal } = {}) {
  const checks = [
    { name: 'windows', required: true, ok: process.platform === 'win32', detail: process.platform },
    { name: 'node', required: true, ok: nodeSupported(), detail: process.versions.node },
    { name: 'powershell', required: true, ok: fs.existsSync(powershell), detail: powershell },
    { name: 'helper', required: true, ok: fs.existsSync(helper), detail: helper },
    { name: 'wgc', required: false, ok: fs.existsSync(wgc), detail: wgc },
  ]

  if (probe) {
    const result = await runAction('list_apps', {}, signal)
    checks.push({
      name: 'helper_round_trip',
      required: true,
      ok: result?.ok === true,
      detail: result?.ok ? result.message || 'ok' : result?.message || 'failed',
    })
  }

  return {
    ok: checks.every(check => !check.required || check.ok),
    checks,
  }
}

export function createPcPilotRuntime({ signal, browserProvider } = {}) {
  let closed = false
  let computer = null
  const getComputer = () => (computer ||= defineComputerTool(tool => tool, {}, { browserProvider }))
  const executeRequest = async (request, options = {}) => {
    if (closed) return { ok: false, action: request?.action || '', message: 'runtime is closed' }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return { ok: false, action: '', message: 'request must be a JSON object' }
    }
    return getComputer().execute(request, { signal: options.signal || signal })
  }
  return {
    status: () => getRuntimeStatus({ browserProvider }),
    doctor: options => doctor({ ...options, signal: options?.signal || signal }),
    run: executeRequest,
    act(action, payload = {}, options = {}) {
      if (!action || typeof action !== 'string') {
        return Promise.resolve({ ok: false, action: action || '', message: 'action must be a non-empty string' })
      }
      return executeRequest({ ...payload, action }, options)
    },
    close() {
      if (closed) return
      closed = true
      stopDaemon()
    },
  }
}
