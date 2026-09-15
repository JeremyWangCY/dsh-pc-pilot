import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { parseCliArgs, runCli } from '../lib/cli.js'

assert.deepEqual(
  parseCliArgs(['click', '--payload', '{"x":10,"y":20}', '--json']),
  {
    command: 'act',
    action: 'click',
    options: { json: true, probe: false, stdin: false, payloadText: '{"x":10,"y":20}' },
    extra: [],
  }
)

const calls = []
const fakeRuntime = {
  status: () => ({
    ok: true,
    name: 'pc-pilot',
    version: '0.4.0',
    platform: 'win32',
    arch: 'x64',
    node: '22.12.0',
    daemon: { running: false, pid: null },
    providers: { desktop: 'windows-native', browser: 'cdp-session' },
  }),
  doctor: async ({ probe }) => ({
    ok: true,
    checks: [{ name: 'probe', required: false, ok: true, detail: String(probe) }],
  }),
  run: async request => {
    calls.push({ request })
    return { ok: true, request }
  },
  act: async (action, payload) => {
    calls.push({ action, payload })
    return { ok: true, action, payload }
  },
  close: () => {},
}

function capture() {
  let stdout = ''
  let stderr = ''
  return {
    io: {
      stdout: { write: value => { stdout += value } },
      stderr: { write: value => { stderr += value } },
      runtimeFactory: () => fakeRuntime,
    },
    stdout: () => stdout,
    stderr: () => stderr,
  }
}

{
  const out = capture()
  const code = await runCli(['status', '--json'], out.io)
  assert.equal(code, 0)
  assert.equal(JSON.parse(out.stdout()).name, 'pc-pilot')
}

{
  const out = capture()
  const code = await runCli(['some_future_action', '--payload', '{"free":true}', '--json'], out.io)
  assert.equal(code, 0)
  assert.deepEqual(calls.at(-1), { action: 'some_future_action', payload: { free: true } })
  assert.equal(JSON.parse(out.stdout()).action, 'some_future_action')
}

{
  const out = capture()
  out.io.stdin = Readable.from(['{"text":"hello"}'])
  const code = await runCli(['type_text', '--stdin', '--json'], out.io)
  assert.equal(code, 0)
  assert.deepEqual(calls.at(-1), { action: 'type_text', payload: { text: 'hello' } })
}

{
  const out = capture()
  out.io.stdin = Readable.from(['{"actions":[{"action":"wait","seconds":1}],"future_field":true}'])
  const code = await runCli(['request', '--stdin', '--json'], out.io)
  assert.equal(code, 0)
  assert.deepEqual(calls.at(-1), {
    request: { actions: [{ action: 'wait', seconds: 1 }], future_field: true },
  })
}

{
  const out = capture()
  const code = await runCli(['doctor', '--probe', '--json'], out.io)
  assert.equal(code, 0)
  const result = JSON.parse(out.stdout())
  assert.equal(result.checks[0].detail, 'true')
}

{
  const out = capture()
  const code = await runCli(['click', '--stdin', '--payload', '{}'], out.io)
  assert.equal(code, 2)
  assert.match(out.stderr(), /either --stdin or --payload/)
}

console.log('cli check PASSED')
