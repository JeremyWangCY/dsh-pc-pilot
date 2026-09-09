#!/usr/bin/env node
// dsh-pc-pilot one-command virtual display setup.
// Usage: npx dsh-pc-pilot        (or: npm exec dsh-pc-pilot)
// All human-facing text (banner, hints) is printed by the PowerShell script so
// the whole console stream stays in one encoding (node's UTF-8 output garbles
// on GBK-codepage consoles).
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

if (os.platform() !== 'win32') {
  console.error('dsh-pc-pilot virtual display setup: Windows only.')
  process.exit(1)
}

const script = path.join(__dirname, '..', 'lib', 'setup-virtual-display.ps1')
if (!fs.existsSync(script)) {
  console.error('dsh-pc-pilot: lib/setup-virtual-display.ps1 not found; the package install may be incomplete.')
  process.exit(1)
}

const ps = process.env.PS_EXE || 'powershell.exe'
const res = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', 'auto', '-Banner'], {
  stdio: 'inherit',
  timeout: 300000,
})
if (res.error && res.error.code === 'ETIMEDOUT') {
  console.error('dsh-pc-pilot setup timed out after 5 minutes (a pending UAC prompt blocks the installer).')
  console.error('Approve or cancel the UAC dialog, then re-run this command to verify.')
}
process.exit(res.status ?? 1)
