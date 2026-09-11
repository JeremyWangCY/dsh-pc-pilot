import assert from 'node:assert/strict'
import { PC_PILOT_SKILL, PC_PILOT_SKILL_HINT } from '../lib/pc-pilot-skill.js'
import { apply, defineComputerTool } from '../lib/index.js'

assert.equal(PC_PILOT_SKILL.name, 'pc-pilot')
assert.equal(PC_PILOT_SKILL.source, 'runtime')
assert.match(PC_PILOT_SKILL.description, /Windows desktop|Chromium browser/i)
for (const rule of ['get_window_state', 'element_index', 'snapshot_id', 'browser_state', 'browser_endpoint', '`unknown`', 'background']) {
  assert.ok(PC_PILOT_SKILL.content.includes(rule), `skill must teach ${rule}`)
}

const registered = defineComputerTool((tool) => tool, {})
assert.ok(registered.description.includes(PC_PILOT_SKILL_HINT), 'tool description routes a zero-context agent to the runtime skill')
let registeredSkill
let registeredTool
apply({
  tools: { register(tool) { registeredTool = tool } },
  skills: { register(skill) { registeredSkill = skill } },
})
assert.equal(registeredSkill, PC_PILOT_SKILL, 'apply registers the exact model-facing skill with DSH')
assert.equal(registeredTool?.name, 'computer', 'apply registers the computer tool under DSH schema validation')
console.log('PASS: PC-Pilot runtime skill is complete and discoverable from computer')
