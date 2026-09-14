import fs from 'node:fs'
import path from 'node:path'

export const PC_PILOT_VISIBLE_IMAGE_HISTORY = 2
const PRUNED_IMAGE_TEXT = '[Older PC-Pilot screenshot omitted from active visual context; use the newer PC-Pilot screenshots for the current state.]'

function screenshotFile(file, screenshotDir) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('invalid screenshot path')
  const resolved = path.resolve(file)
  if (path.dirname(resolved) !== screenshotDir
      || !/^(shot|disp|zoom)-[a-f0-9]{32}\.png$/i.test(path.basename(resolved))) {
    throw new Error('not a plugin screenshot')
  }
  if (fs.realpathSync(screenshotDir) !== screenshotDir
      || fs.realpathSync(resolved) !== resolved
      || fs.lstatSync(resolved).isSymbolicLink()) {
    throw new Error('redirected screenshot path')
  }
  return resolved
}

export function createScreenshotAttacher({ screenshotDir, maxPngBytes = 8 * 1024 * 1024 }) {
  return async function attachScreenshot(value, args, exec, ctx) {
    if (!value?.ok || !ctx?.get || exec?.signal?.aborted) return value
    const action = args?.action || (Array.isArray(args?.actions) ? 'batch' : 'list_apps')
    const observations = []
    if (action === 'batch' && Array.isArray(value.steps)) {
      const last = value.steps[value.steps.length - 1]
      if (last?.post_action_observation) observations.push(last.post_action_observation)
      if (last) observations.push(last)
    }
    if (value.post_action_observation) observations.push(value.post_action_observation)
    observations.push(value)

    let file
    let sourceFile
    for (const candidate of observations) {
      if (!candidate) continue
      const found = candidate.screenshot?.path || candidate.path
      if (found) {
        file = found
        sourceFile = candidate.source_path
        break
      }
    }
    if (!file) return value

    try {
      const attachments = ctx.get('attachments')
      const llm = ctx.get('llm')
      const limits = attachments?.imageLimits
      if (!attachments?.saveImage || !llm || !limits?.mediaTypes?.includes('image/png')) return value
      const routed = exec?.agent?.session?.requestHeader()?.config
      const provider = routed?.provider ?? exec?.agent?.options?.provider
      const model = routed?.model ?? exec?.agent?.options?.model
      if (provider === undefined || model === undefined) return value
      const info = await llm.resolveModelInfo(provider, model, exec?.signal)
      if (!info?.inputModalities?.includes('image') || exec?.signal?.aborted) return value

      const safePath = screenshotFile(file, screenshotDir)
      if (sourceFile) screenshotFile(sourceFile, screenshotDir)
      const cap = Math.min(maxPngBytes, limits.maxImageBytes, limits.maxMessageImageBytes)
      if (!Number.isFinite(cap)
          || cap < 33
          || !Number.isFinite(limits.maxImageDimension)
          || !Number.isFinite(limits.maxImagePixels)) {
        return value
      }

      const fd = fs.openSync(safePath, 'r')
      let data
      try {
        const stat = fs.fstatSync(fd)
        if (!stat.isFile() || stat.nlink !== 1 || stat.size < 33 || stat.size > cap) return value
        data = Buffer.alloc(stat.size)
        if (fs.readSync(fd, data, 0, data.length, 0) !== data.length) return value
      } finally {
        fs.closeSync(fd)
      }

      if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          || data.readUInt32BE(8) !== 13
          || data.toString('ascii', 12, 16) !== 'IHDR') {
        return value
      }
      const width = data.readUInt32BE(16)
      const height = data.readUInt32BE(20)
      if (!width || !height
          || width > Math.min(16384, limits.maxImageDimension)
          || height > Math.min(16384, limits.maxImageDimension)
          || width * height > Math.min(32000000, limits.maxImagePixels)) {
        return value
      }

      const ref = await attachments.saveImage({
        data,
        mediaType: 'image/png',
        name: path.basename(safePath),
      })
      if (exec?.signal?.aborted) return value
      return {
        ...value,
        screenshot_attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined
            ? {}
            : { originalDimensions: { ...ref.originalDimensions } }),
        },
      }
    } catch {
      return value
    }
  }
}

function toolResultHasImage(event) {
  const result = event?.data?.message?.content?.[0]
  return event?.type === 'tool/result'
    && result?.type === 'tool-result'
    && Array.isArray(result.content)
    && result.content.some((block) => block?.type === 'image')
}

const callIndex = new WeakMap()

function pcPilotCallIdsForSession(session) {
  if (!session || typeof session.snapshotEvents !== 'function') return new Set()
  let indexed = callIndex.get(session)
  if (!indexed) indexed = { nextSeq: 0, callIds: new Set() }
  const events = session.snapshotEvents(indexed.nextSeq)
  for (const event of events) {
    if (event?.type === 'tool/call'
        && event.data?.name === 'computer'
        && event.data.callId !== undefined) {
      indexed.callIds.add(event.data.callId)
    }
  }
  indexed.nextSeq += events.length
  callIndex.set(session, indexed)
  return indexed.callIds
}

function imageCandidates(session) {
  if (!session?.surface?.nodes || typeof session.eventAt !== 'function') return []
  const callIds = pcPilotCallIdsForSession(session)
  const candidates = []
  for (const seq of [...session.surface.nodes]) {
    const event = session.eventAt(seq)
    const source = event?.data?.message?.source
    if (toolResultHasImage(event) && source?.kind === 'tool' && callIds.has(source.callId)) {
      candidates.push({ seq, event })
    }
  }
  return candidates
}

export function suppressDuplicatePcPilotScreenshot(result, session) {
  const currentId = result?.screenshot_attachment?.attachmentId
  if (!currentId) return result
  const latest = imageCandidates(session).at(-1)?.event?.data?.message?.content?.[0]?.content
  const previousId = Array.isArray(latest)
    ? latest.find((block) => block?.type === 'image')?.attachment?.attachmentId
    : undefined
  if (!previousId || previousId !== currentId) return result
  const { screenshot_attachment: _duplicate, ...rest } = result
  return { ...rest, visual_unchanged_from_previous: true }
}
export function prunePcPilotImageHistory(session, keepImages = PC_PILOT_VISIBLE_IMAGE_HISTORY) {
  const keep = Math.max(0, Math.floor(Number(keepImages) || 0))
  if (!session?.surface?.nodes
      || typeof session.eventAt !== 'function'
      || typeof session.snapshotEvents !== 'function'
      || typeof session.append !== 'function') {
    return { pruned: 0, remaining: 0 }
  }

  const candidates = imageCandidates(session)
  const pruneCount = Math.max(0, candidates.length - keep)
  const replacements = []

  for (const { seq, event } of candidates.slice(0, pruneCount)) {
    const result = event.data.message.content[0]
    let markerInserted = false
    const content = []
    for (const block of result.content) {
      if (block?.type !== 'image') {
        content.push(block)
        continue
      }
      if (!markerInserted) {
        content.push({ type: 'text', text: PRUNED_IMAGE_TEXT })
        markerInserted = true
      }
    }

    const message = {
      ...event.data.message,
      content: [{ ...result, content }],
    }
    const replacement = session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
      sourceEventSeqs: [seq],
    })
    replacements.push({
      originalSeq: seq,
      replacementSeq: replacement?.seq,
      callId: event?.data?.message?.source?.callId,
    })
  }

  return {
    pruned: replacements.length,
    remaining: candidates.length - replacements.length,
    replacements,
  }
}
