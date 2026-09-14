const POSTCONDITION_TYPES = new Set([
  'window_exists', 'window_closed', 'accessibility_changed',
  'element_value', 'text_present',
  'browser_url', 'browser_text', 'browser_ready', 'download_completed',
])

export function normalizedExpectation(raw) {
  if (raw === undefined || raw === null) return null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('expect must be an object')
  const type = String(raw.type || '')
  if (!POSTCONDITION_TYPES.has(type)) throw new Error('expect.type is not supported')
  const timeout_ms = Math.max(0, Math.min(10000, Number(raw.timeout_ms ?? 2500)))
  if (!Number.isFinite(timeout_ms)) throw new Error('expect.timeout_ms must be 0..10000')
  const match = raw.match === undefined ? undefined : String(raw.match)
  if (match !== undefined && !['exact', 'contains', 'prefix'].includes(match)) {
    throw new Error('expect.match must be exact, contains, or prefix')
  }
  const out = { ...raw, type, timeout_ms, ...(match ? { match } : {}) }
  if (type === 'element_value' && (typeof raw.element_id !== 'string' || !raw.element_id)) {
    throw new Error('expect.element_id required')
  }
  if (type === 'element_value' && typeof raw.value !== 'string') throw new Error('expect.value required')
  if (['text_present', 'browser_text'].includes(type) && (typeof raw.text !== 'string' || !raw.text)) {
    throw new Error('expect.text required')
  }
  if (type === 'browser_url' && (typeof raw.url !== 'string' || !raw.url)) throw new Error('expect.url required')
  if (type === 'download_completed' && (typeof raw.filename !== 'string' || !raw.filename)) {
    throw new Error('expect.filename required')
  }
  return out
}

function expectedString(actual, expected, match = 'exact') {
  actual = String(actual ?? '')
  expected = String(expected ?? '')
  if (match === 'contains') return actual.includes(expected)
  if (match === 'prefix') return actual.startsWith(expected)
  return actual === expected
}

export function evaluatePostconditionObservation(expect, observation) {
  const e = normalizedExpectation(expect)
  if (!e) return { ok: true, type: 'none' }
  const base = { type: e.type }

  if (e.type === 'window_exists') {
    return { ...base, ok: observation?.ok === true, observed: observation?.ok === true ? 'present' : 'missing' }
  }
  if (e.type === 'window_closed') {
    const closed = observation?.ok !== true && ['window_not_found', 'app_not_found'].includes(observation?.error_code)
    return {
      ...base,
      ok: closed,
      observed: observation?.ok === true ? 'present' : closed ? 'closed' : 'unknown',
      ...(observation?.error_code ? { error_code: observation.error_code } : {}),
    }
  }
  if (e.type === 'accessibility_changed') {
    const delta = observation?.accessibility_delta ?? observation?.accessibility?.delta
    if (!delta || delta.reset) return { ...base, ok: false, reason: 'accessibility_baseline_unavailable' }
    const changed = (delta.added?.length || 0) + (delta.removed?.length || 0) + (delta.changed?.length || 0)
    return {
      ...base,
      ok: changed > 0,
      changed_count: changed,
      revision: observation?.accessibility_revision ?? observation?.accessibility?.revision,
    }
  }
  if (e.type === 'element_value') {
    const element = Array.isArray(observation?.elements)
      ? observation.elements.find(item => item?.element_id === e.element_id)
      : null
    if (!element) return { ...base, ok: false, reason: 'element_not_found', element_id: e.element_id }
    const match = e.match || 'exact'
    return {
      ...base,
      ok: expectedString(element.value, e.value, match),
      element_id: e.element_id,
      match,
      observed_value: String(element.value ?? ''),
    }
  }
  if (e.type === 'text_present') {
    const haystack = [
      observation?.document_text,
      ...(Array.isArray(observation?.elements)
        ? observation.elements.flatMap(item => [item?.name, item?.value])
        : []),
    ].filter(Boolean).join('\n')
    return { ...base, ok: haystack.includes(e.text), text: e.text }
  }
  if (e.type === 'browser_url') {
    const match = e.match || 'exact'
    return {
      ...base,
      ok: expectedString(observation?.url, e.url, match),
      match,
      observed_url: String(observation?.url ?? ''),
    }
  }
  if (e.type === 'browser_text') {
    const haystack = String(observation?.text ?? observation?.body_text ?? observation?.visible_text ?? '')
    return { ...base, ok: haystack.includes(e.text), text: e.text }
  }
  if (e.type === 'browser_ready') {
    return {
      ...base,
      ok: observation?.ready_state === 'complete' || observation?.ready === true,
      ready_state: observation?.ready_state,
    }
  }
  if (e.type === 'download_completed') {
    const match = e.match || 'exact'
    const files = Array.isArray(observation?.files) ? observation.files : []
    const downloads = Array.isArray(observation?.downloads) ? observation.downloads : []
    const file = files.find(item => expectedString(item?.name, e.filename, match))
    const event = downloads.find(item => expectedString(item?.suggested_filename, e.filename, match)
      && item?.state === 'completed')
    return { ...base, ok: Boolean(file || event), filename: e.filename, match, path: file?.path }
  }
  return { ...base, ok: false, reason: 'unsupported_postcondition' }
}
export function remapStableElementForRecovery(requestArgs, state) {
  if (requestArgs?.element === undefined) return { ok: true, args: { ...requestArgs } }
  if (typeof requestArgs.element_id !== 'string' || !requestArgs.element_id) {
    return { ok: false, reason: 'element_id_required_for_safe_recovery' }
  }
  const found = Array.isArray(state?.elements)
    ? state.elements.find(item => item?.element_id === requestArgs.element_id)
    : null
  if (!found) return { ok: false, reason: 'stable_element_not_found' }
  return {
    ok: true,
    args: {
      ...requestArgs,
      element: found.index,
      element_index: found.index,
      snapshot_id: state.snapshot_id,
    },
  }
}
