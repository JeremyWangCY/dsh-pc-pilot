import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoDir = path.resolve(__dirname, '..')

console.log('Running virtual-display setup check...')

// 1. package.json: marketplace admission standard (dshhub schema v1, modeled on dsh-cost-meter)
const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'))
assert.ok(pkg.dshhub, 'package.json must declare dshhub marketplace metadata')
assert.equal(pkg.dshhub.schemaVersion, 1, 'dshhub.schemaVersion must be 1')
assert.ok(pkg.dshhub.displayName, 'dshhub.displayName required')
assert.ok(pkg.dshhub.summary, 'dshhub.summary required')
assert.ok(Array.isArray(pkg.dshhub.categories) && pkg.dshhub.categories.length > 0, 'dshhub.categories required')
assert.ok(Array.isArray(pkg.dshhub.surfaces) && pkg.dshhub.surfaces.length > 0, 'dshhub.surfaces required')
assert.ok(Array.isArray(pkg.dshhub.capabilities?.provides) && pkg.dshhub.capabilities.provides.length > 0, 'dshhub.capabilities.provides required')
assert.ok(pkg.dshhub.compatibility?.dsh, 'dshhub.compatibility.dsh required')
assert.ok(Array.isArray(pkg.dshhub.permissions?.network), 'dshhub.permissions.network must be declared for setup downloads')
assert.ok(
  pkg.dshhub.permissions.network.some((u) => u.includes('github.com')),
  'network permissions must cover the driver download host (github.com)',
)
assert.equal(pkg.dsh.compatibility?.dsh, pkg.dshhub.compatibility.dsh, 'dsh.compatibility must agree with dshhub.compatibility')
assert.ok(pkg.bin && pkg.bin['dsh-pc-pilot'], 'bin["dsh-pc-pilot"] must exist for npx one-command setup')
assert.ok(pkg.os.includes('win32'), 'os must include win32')
assert.ok(pkg.engines.node, 'engines.node required')
assert.ok(pkg.files.includes('bin'), 'files must ship bin/')
assert.ok(pkg.files.includes('lib'), 'files must ship lib/')
assert.ok(/deepseek-harness/.test(pkg.keywords.join(' ')), 'keywords must include deepseek-harness')

// 2. setup script: pinned download, integrity + signature checks, idempotent stages
const setupPath = path.join(repoDir, 'lib', 'setup-virtual-display.ps1')
const setupSrc = fs.readFileSync(setupPath, 'utf8')
assert.ok(fs.existsSync(setupPath), 'lib/setup-virtual-display.ps1 must exist')
assert.ok(/DRIVER_URL\s*=\s*'https:\/\/github\.com\//.test(setupSrc), 'driver download URL must be pinned to https github.com')
assert.ok(/DRIVER_SHA256\s*=\s*'[0-9a-f]{64}'/.test(setupSrc), 'driver download must pin a SHA256 digest')
assert.ok(setupSrc.includes("Get-AuthenticodeSignature"), 'setup must verify Authenticode signature before install')
assert.ok(setupSrc.includes('VERYSILENT'), 'setup must use the silent Inno Setup switches')
assert.ok(setupSrc.includes("-Verb RunAs"), 'setup must request elevation for the driver installer')
assert.ok(setupSrc.includes("'status'") && setupSrc.includes("'install'") && setupSrc.includes("'activate'") && setupSrc.includes("'auto'"), 'setup must expose idempotent stages')
assert.ok(setupSrc.includes("Get-PnpDevice"), 'setup must probe installed driver state before installing')
assert.ok(setupSrc.includes('DSHSETUP'), 'setup must emit a machine-readable DSHSETUP JSON line')
assert.ok(
  setupSrc.indexOf('{1280,720}') < setupSrc.indexOf('{1920,1080}'),
  'preferred canvas mode must be the lower resolution (bigger icons, easier to read in the PiP mirror)',
)

// 3. bin entry must exist and only run on win32
const binPath = path.join(repoDir, 'bin', 'setup.mjs')
assert.ok(fs.existsSync(binPath), 'bin/setup.mjs must exist')
const binSrc = fs.readFileSync(binPath, 'utf8')
assert.ok(binSrc.includes("os.platform() !== 'win32'"), 'bin entry must refuse non-Windows platforms')
assert.ok(binSrc.includes('setup-virtual-display.ps1') && binSrc.includes('-File'), 'bin must run the setup script and surface its DSHSETUP result via stdout passthrough')

// 4. wiring: index.js exposes the action and distributes the script; helper dispatches it
const indexSrc = fs.readFileSync(path.join(repoDir, 'lib', 'index.js'), 'utf8')
assert.ok(indexSrc.includes("'setup_virtual_display'"), 'index.js must expose setup_virtual_display in the tool enum')
assert.ok(indexSrc.includes('SETUP_SOURCE') && indexSrc.includes('SETUP_TARGET'), 'index.js must copy setup-virtual-display.ps1 to temp with the helper')

const helperSrc = fs.readFileSync(path.join(repoDir, 'lib', 'computer-use-helper.ps1'), 'utf8')
assert.ok(helperSrc.includes("'setup_virtual_display'"), 'helper must implement the setup_virtual_display action')
assert.ok(helperSrc.includes('setup-virtual-display.ps1'), 'helper must invoke the sibling setup script')

// 5. canvas feature regression guards (from the virtual-display round)
assert.ok(helperSrc.includes('function Get-DshVirtualCanvas'), 'helper must define Get-DshVirtualCanvas')
assert.ok(helperSrc.includes('function Move-WindowToCanvas'), 'helper must define Move-WindowToCanvas')
assert.ok(helperSrc.includes('GetVddRect'), 'display enumeration must run inside C# (PowerShell DISPLAY_DEVICE marshaling fails silently)')

// 6. cordis.patch.yml bundle registration stays in place
assert.ok(fs.existsSync(path.join(repoDir, 'cordis.patch.yml')), 'cordis.patch.yml must exist')
const patch = fs.readFileSync(path.join(repoDir, 'cordis.patch.yml'), 'utf8')
assert.ok(patch.includes('id: computer-use') && patch.includes('name: dsh-pc-pilot'), 'bundle patch must register the computer-use host row')

console.log('virtual-display check PASSED')
