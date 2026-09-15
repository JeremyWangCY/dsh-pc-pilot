import { browserAction } from './browser-session.js'

export function createBrowserProvider({
  name = 'cdp-session',
  execute = browserAction,
} = {}) {
  if (typeof execute !== 'function') throw new TypeError('browser provider execute must be a function')
  return Object.freeze({
    name,
    execute(action, args = {}, signal) {
      return execute(action, args, signal)
    },
  })
}

export const defaultBrowserProvider = createBrowserProvider()
