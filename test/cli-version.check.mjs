import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseCliArgs, runCli } from '../lib/cli.js'

const PACKAGE_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version

function makeIo() {
  let out = ''
  let err = ''
  return {
    stdout: { write: (chunk) => { out += chunk } },
    stderr: { write: (chunk) => { err += chunk } },
    stdin: (async function* () {})(),
    get out() { return out },
    get err() { return err },
  }
}

const runtimeStub = () => ({
  status: () => ({ ok: true, version: PACKAGE_VERSION }),
  doctor: () => ({ ok: true, checks: [] }),
  run: () => ({ ok: true }),
  act: () => ({ ok: true }),
  close: () => {},
})

// --version answers from the manifest alone; it must never boot the runtime.
let runtimeStarted = false
const versionIo = makeIo()
const versionCode = await runCli(['--version'], {
  ...versionIo,
  runtimeFactory: () => { runtimeStarted = true; return runtimeStub() },
})
assert.equal(versionCode, 0, '--version must exit 0')
assert.equal(versionIo.out.trim(), PACKAGE_VERSION, '--version must print the package version')
assert.equal(versionIo.err, '', '--version must not write to stderr')
assert.equal(runtimeStarted, false, '--version must not start the runtime')

const shortIo = makeIo()
assert.equal(await runCli(['-v'], { ...shortIo, runtimeFactory: runtimeStub }), 0, '-v must exit 0')
assert.equal(shortIo.out.trim(), PACKAGE_VERSION, '-v must match --version')

const jsonIo = makeIo()
assert.equal(await runCli(['--version', '--json'], { ...jsonIo, runtimeFactory: runtimeStub }), 0)
assert.equal(jsonIo.out.trim(), PACKAGE_VERSION, '--version --json still prints the bare version')

assert.equal(parseCliArgs(['--version']).command, 'version', 'parseCliArgs must route --version')
assert.equal(parseCliArgs(['-v']).command, 'version', 'parseCliArgs must route -v')

console.log('cli version check PASSED')
