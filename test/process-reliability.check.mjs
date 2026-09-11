import assert from 'node:assert/strict'
import cp from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'

const originals = { spawn: cp.spawn, copy: fs.copyFileSync, set: globalThis.setTimeout, clear: globalThis.clearTimeout }
let children, timers, behavior
cp.spawn = (exe, argv) => {
  if (behavior === 'spawn-throw') throw new Error('spawn unavailable')
  const child = new EventEmitter()
  child.unref = () => {}
  child.kill = () => { child.kills++; return false }
  child.kills = 0
  for (const key of ['stdin', 'stdout', 'stderr']) {
    child[key] = new EventEmitter()
    for (const method of ['unref', 'resume', 'setEncoding']) child[key][method] = () => {}
  }
  child.argv = argv
  child.writes = []
  child.stdin.write = child.stdin.end = (data) => {
    child.writes.push(data)
    if (behavior === 'write-throw') throw new Error('write failed')
  }
  children.push(child)
  return child
}
fs.copyFileSync = () => {}
globalThis.setTimeout = (fn, ms) => { const t = { fn, ms, unref() {} }; timers.add(t); return t }
globalThis.clearTimeout = t => timers.delete(t)
syncBuiltinESMExports()
let serial = 0, failures = 0
async function check(name, fn) {
  children = []; timers = new Set(); behavior = ''
  const mod = await import(`../lib/index.js?reliability=${serial++}`)
  try { await fn(mod); console.log('PASS', name) }
  catch (err) { failures++; console.error('FAIL', name, err.message) }
  finally { mod.stopDaemon() }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
async function settled(p) {
  let result
  p.then(v => { result = v })
  await flush()
  assert.ok(result, 'promise must settle without waiting for child close')
  return result
}
const unknown = r => { assert.equal(r.ok, false); assert.match(r.message, /outcome unknown/i) }
try {
  for (const route of ['runAction', 'execute']) await check(`${route}: pre-aborted never spawns`, async m => {
    const signal = AbortSignal.abort()
    const r = route === 'runAction' ? await settled(m.runAction('click', {}, signal)) : await settled(m.defineComputerTool(d => d).execute({ action: 'click' }, { signal }))
    assert.equal(r.ok, false); assert.equal(children.length, 0)
  })
  for (const event of ['timeout', 'abort', 'stdin-error', 'error', 'empty-close']) await check(`one-shot ${event}`, async m => {
    const controller = new AbortController()
    const p = m.runAction('click', {}, controller.signal)
    await flush()
    const child = children[0]
    if (event === 'timeout') [...timers].find(t => t.ms === 30000).fn()
    if (event === 'abort') controller.abort()
    if (event === 'stdin-error') child.stdin.emit('error', new Error('EPIPE'))
    if (event === 'error') child.emit('error', new Error('lost process'))
    if (event === 'empty-close') child.emit('close', 1)
    unknown(await settled(p))
    assert.equal(timers.size, 0)
    child.stdout.emit('data', Buffer.from('{"ok":true}'))
    child.emit('close', 0)
    unknown(await p)
  })
  for (const event of ['close', 'error', 'stdin-error', 'write-throw', 'timeout', 'abort', 'stop']) await check(`daemon ${event}: no replay`, async m => {
    const controller = new AbortController()
    behavior = event
    const p = m.defineComputerTool(d => d).execute({ action: 'click' }, { signal: controller.signal })
    await flush()
    const child = children[0]
    if (event === 'close') child.emit('close', 1)
    if (event === 'error') child.emit('error', new Error('lost process'))
    if (event === 'stdin-error') child.stdin.emit('error', new Error('EPIPE'))
    if (event === 'timeout') [...timers].find(t => t.ms === 20000).fn()
    if (event === 'abort') controller.abort()
    if (event === 'stop') m.stopDaemon()
    unknown(await settled(p))
    assert.equal(children.length, 1, 'must not spawn fallback after dispatch')
    assert.equal(child.writes.length, 1)
  })
  await check('abort during daemon acquisition never writes', async m => {
    const controller = new AbortController()
    const p = m.defineComputerTool(d => d).execute({ action: 'click' }, { signal: controller.signal })
    controller.abort()
    assert.equal((await p).ok, false)
    assert.equal(children.reduce((n, c) => n + c.writes.length, 0), 0)
  })
  await check('one-shot successful JSON remains compatible', async m => {
    const p = m.runAction('list_apps', {})
    await flush()
    children[0].stdout.emit('data', Buffer.from('warning\n{"ok":true,"apps":[]}'))
    children[0].emit('close', 0)
    assert.deepEqual(await p, { ok: true, apps: [] })
    assert.equal(timers.size, 0)
  })
  await check('one-shot synchronous write failure settles', async m => {
    behavior = 'write-throw'
    unknown(await settled(m.runAction('click', {})))
    assert.equal(timers.size, 0)
  })
  await check('one-shot cancellation during helper acquisition', async m => {
    const controller = new AbortController()
    const p = m.runAction('click', {}, controller.signal)
    controller.abort()
    assert.equal((await p).ok, false)
    assert.equal(children.length, 0)
  })
  await check('daemon concurrent pending requests never replay on disconnect', async m => {
    const tool = m.defineComputerTool(d => d)
    const calls = [tool.execute({ action: 'click' }), tool.execute({ action: 'type_text', text: 'submit' })]
    await flush()
    assert.equal(children.length, 1)
    assert.equal(children[0].writes.length, 2)
    children[0].emit('close', 1)
    for (const p of calls) unknown(await settled(p))
    assert.equal(children.length, 1)
    assert.equal(timers.size, 0)
  })
  await check('pre-dispatch spawn failure can use one-shot fallback', async m => {
    behavior = 'spawn-throw'
    const p = m.defineComputerTool(d => d).execute({ action: 'click' })
    // The synchronous daemon spawn failure happens before fallback acquisition.
    for (let i = 0; i < 2; i++) await Promise.resolve()
    behavior = ''
    await flush()
    assert.equal(children.length, 1)
    children[0].stdout.emit('data', Buffer.from('{"ok":true}'))
    children[0].emit('close', 0)
    await flush()
    assert.equal(children.length, 2, 'canonical action performs one separate post-action observation')
    const observation = JSON.parse(children[1].writes[0])
    children[1].stdout.emit('data', JSON.stringify({ id: observation.id, ok: true }) + '\n')
    const value = await settled(p)
    assert.equal(value.ok, true)
    assert.equal(value.post_action_observation.ok, true)
  })
  await check('daemon successful response and click schema remain compatible', async m => {
    const tool = m.defineComputerTool(d => d)
    assert.deepEqual(tool.parameters.properties.coordinate_space.enum, ['screen', 'window'])
    assert.equal(tool.parameters.properties.expected_name.type, 'string')
    const p = tool.execute({ action: 'click', expected_name: 'Save', coordinate_space: 'screen' })
    await flush()
    const request = JSON.parse(children[0].writes[0])
    assert.equal(request.expected_name, 'Save')
    assert.equal(request.coordinate_space, 'screen')
    const reply = { id: request.id, ok: true, action: 'click' }
    children[0].stdout.emit('data', JSON.stringify(reply) + '\n')
    await flush()
    assert.equal(children[0].writes.length, 2, 'canonical action requests a fresh observation')
    const observation = JSON.parse(children[0].writes[1])
    children[0].stdout.emit('data', JSON.stringify({ id: observation.id, ok: true }) + '\n')
    const value = await settled(p)
    assert.deepEqual({ ok: value.ok, action: value.action, outcome: value.outcome }, { ok: true, action: 'click', outcome: undefined })
    assert.equal(value.post_action_observation.ok, true)
  })
  for (const [action, budget] of [['click', 20000], ['wait', 40000]]) {
    await check(`${action}: daemon and one-shot budgets`, async m => {
      const tool = m.defineComputerTool(d => d)
      assert.equal(tool.timeoutMs, 200000)
      const p = tool.execute({ action })
      await flush()
      assert.ok([...timers].some(t => t.ms === budget))
      m.stopDaemon(); unknown(await settled(p))
      const q = m.runAction(action, {})
      await flush()
      const argv = children.at(-1).argv
      assert.equal(argv[argv.indexOf('-TimeoutMs') + 1], String(budget))
      const deadline = [...timers].find(t => t.ms === budget + 10000)
      assert.ok(deadline); deadline.fn()
      unknown(await settled(q))
    })
  }
  await check('idle timer never arms while another request remains pending', async m => {
    const tool = m.defineComputerTool(d => d)
    const p = tool.execute({ action: 'list_apps' })
    const q = tool.execute({ action: 'wait', duration_s: 30 })
    await flush()
    const child = children[0]
    const [a, b] = child.writes.map(JSON.parse)
    child.stdout.emit('data', JSON.stringify({ id: a.id, ok: true }) + '\n')
    await settled(p)
    assert.ok(![...timers].some(t => t.ms === 300000))
    assert.equal(child.kills, 0)
    child.stdout.emit('data', JSON.stringify({ id: b.id, ok: true }) + '\n')
    await flush()
    const observation = JSON.parse(child.writes[2])
    child.stdout.emit('data', JSON.stringify({ id: observation.id, ok: true }) + '\n')
    await settled(q)
    const idle = [...timers].find(t => t.ms === 300000)
    assert.ok(idle)
    const r = tool.execute({ action: 'wait' })
    await flush()
    assert.ok(!timers.has(idle))
    idle.fn() // Even an already queued callback must not kill pending work.
    assert.equal(child.kills, 0)
    m.stopDaemon(); unknown(await settled(r))
  })
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64')
  const shotDir = path.join(os.tmpdir(), 'dsh-cua')
  fs.mkdirSync(shotDir, { recursive: true })
  const shot = path.join(shotDir, `shot-${randomUUID().replaceAll('-', '')}.png`)
  const outside = path.join(os.tmpdir(), `shot-${randomUUID().replaceAll('-', '')}.png`)
  try {
    for (const mode of ['valid', 'outside', 'bad-name', 'bad-png', 'too-large', 'too-wide', 'hardlink', 'no-route', 'text-route', 'no-store', 'save-error']) {
      await check(`native image ${mode}`, async m => {
        fs.writeFileSync(shot, png)
        fs.writeFileSync(outside, png)
        let file = shot, saves = 0
        if (mode === 'outside') file = outside
        if (mode === 'bad-name') file = path.join(shotDir, 'arbitrary.png')
        if (mode === 'bad-png') fs.writeFileSync(shot, Buffer.alloc(50))
        if (mode === 'too-large') fs.truncateSync(shot, 8 * 1024 * 1024 + 1)
        if (mode === 'too-wide') { const bad = Buffer.from(png); bad.writeUInt32BE(20000, 16); fs.writeFileSync(shot, bad) }
        if (mode === 'hardlink') { fs.unlinkSync(shot); fs.linkSync(outside, shot) }
        const ref = { attachmentId: 'test-image', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }
        const store = { imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 20000000, maxMessageImageBytes: 20000000, maxImageDimension: 8192, maxImagePixels: 64000000 },
          async saveImage(input) { saves++; assert.deepEqual(input.data, png); if (mode === 'save-error') throw new Error('store unavailable'); return ref } }
        const ctx = { get(name) { return name === 'attachments' ? (mode === 'no-store' ? undefined : store) : { async resolveModelInfo() { return { inputModalities: mode === 'text-route' ? ['text'] : ['image'] } } } } }
        const tool = m.defineComputerTool(d => d, ctx)
        const args = { action: 'get_window_state' }
        const exec = mode === 'no-route' ? {} : { agent: { options: { provider: 'fixture', model: 'fixture' } } }
        const p = tool.execute(args, exec)
        await flush()
        const request = JSON.parse(children[0].writes[0])
        children[0].stdout.emit('data', JSON.stringify({ id: request.id, ok: true, screenshot: { path: file }, snapshot_id: 'snapshot-1' }) + '\n')
        const value = await settled(p)
        const blocks = tool.output.render(args, JSON.parse(JSON.stringify(value)))
        assert.equal(value.snapshot_id, 'snapshot-1')
        assert.equal(blocks.length, mode === 'valid' ? 2 : 1)
        if (mode === 'valid') assert.deepEqual(blocks[1], { type: 'image', attachment: ref })
        assert.equal(saves, ['valid', 'save-error'].includes(mode) ? 1 : 0)
        assert.equal(children.length, 1, 'image failure never replays the action')
        fs.unlinkSync(shot)
      })
    }
  } finally {
    for (const file of [shot, outside]) if (fs.existsSync(file)) fs.unlinkSync(file)
  }
} finally {
  cp.spawn = originals.spawn; fs.copyFileSync = originals.copy
  globalThis.setTimeout = originals.set; globalThis.clearTimeout = originals.clear
  syncBuiltinESMExports()
}
assert.equal(failures, 0, `${failures} reliability checks failed`)

