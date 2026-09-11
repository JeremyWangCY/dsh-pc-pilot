// Model-facing instructions registered with DSH's runtime skill registry.
// Keep this separate from the computer tool schema: the catalog stays cheap,
// while an agent can load the full operating discipline when it needs a
// computer task.
export const PC_PILOT_SKILL = Object.freeze({
  name: 'pc-pilot',
  description: 'Use PC-Pilot to operate a Windows desktop or an isolated Chromium browser reliably: observe, act from fresh evidence, verify, and recover in place.',
  whenToUse: 'Load before a multi-step task involving a local Windows app, website, browser tab, screenshot, typing, or pointer action.',
  source: 'runtime',
  content: `# PC-Pilot computer use

Use the \`computer\` tool to operate Windows applications and AI-owned Chromium sessions. Treat every observed UI state as a point-in-time fact: inspect the exact target, make the smallest supported change, then inspect again. Do not invent element ids, coordinates, tab ids, URLs, or success.

PC-Pilot uses the ChatGPT Windows Computer Use desktop vocabulary directly: \`list_apps\`, \`list_windows\`, \`get_window\`, \`launch_app\`, \`get_window_state\`, \`click\`, \`press_key\`, \`type_text\`, \`scroll\`, \`drag\`, \`set_value\`, \`perform_secondary_action\`, and \`activate_window\`. Pass a returned \`window: { id, app }\` object unchanged; \`id\` is the target HWND. Use \`element_index\`, \`mouse_button\`, \`scrollX\`, \`scrollY\`, and \`include_screenshot\`. For \`perform_secondary_action\`, provide its label as \`secondary_action\`, because this single-tool envelope already uses \`action\` for the method name.

## Pick and preserve the target

- For a desktop app, start with \`list_apps\`, choose one returned window, then call \`get_window_state { window, include_screenshot: true }\`. Keep that app/window for the task. Do not open a replacement window because one control, screenshot, or wait failed.
- For a browser task, keep one returned \`browser_endpoint\` and one exact \`tab_id\`. Call \`browser_state { browser_endpoint, include_url: true }\` only to select a tab, then use \`browser_state { browser_endpoint, tab_id }\` for all work in it. Open a new tab only when the task itself needs another page; close only a tab created for this task after its work is verified.
- Prefer the background desktop path. It keeps the user's mouse, keyboard, and foreground window untouched. Use \`dispatch: "foreground"\` only when the requested interaction has no background path and the user has asked for real foreground control.

## Observe, act, refresh

- A desktop \`get_window_state\` yields a \`snapshot_id\` and indexed elements. Every element action must carry that same \`snapshot_id\`. Any mutation, navigation, scrolling, or meaningful delay invalidates it: obtain a new state before the next element action.
- Prefer \`click { window, element_index }\`, \`set_value\`, and \`perform_secondary_action\` over coordinates. If a coordinate is necessary, use one taken from the current screenshot/window state and include \`expected_name\`. If the name check fails, stop and observe; never click the unexpected target.
- Before typing, focus the observed editable control. Use \`set_value\` or \`browser_replace\` for known full-field replacement; use \`type_text\` or \`browser_type\` only to append at the verified caret. Re-observe text after an edit instead of assuming the application accepted it.
- Browser element tokens are bound to their current page. Use \`browser_click\`, \`browser_type\`, and \`browser_key\` only with a token from the latest \`browser_state\`, and include \`expected_url\` when navigation would make a wrong target costly.
- Do not use a stale screenshot as a map. The tool's per-window screenshot is occlusion-immune; if it reports \`screenshot_black\`, the target frame was unavailable. Do not fall back to the covering desktop image.

## Navigate without churn

- Scroll in small observed steps. After each scroll, inspect the same page/window. Stop when the target appears; do not run a fixed sequence of repeated scrolls.
- On a web page, use \`browser_scroll_to_text\` for an exact visible label or passage. Use \`browser_click_text\` only for a visible custom control that has no semantic token. These actions include open Shadow DOM; ordinary \`browser_state\` and visible text do too.
- Keep related actions in their current tab. Searching, opening a temporary reference, returning, editing, publishing, confirming, screenshotting, and cleanup are separate observations, not reasons to restart the browser.

## Confirm changes and recover correctly

- For an action with an external effect—submit, comment, like, delete, purchase, sign in—execute it once, wait for its own evidence, and inspect the current state. For asynchronous pages, \`browser_click { capture_network: true, capture_network_wait_ms }\` can collect a bounded post-click signal.
- Classify an incomplete response as \`unknown\`, not failure. Check the same tab and any permitted first-party read endpoint. If it remains unknown, preserve the tab and report the uncertainty; never repeat the effect automatically.
- On a stale token, missing control, loading page, timeout, or background-unavailable result, refresh the current target and take the narrowest evidence-backed recovery. Do not re-search, create another browser, reload blindly, or close the working window.
- Take a requested screenshot only after the required visible result is present. Verify cleanup independently before closing a temporary tab or window.

## Finish cleanly

State what was observed, what was changed, and the evidence for the result. Preserve the user's existing windows and tabs. Close only temporary resources created by this task and only after all requested work and confirmation are complete.`,
})

export const PC_PILOT_SKILL_HINT = 'For any multi-step computer task, load the `pc-pilot` skill first. It provides the reusable observe → smallest action → refresh discipline and in-place recovery rules.'
