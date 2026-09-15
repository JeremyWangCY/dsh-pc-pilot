import { createPcPilotRuntime } from './runtime.js'

const HELP = `PC-Pilot CLI

Usage:
  pc-pilot status [--json]
  pc-pilot doctor [--probe] [--json]
  pc-pilot request [--payload <json> | --stdin] [--json]
  pc-pilot act <action> [--payload <json> | --stdin] [--json]
  pc-pilot <action> [--payload <json> | --stdin] [--json]

request passes a complete computer request through unchanged. The CLI intentionally does not whitelist actions.
`

async function readAll(stream) {
  let text = ''
  for await (const chunk of stream) text += chunk
  return text
}

function parsePayload(text) {
  if (!text?.trim()) return {}
  const value = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('payload must be a JSON object')
  }
  return value
}

export function parseCliArgs(argv) {
  const args = [...argv]
  const options = { json: false, probe: false, stdin: false, payloadText: null }
  const positionals = []
  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token === '--json') options.json = true
    else if (token === '--probe') options.probe = true
    else if (token === '--stdin') options.stdin = true
    else if (token === '--help' || token === '-h') options.help = true
    else if (token === '--payload') {
      if (i + 1 >= args.length) throw new Error('--payload requires JSON')
      options.payloadText = args[++i]
    } else positionals.push(token)
  }

  if (options.help || positionals.length === 0) return { command: 'help', options }
  const first = positionals.shift()
  if (first === 'status' || first === 'doctor') return { command: first, options, extra: positionals }
  if (first === 'request' || first === 'raw') return { command: 'request', options, extra: positionals }
  if (first === 'act') {
    const action = positionals.shift()
    if (!action) throw new Error('act requires an action name')
    return { command: 'act', action, options, extra: positionals }
  }
  return { command: 'act', action: first, options, extra: positionals }
}

function humanStatus(value) {
  return [
    `PC-Pilot ${value.version}`,
    `Platform: ${value.platform}/${value.arch}`,
    `Node: ${value.node}`,
    `Desktop: ${value.providers.desktop}`,
    `Browser: ${value.providers.browser}`,
    `Daemon: ${value.daemon.running ? `running (pid ${value.daemon.pid})` : 'idle'}`,
  ].join('\n')
}

function humanDoctor(value) {
  const lines = value.checks.map(check => {
    const mark = check.ok ? 'OK' : (check.required ? 'FAIL' : 'OPTIONAL')
    return `${mark.padEnd(8)} ${check.name}: ${check.detail}`
  })
  lines.push(value.ok ? 'PC-Pilot is ready.' : 'PC-Pilot has required checks that failed.')
  return lines.join('\n')
}

function writeValue(io, value, json, humanFormatter) {
  const text = json
    ? JSON.stringify(value)
    : humanFormatter ? humanFormatter(value) : JSON.stringify(value, null, 2)
  io.stdout.write(text + '\n')
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout
  const stderr = io.stderr || process.stderr
  const stdin = io.stdin || process.stdin
  const runtime = (io.runtimeFactory || createPcPilotRuntime)({ signal: io.signal })
  try {
    const parsed = parseCliArgs(argv)
    if (parsed.command === 'help') {
      stdout.write(HELP)
      return 0
    }
    if (parsed.extra?.length) throw new Error(`unexpected arguments: ${parsed.extra.join(' ')}`)

    if (parsed.command === 'status') {
      writeValue({ stdout }, runtime.status(), parsed.options.json, humanStatus)
      return 0
    }
    if (parsed.command === 'doctor') {
      const value = await runtime.doctor({ probe: parsed.options.probe })
      writeValue({ stdout }, value, parsed.options.json, humanDoctor)
      return value.ok ? 0 : 1
    }

    if (parsed.options.stdin && parsed.options.payloadText !== null) {
      throw new Error('use either --stdin or --payload, not both')
    }
    let payloadText = parsed.options.payloadText
    if (parsed.options.stdin) payloadText = await readAll(stdin)
    if (parsed.command === 'request' && payloadText === null) {
      throw new Error('request requires --payload or --stdin')
    }
    const payload = parsePayload(payloadText)
    const value = parsed.command === 'request'
      ? await runtime.run(payload)
      : await runtime.act(parsed.action, payload)
    writeValue({ stdout }, value, parsed.options.json)
    return value?.ok === false ? 1 : 0
  } catch (error) {
    stderr.write(`pc-pilot: ${error.message}\n`)
    return 2
  } finally {
    runtime.close?.()
  }
}