// Optional real OS-process fault injection. Fixtures perform no desktop input.
if (process.argv.includes('--real')) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  for (const [route, fault] of [['one-shot', 'timeout'], ['daemon', 'timeout'], ['daemon', 'exit'], ['one-shot', 'abort']]) {
    const spawned = []
    cp.spawn = (_exe, argv, options) => {
      const command = fault === 'exit'
        ? "$null = [Console]::In.ReadLine(); [Console]::Error.WriteLine('fixture-action-recorded'); [Console]::Error.Flush(); [Environment]::Exit(9)"
        : 'Start-Sleep -Seconds 240'
      const child = originals.spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', command], options)
      let recorded = ''
      child.stderr.on('data', data => { recorded += data })
      child.closed = new Promise(resolve => child.once('close', resolve))
      child.recorded = () => recorded
      spawned.push(child)
      return child
    }
    syncBuiltinESMExports()
    const m = await import(`../lib/index.js?real=${route}-${fault}`)
    const controller = new AbortController()
    const started = performance.now()
    try {
      const p = route === 'one-shot' ? m.runAction('click', {}, controller.signal) : m.defineComputerTool(d => d).execute({ action: 'click' }, { signal: controller.signal })
      const abortTimer = fault === 'abort' ? setTimeout(() => controller.abort(), 500) : undefined
      const result = await p
      clearTimeout(abortTimer)
      unknown(result)
      assert.equal(spawned.length, 1, 'real process failure must not replay')
      if (fault === 'exit') assert.match(spawned[0].recorded(), /fixture-action-recorded/)
      const elapsed = performance.now() - started
      assert.ok(elapsed < (route === 'one-shot' ? 35000 : 25000), `bounded wall time: ${elapsed}`)
      let guard
      try { await Promise.race([spawned[0].closed, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('child did not close after termination')), 5000) })]) }
      finally { clearTimeout(guard) }
      assert.throws(() => process.kill(spawned[0].pid, 0), 'terminated child must not survive')
      console.log(`PASS real PowerShell ${route} ${fault}: ${Math.round(elapsed)}ms, one spawn, child exited`)
    } finally {
      m.stopDaemon()
      for (const child of spawned) { try { child.kill() } catch {} }
      cp.spawn = originals.spawn; syncBuiltinESMExports()
    }
  }
}
