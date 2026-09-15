// Model-facing instructions registered with DSH's runtime skill registry.
// Keep the catalog entry narrow; load the full skill only when the task needs
// multi-step UI state management or recovery guidance.
export const PC_PILOT_SKILL = Object.freeze({
  name: 'pc-pilot',
  description: 'Operate a Windows desktop and PC-Pilot-owned Chromium browser. Use for multi-step UI work or recovery.',
  whenToUse: 'Load for multi-step desktop/browser tasks, stale-state recovery, or background/foreground decisions. Skip simple one-step calls.',
  source: 'runtime',
  content: `# PC-Pilot computer use

Use the \`computer\` tool for Windows apps and PC-Pilot-owned Chromium sessions. Preserve the current target and act from observed state; do not invent element ids, coordinates, tab ids, URLs, or success.

## Keep the target stable
- Reuse the returned \`window\` or \`browser: { endpoint, tab_id }\` target object. The legacy \`browser_endpoint\` / \`tab_id\` fields remain valid. Recover in place before opening or launching a replacement.
- Desktop input is background-first. Use foreground interaction only when the background path is unavailable and the user explicitly asked for foreground control.

## Observe only when needed
- \`get_window_state\` is screenshot-first. Add \`include_text: true\` only when you need indexed UIA elements, document text, or \`accessibility_status\`.
- An \`element_index\` is valid only with the \`snapshot_id\` from the same state. Browser element tokens and short \`@eN\` refs are valid only for their current tab/document; stale refs are rejected.
- Reuse a returned \`post_action_observation\` when it already contains the evidence needed for the next decision. Do not call \`get_window_state\`, \`browser_state\`, or \`browser_observe\` merely because an action occurred.
- Refresh state when a snapshot/token is stale, the tool returns \`needs_observation\` or \`unknown\`, the target changed, or the next action needs information the current result does not contain.

## Act and verify
- Prefer semantic element actions over coordinates. If coordinates are necessary, use the current screenshot and include \`expected_name\` when available.
- Use \`expect\` when there is a concrete success condition. Treat an \`unknown\` mutation outcome as uncertain and inspect the same target; do not repeat the mutation automatically.
- On stale state, loading, timeout, or \`background_unavailable\`, take the narrowest evidence-backed recovery on the current target rather than restarting the app/browser.

## Browser tasks
- Keep one exact \`browser_endpoint\` and \`tab_id\`. Prefer compact \`browser_observe\` for model-facing semantic state: it returns short \`@eN\` refs without raw UUID token noise. \`browser_state\` preserves both refs and raw tokens for compatibility. Observe when needed, not as a mandatory extra step after every action.
- For file inputs, \`browser_upload\` only selects explicit absolute file paths on an observed \`@eN\`/token and verifies the selection. It does not choose local files or submit the surrounding form for the agent.
- If an action already verifies its result, continue from that result. If it reports \`needs_observation\`, refresh that same tab before trusting the changed field or page.

## Finish
Preserve the user's existing windows and tabs. Close only temporary resources created for the task, after the requested result is established.`,
})

export const PC_PILOT_SKILL_HINT = 'Load `pc-pilot` for multi-step or recovery-heavy computer tasks; simple one-step calls can use the tool schema directly.'
