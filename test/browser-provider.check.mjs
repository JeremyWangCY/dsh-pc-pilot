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
  const defaultRuntime = createPcPilotRuntime()
  try {
    const missingEndpoint = await defaultRuntime.act('browser_open', { url: 'https://example.test/' })
    assert.equal(missingEndpoint.error_code, 'browser_action_rejected')
    assert.equal(missingEndpoint.message,
      'browser_endpoint required (use launch_app with name: "msedge" and headless: true to start an isolated browser session first, or pass the returned browser: { endpoint, tab_id })')
  } finally {
    defaultRuntime.close()
  }

  assert.equal(runtime.status().providers.browser, 'test-browser-provider')
  assert.throws(() => runtime.bind(null), /bound defaults must be an object/)
  assert.throws(() => runtime.bind([]), /bound defaults must be an object/)

  const browser = { endpoint: 'ws://127.0.0.1:9222/devtools/browser/test' }
  const result = await runtime.act('browser_tabs', {
    browser,
    future_field: 'kept',
  })
  assert.equal(result.ok, true)
  assert.equal(result.provider_marker, 'kept')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'browser_tabs')
  assert.equal(calls[0].args.browser_endpoint, browser.endpoint)
  assert.equal(calls[0].args.future_field, 'kept')
  assert.deepEqual(result.browser, browser)

  const boundTarget = { browser: { ...browser, tab_id: 'tab-1' } }
  const page = runtime.bind(boundTarget)
  boundTarget.browser.tab_id = 'mutated-after-bind'
  const observed = await page.act('browser_observe')
  assert.equal(calls.at(-1).args.browser_endpoint, browser.endpoint)
  assert.equal(calls.at(-1).args.tab_id, 'tab-1')
  assert.deepEqual(observed.browser, { ...browser, tab_id: 'tab-1' })

  await page.act('browser_read', { browser: { tab_id: 'tab-call' } })
  assert.equal(calls.at(-1).args.browser_endpoint, browser.endpoint, 'call override preserves bound endpoint')
  assert.equal(calls.at(-1).args.tab_id, 'tab-call', 'call payload overrides bound tab')

  const rebound = page.bind({ browser: { tab_id: 'tab-2' } })
  await rebound.act('browser_read')
  assert.equal(calls.at(-1).args.browser_endpoint, browser.endpoint, 'nested bind preserves endpoint')
  assert.equal(calls.at(-1).args.tab_id, 'tab-2', 'nested bind can replace only the tab')

  const batchStart = calls.length
  const batch = await page.run({
    actions: [
      { action: 'browser_observe' },
      { action: 'browser_read' },
    ],
  })
  assert.equal(batch.ok, true)
  assert.equal(batch.completed_count, 2)
  assert.equal(calls.length, batchStart + 2)
  for (const call of calls.slice(batchStart)) {
    assert.equal(call.args.browser_endpoint, browser.endpoint)
    assert.equal(call.args.tab_id, 'tab-1')
  }

  const conditionalCalls = []
  const conditional = createPcPilotRuntime({
    browserProvider: createBrowserProvider({
      name: 'conditional-provider',
      execute: async (action, args) => {
        conditionalCalls.push({ action, args })
        if (action === 'browser_state') return { ok: true, action, outcome: 'completed', url: 'https://example.test/ready' }
        return { ok: true, action, outcome: 'completed', tabs: [] }
      },
    }),
  })
  try {
    const target = { endpoint: 'ws://127.0.0.1:9222/devtools/browser/conditional', tab_id: 'tab-c' }
    const allowed = await conditional.act('browser_tabs', {
      browser: target,
      when: { type: 'browser_url', url: 'https://example.test/', match: 'prefix' },
    })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.precondition.ok, true)
    assert.deepEqual(conditionalCalls.map(call => call.action), ['browser_state', 'browser_tabs'])

    conditionalCalls.length = 0
    const blocked = await conditional.act('browser_tabs', {
      browser: target,
      when: { type: 'browser_url', url: 'https://different.test/' },
    })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.outcome, 'not_executed')
    assert.equal(blocked.error_code, 'precondition_not_met')
    assert.deepEqual(conditionalCalls.map(call => call.action), ['browser_state'], 'unmet browser precondition must prevent action dispatch')
  } finally {
    conditional.close()
  }

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
