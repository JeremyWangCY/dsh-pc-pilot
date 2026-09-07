// Manual smoke (not part of npm test): daemon round-trips + same-pid proof.
import { defineComputerTool, getDaemonPid, stopDaemon } from '../lib/index.js'
const tool = defineComputerTool((d) => d)
const t0 = performance.now()
const r1 = await tool.execute({ action: 'list_apps' })
const t1 = performance.now()
const r2 = await tool.execute({ action: 'list_apps' })
const t2 = performance.now()
console.log('reply1 ok=' + r1.ok + ' action=' + r1.action + ' apps=' + (r1.apps ? r1.apps.length : '?') + ' ms=' + Math.round(t1 - t0))
console.log('reply2 ok=' + r2.ok + ' action=' + r2.action + ' apps=' + (r2.apps ? r2.apps.length : '?') + ' ms=' + Math.round(t2 - t1))
console.log('daemon pid=' + getDaemonPid())
process.exit(r1.ok && r2.ok && getDaemonPid() ? 0 : 1)
