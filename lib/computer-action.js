// Model-facing Computer Use argument normalization and action capability sets.

export const OBSERVE_AFTER_ACTIONS = new Set([
  'click', 'drag', 'scroll', 'press_key', 'type_text', 'set_value', 'wait', 'mouse_move',
])

export const FOREGROUND_RECOVERY_ACTIONS = new Set([
  'click', 'press_key', 'type_text', 'scroll', 'drag', 'mouse_down', 'mouse_up', 'hold_key',
])

export function normalizeComputerAction(input = {}) {
  const args = { ...(input || {}) }
  const requestedAction = String(args.action || 'list_apps')
  let action = requestedAction

  if (action === 'double_click') {
    action = 'click'
    if (args.click_count === undefined) args.click_count = 2
  } else if (action === 'type') {
    action = 'type_text'
  } else if (action === 'keypress') {
    action = 'press_key'
    if (args.key === undefined && Array.isArray(args.keys) && args.keys.length > 0) {
      args.key = args.keys.map(String).join('+')
    }
  } else if (action === 'move') {
    action = 'mouse_move'
  }
  args.action = action
  if (args.window && typeof args.window === 'object' && !Array.isArray(args.window)) {
    if (args.hwnd === undefined && args.window.id !== undefined) args.hwnd = args.window.id
    if (args.app === undefined && args.window.app !== undefined) args.app = args.window.app
  }
  if (args.browser && typeof args.browser === 'object' && !Array.isArray(args.browser)) {
    if (args.browser_endpoint === undefined && args.browser.endpoint !== undefined) args.browser_endpoint = args.browser.endpoint
    if (args.tab_id === undefined && args.browser.tab_id !== undefined) args.tab_id = args.browser.tab_id
  }
  if (args.element === undefined && args.element_index !== undefined) args.element = args.element_index
  if (args.button === undefined && args.mouse_button !== undefined) args.button = args.mouse_button
  if (typeof args.button === 'string') {
    const mouseButton = args.button.toLowerCase()
    if (mouseButton === 'l') args.button = 'left'
    else if (mouseButton === 'r') args.button = 'right'
    else if (mouseButton === 'm' || mouseButton === 'wheel') args.button = 'middle'
  }
  if (args.screenshot === undefined && args.include_screenshot !== undefined) {
    args.screenshot = args.include_screenshot
  }
  if (args.scroll_x === undefined && args.scrollX !== undefined) args.scroll_x = args.scrollX
  if (args.scroll_y === undefined && args.scrollY !== undefined) args.scroll_y = args.scrollY
  if (action === 'launch_app') {
    if (args.name === undefined) args.name = args.app
    delete args.app
  }
  if (args.screenshot_id === undefined && args.screenshotId !== undefined) {
    args.screenshot_id = args.screenshotId
  }
  if (action === 'zoom' && args.path === undefined && typeof args.screenshot_path === 'string') {
    args.path = args.screenshot_path
  }
  if (action === 'zoom') delete args.screenshot_path
  if (action === 'perform_secondary_action' && typeof args.secondary_action === 'string') {
    args.secondary_action = args.secondary_action.trim().toLowerCase().replace(/[\s-]+/g, '_')
  }
  if ((requestedAction === 'scroll' || action === 'scroll')
      && (args.scroll_x !== undefined || args.scroll_y !== undefined)) {
    const sx = Number(args.scroll_x || 0)
    const sy = Number(args.scroll_y || 0)
    const component = (delta, positive, negative) => ({
      amount: Math.max(1, Math.round(Math.abs(delta) / 120)),
      direction: delta > 0 ? positive : negative,
    })
    if (sx !== 0 && sy !== 0) {
      args.scroll_components = [
        component(sx, 'right', 'left'),
        component(sy, 'down', 'up'),
      ]
      Object.assign(args, args.scroll_components[0])
    } else if (sx !== 0) {
      Object.assign(args, component(sx, 'right', 'left'))
    } else if (sy !== 0) {
      Object.assign(args, component(sy, 'down', 'up'))
    }
  }

  if (requestedAction === 'drag' && Array.isArray(args.path) && args.path.length >= 2) {
    const pointXY = (point) => Array.isArray(point)
      ? (point.length >= 2 ? [Number(point[0]), Number(point[1])] : null)
      : (point && typeof point === 'object'
          && Number.isFinite(Number(point.x))
          && Number.isFinite(Number(point.y))
          ? [Number(point.x), Number(point.y)] : null)
    const first = pointXY(args.path[0])
    const last = pointXY(args.path.at(-1))
    if (first && last) {
      args.from_x = first[0]
      args.from_y = first[1]
      args.to_x = last[0]
      args.to_y = last[1]
    }
  }

  if (['click', 'scroll', 'drag'].includes(requestedAction)
      && Array.isArray(args.keys)
      && args.keys.length > 0
      && args.modifiers === undefined) {
    args.modifiers = args.keys.map((key) => String(key)).join(',')
  }

  return { requestedAction, action, args }
}
