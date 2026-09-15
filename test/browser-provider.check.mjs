import assert from 'node:assert/strict'
import { createBrowserProvider } from '../lib/browser-provider.js'
import { createPcPilotRuntime } from '../lib/runtime.js'

const calls = []
const provider = createBrowserProvider({
  name: 'test-browser-provider',
  execute: async (action, args, signal) => {
    calls.push({ action, args, aborted: signal?.aborted === true })
    return {
      ok: true,
      action,
      outcome: 'completed',
      tabs: [],
      provider_marker: args.future_field,
    }
  },
})

const runtime = createPcPilotRuntime({ browserProvider: provider })
try {
  assert.equal(runtime.status().providers.browser, 'test-browser-provider')

  const result = await runtime.act('browser_tabs', {
    browser_endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    future_field: 'kept',
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider_marker, 'kept')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'browser_tabs')
  assert.equal(calls[0].args.future_field, 'kept')

  const uncertainCalls = []
  const uncertain = createPcPilotRuntime({
    browserProvider: createBrowserProvider({
      name: 'uncertain-provider',
      execute: async (action, args) => {
        uncertainCalls.push({ action, args })
        return { ok: false, action, outcome: 'unknown', message: 'transport uncertain' }
      },
    }),
  })
  try {
    const value = await uncertain.act('browser_tabs', {
      browser_endpoint: 'ws://127.0.0.1:9222/devtools/browser/test',
    })
    assert.equal(value.ok, false)
    assert.equal(value.outcome, 'unknown')
    assert.equal(uncertainCalls.length, 1, 'provider result must never be replayed automatically')
  } finally {
    uncertain.close()
  }
} finally {
  runtime.close()
}

console.log('browser provider check PASSED')
