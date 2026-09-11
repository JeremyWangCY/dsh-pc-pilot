import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const names = ['bootstrap', 'observation', 'background-input', 'capture', 'dispatch']
const nativeDir = path.join(root, 'native/helper')
const target = path.join(root, 'lib/pc-pilot-helper.ps1')
const packaged = !fs.existsSync(path.join(nativeDir, 'bootstrap.ps1'))
if (packaged) {
  if (process.argv.includes('--check')) {
    console.log('build-helper: native/helper sources not packaged; skip bundle staleness check')
    process.exit(0)
  }
  console.error('build-helper: native/helper sources not packaged; cannot rebuild helper')
  process.exit(1)
}
const output = names.map(name => fs.readFileSync(path.join(nativeDir, `${name}.ps1`), 'utf8')).join('')
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== output) throw new Error('Helper bundle stale: run npm run build:helper')
} else fs.writeFileSync(target, output)
