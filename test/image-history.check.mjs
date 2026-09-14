import assert from 'node:assert/strict'
import { defineComputerTool, prunePcPilotImageHistory, suppressDuplicatePcPilotScreenshot } from '../lib/index.js'

const imageBlock = (id) => ({
  type: 'image',
  attachment: { attachmentId: id, mediaType: 'image/png', bytes: 100, width: 20, height: 10 },
})

function toolCall(seq, callId, name = 'computer') {
  return { type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: '{}' } }
}

function toolResult(seq, callId, withImage = true) {
  return {
    type: 'tool/result',
    seq,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `msg-${callId}`,
        role: 'user',
        source: { kind: 'tool', callId },
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [
            { type: 'text', text: `result ${callId}` },
            ...(withImage ? [imageBlock(`img-${callId}`)] : []),
          ],
        }],
      },
    },
  }
}
class FakeSession {
  constructor(events, surfaceNodes) {
    this.events = [...events]
    this.surface = { nodes: [...surfaceNodes] }
  }

  snapshotEvents(fromSeq = 0) {
    return this.events.slice(fromSeq)
  }

  eventAt(seq) {
    return this.events[seq]
  }

  append(type, data, opts) {
    assert.equal(type, 'tool/result')
    assert.equal(opts.surfaceOp.op, 'replace')
    assert.equal(opts.surfaceOp.startSeq, opts.surfaceOp.endSeq)
    assert.deepEqual(opts.sourceEventSeqs, [opts.surfaceOp.startSeq])

    const index = this.surface.nodes.indexOf(opts.surfaceOp.startSeq)
    assert.ok(index >= 0, 'replacement must target a current surface node')
    const seq = this.events.length
    const event = { type, seq, data, ...opts }
    this.events.push(event)
    this.surface.nodes.splice(index, 1, seq)
    return event
  }
}
const events = [
  toolCall(0, 'pc-1'),
  toolResult(1, 'pc-1'),
  toolCall(2, 'pc-2'),
  toolResult(3, 'pc-2'),
  toolCall(4, 'pc-3'),
  toolResult(5, 'pc-3'),
  toolCall(6, 'other-1', 'other-tool'),
  toolResult(7, 'other-1'),
]
const session = new FakeSession(events, [1, 3, 5, 7])

const first = prunePcPilotImageHistory(session, 2)
assert.equal(first.pruned, 1)
assert.equal(first.remaining, 2)
assert.equal(first.replacements[0].originalSeq, 1)

const replacement = session.eventAt(first.replacements[0].replacementSeq)
assert.equal(replacement.data.message.id, 'msg-pc-1')
assert.equal(replacement.data.message.source.callId, 'pc-1')
assert.equal(replacement.data.message.content[0].toolCallId, 'pc-1')
assert.equal(replacement.data.message.content[0].content.some((b) => b.type === 'image'), false)
assert.match(replacement.data.message.content[0].content.at(-1).text, /Older PC-Pilot screenshot omitted/)

// A non-PC-Pilot tool image must never be touched.
assert.equal(session.eventAt(7).data.message.content[0].content.some((b) => b.type === 'image'), true)

const second = prunePcPilotImageHistory(session, 1)
assert.equal(second.pruned, 1)
assert.equal(second.remaining, 1)
assert.equal(second.replacements[0].originalSeq, 3)

// Missing session capabilities are a no-op rather than a tool failure.
assert.deepEqual(prunePcPilotImageHistory(null, 2), { pruned: 0, remaining: 0 })

// Attachment metadata is internal; the model receives the actual image block once.
const tool = defineComputerTool((definition) => definition, {})
const attachment = { attachmentId: 'current', mediaType: 'image/png', bytes: 100, width: 20, height: 10 }
const blocks = tool.output.render({}, { ok: true, foo: 'bar', screenshot_attachment: attachment })
assert.equal(blocks.length, 2)
assert.equal(blocks[0].type, 'text')
assert.equal(blocks[0].text.includes('screenshot_attachment'), false)
assert.equal(blocks[1].type, 'image')
assert.deepEqual(blocks[1].attachment, attachment)

const duplicateSession = new FakeSession([
  toolCall(0, 'same-1'),
  toolResult(1, 'same-1'),
], [1])
const duplicate = suppressDuplicatePcPilotScreenshot({
  ok: true,
  screenshot_id: 'fresh-shot',
  screenshot_attachment: { attachmentId: 'img-same-1', mediaType: 'image/png', bytes: 100, width: 20, height: 10 },
}, duplicateSession)
assert.equal(duplicate.screenshot_attachment, undefined)
assert.equal(duplicate.visual_unchanged_from_previous, true)
assert.equal(duplicate.screenshot_id, 'fresh-shot')

const changed = suppressDuplicatePcPilotScreenshot({
  ok: true,
  screenshot_attachment: { attachmentId: 'different', mediaType: 'image/png', bytes: 100, width: 20, height: 10 },
}, duplicateSession)
assert.equal(changed.screenshot_attachment.attachmentId, 'different')
assert.equal(changed.visual_unchanged_from_previous, undefined)

console.log('image-history check PASSED')
