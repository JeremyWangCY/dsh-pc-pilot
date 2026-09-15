import assert from 'node:assert/strict'
import { defineComputerTool } from '../lib/index.js'

const parameters = defineComputerTool().parameters
const unsupportedUnions = []
const pending = [{ value: parameters, path: '$' }]

while (pending.length > 0) {
  const { value, path } = pending.pop()
  if (!value || typeof value !== 'object') continue
  if (Array.isArray(value)) {
    value.forEach((child, index) => pending.push({ value: child, path: `${path}[${index}]` }))
    continue
  }
  if (Object.hasOwn(value, 'oneOf')) unsupportedUnions.push(path)
  for (const [key, child] of Object.entries(value)) {
    pending.push({ value: child, path: `${path}.${key}` })
  }
}

assert.deepEqual(unsupportedUnions, [],
  `Gemini legacy function parameters must not contain oneOf: ${unsupportedUnions.join(', ')}`)

const props = parameters.properties
assert.equal(props.path.type, 'array')
assert.equal(props.path.items.type, 'object')
assert.deepEqual(Object.keys(props.path.items.properties).sort(), ['x', 'y'])
const requiredPointFields = props.path.items.required || Object.entries(props.path.items.properties)
  .filter(([, schema]) => schema.required === true)
  .map(([name]) => name)
  .sort()
assert.deepEqual(requiredPointFields, ['x', 'y'])
assert.equal(props.screenshot_path.type, 'string')

const guardedHostContext = new Proxy({}, {
  get(_target, property) {
    throw new Error(`cannot get property "${String(property)}" without inject`)
  },
})
assert.doesNotThrow(() => defineComputerTool(undefined, guardedHostContext),
  'tool definition must not probe optional uninjected host services')

console.log('Gemini tool schema compatibility check PASSED')
