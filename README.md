# dsh-pc-pilot

English | [中文](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-green)

A **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin** that gives the model a single `computer` tool to observe and operate the local Windows desktop: an indexed UIA accessibility tree, per-window screenshots, background synthetic-cursor input that never steals focus, and — when a task truly requires it — real SendInput mouse/keyboard control.

While acting, the model moves a small **on-screen cursor indicator** (a rounded arrow with a soft blue radial glow) to each target point, and a frosted-glass status pill at the top center of the screen shows that PC-Pilot is running (with a breathing green dot on the right). Both are click-through, never take focus, and auto-hide three seconds after the last action.

## Features

- **One tool, full desktop plus browser** — the desktop surface uses ChatGPT Windows Computer Use names directly: `list_apps`, `list_windows`, `get_window`, `launch_app`, `get_window_state`, `click`, `press_key`, `type_text`, `scroll`, `drag`, `set_value`, `perform_secondary_action`, and `activate_window`.
- **Reusable Windows targets** — observations return `window: { id, app }`, which can be supplied unchanged to the next action. Element actions use `element_index`; screenshot coordinates use `scrollX` / `scrollY` and `mouse_button` where applicable.
- **Background-first input** — actions run via UIA action patterns (Invoke / Toggle / Selection / ExpandCollapse / RangeValue / Transform), then pixel hit-testing, then `WM_CHAR` / `WM_KEY` / `WM_MOUSEWHEEL` messages. The target window is not brought forward and the user's real mouse/keyboard are never hijacked.
- **State-bound actions** — `get_window_state` returns a `snapshot_id` and `screenshot_id`; element actions must present that snapshot and coordinate actions can bind to the screenshot. Expired, moved, wrong-window, changed-element, or consumed state is rejected instead of falling back to a potentially wrong control.
- **Browser semantic route** — `browser_state`, `browser_click`, `browser_type`, and `browser_key` use an explicit loopback DevTools endpoint belonging to the isolated AI browser profile. `launch_app { app: "msedge.exe", headless: true }` starts that isolated Chromium process (per-launch temp profile, vendor welcome tab auto-closed) and exposes the endpoint; `browser_*` never attaches to the user's own browser. `browser_shutdown` closes only a browser launched by the same PC-Pilot tool instance. Browser tokens are tab/document/name/role-bound and stale tokens are rejected without retry. Tab listing withholds URL/title unless `include_url: true`; tab snapshots carry `page_status` so blocked/crashed/error pages are legible instead of reading as 0-element successes. URLs are HTTP(S) only — `file://` is rejected (serve local content over a local HTTP server).
- **Bounded failure semantics** — one-shot helper calls have an external deadline watchdog. A timeout, disconnect, or post-dispatch transport error reports `outcome: "unknown"`; mutating actions are never replayed automatically.
- **Computer-use loop parity** — send up to 20 ordered actions through `actions`; execution stops at the first failed or uncertain step, and canonical input actions return a fresh post-action observation. Browser mutations include a CDP PNG capture.
- **Structured safety classification** — obvious consequential target names and sensitive browser fields are classified in the result for future host policy integration; the current PC-Pilot profile does not interpose confirmation.
- **Occlusion-immune background clicks** — with an `app` specified, coordinate clicks aim at the target window's own UIA tree / hwnd, so a fully covered window can be operated unattended while the user keeps working on top.
- **Rich mouse vocabulary** — `click` supports OpenAI's `left`, `right`, `wheel` (middle), `back`, and `forward` buttons plus a bounded `click_count`; `scroll` preserves simultaneous `scrollX` / `scrollY` axes; `drag` uses `path`.
- **OpenAI action spelling compatibility** — `double_click`, `type`, `keypress { keys: [...] }`, and `move` are accepted alongside the Windows canonical `click`, `type_text`, `press_key`, and `mouse_move` actions.
- **O(1) element lookup** — `get_window_state` caches the UIA element list inside the persistent helper daemon, so `click { element_index }`, `set_value`, `perform_secondary_action`, `select_text`, and `type_text` resolve without a second full-tree traversal.
- **Occlusion-immune screenshots** — a bundled Windows Graphics Capture bridge first captures the target HWND even when it is covered; `PrintWindow` (multi-flag ladder) is the occlusion-immune fallback. Both ask the window to render its own frame, so a covering window can never leak into the shot; there is deliberately no screen-DC degradation — when neither tier can render, the result is a legible `screenshot_black` error instead of a frame of the occluder. The result reports its capture method and trust level. The bridge is framework-dependent and activates when .NET 8 is available; PrintWindow keeps the plugin usable without it.
- **Per-task dispatch** — `dispatch: "foreground"` (real SendInput) exists for the cases that genuinely need it (canvas clicks, unsupported drags, apps with no background path); the tool guidance keeps background as the default and asks the model to be explicit when it goes foreground.
- **Virtual-cursor indicator** — per-pixel-alpha layered window (`UpdateLayeredWindow` + `CreateDIBSection`): rounded white arrow with black outline over a soft blue radial glow. Click-through (`WS_EX_TRANSPARENT`), non-activating (`WS_EX_NOACTIVATE` + `SW_SHOWNOACTIVATE`), always-on-top. Auto-hides 3 s after the last action and reappears on the next one.
- **High-DPI accurate** — the overlay calls `SetProcessDPIAware` at startup and positions itself in physical pixels, matching the physical coordinates the helper reports from UIA. Correct placement at 100% / 125% / 150% scaling.
- **PowerShell 5.1 + 7 (Core) compatible** — the overlay adds the `System.Private.Windows.GdiPlus` / `System.Private.Windows.Core` references under .NET Core so both runtimes render the cursor identically.
- **Frosted status pill** — while the overlay is active, a dark frosted-glass pill sits top-center on the primary screen reading "PC-Pilot 运行中" with a breathing green dot on the right (Apple-style: rounded capsule, subtle top sheen, sine-wave breathing). Same per-pixel-alpha layered-window technique as the cursor, `TOPMOST` + `NOACTIVATE` + click-through, so it never intercepts input; it hides 4 s after the last activity.

## Requirements

- Windows 10 or 11
- DeepSeek Harness (DSH) with the `dsh-pc-pilot` bundle loaded in the `web` profile
- PowerShell 5.1 (built into Windows) and Node.js ≥ 22.12 (shipped with DSH)
- .NET 8 Desktop/Runtime is optional; when present, the bundled WGC bridge provides occlusion-independent native HWND screenshots. Without it, occlusion-immune `PrintWindow` capture keeps the plugin usable.

## Installation

### From the DSH plugin market

Once listed, search for *dsh-pc-pilot* in the market and click install.

### From a GitHub release

```powershell
npm install https://github.com/JeremyWangCY/dsh-pc-pilot/releases/download/v0.3.1/dsh-pc-pilot-0.3.1.tgz
```

Run this inside the DSH profile (`~/.dsh/profiles/web`), then restart the host.

### From source

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
npm install ./dsh-pc-pilot
```

Or link it manually: add `"dsh-pc-pilot": "link:./vendor/dsh-pc-pilot"` to the profile's `package.json` dependencies, add the bundle to `dsh.profile.bundles`, run `npm install`, and restart the host.

## Status pill

While the overlay is enabled (default), each first action launches two tiny resident PowerShell loops from the helper directory: the virtual-cursor indicator and the frosted status pill. They read a state file under `%TEMP%\dsh-cua` — the pill is visible top-center while activity is fresh (≤ 4 s) and fades out afterwards; both processes idle-exit after 120 s and respawn on demand. No driver, no UAC, no display changes — PC-Pilot runs entirely on the user's real desktop, in the background.

## Usage

The plugin registers one global tool, `computer`. Typical flow:

1. `computer { action: "list_apps" }` — running apps with pids, window titles, hwnds and rects.
2. `computer { action: "get_window_state", window: { id, app }, include_screenshot: true }` — indexed accessibility tree (element index / role / name / value / automation_id / rect / invokable) plus a window screenshot and `snapshot_id`.
3. Act on the state — element actions include the `snapshot_id` from the same observation. Browser actions use `browser_state` first, then a tab id and `browser_element` token.
4. Refresh the state after every UI change; element indexes are only valid for the `get_window_state` that produced them.

### Action reference (46 actions)

| Action | Purpose |
| --- | --- |
| `list_apps` / `list_windows` / `list_displays` | Enumerate apps / per-app windows / display topology |
| `get_window_state` | Indexed UIA tree + per-window PNG screenshot + document text |
| `click` | Coordinate click or snapshot-bound `element_index` click |
| `set_value` / `type_text` / `perform_secondary_action` / `select_text` | Element-level write, text entry, named UIA pattern, text-range selection |
| `press_key` / `hold_key` | Key chords and timed holds |
| `scroll` | Standard `scroll_x/scroll_y` (including target-window horizontal UIA scrolling), or legacy `amount` plus `direction` |
| `move` / `mouse_move` / `mouse_down` / `mouse_up` | Standard move plus raw mouse primitives |
| `drag` | Standard `path` or legacy endpoints; element move (background) or real SendInput drag (foreground) |
| `screenshot` / `zoom` | Full-display or region capture; crop the latest shot |
| `switch_display` / `cursor_position` | Default capture display; real cursor location |
| `launch_app` / `wait` | Launch an app silently in the background (WindowStyle Minimized at the bottom, zero flicker or focus theft); registered Windows activation protocols such as `ms-settings:display` are supported. Delegated app launches return a target only when exactly one new window is safely identifiable; pause between actions |
| `activate_window` / `close_window` / `get_window` | Bring window to foreground / request a graceful WM_CLOSE and verify disappearance (otherwise returns `window_close_unconfirmed`) / query fresh window geometry & metadata |
| `read_clipboard` / `write_clipboard` | Clipboard round-trip |
| `browser_state` / `browser_shutdown` | List tabs (ids only unless `include_url: true`) or return a bounded semantic snapshot of an AI-owned browser tab (with `page_status`); close the entire browser only when this PC-Pilot tool instance launched it |
| `browser_click` / `browser_type` / `browser_key` | Operate a token from the latest `browser_state`; stale or changed targets are rejected |

### Key parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `dispatch` | `background` | UIA patterns + window messages; never steals focus. `foreground` uses real SendInput — pick it per task only when the user asked for real control or the essential action has no background path. |
| `activate` | `false` | `launch_app` only: normal foreground launch. Keep the default minimized background launch unless the user asked to bring the app forward or a modern app requires foreground UIA. |
| `overlay` | `true` | Show the click-through cursor at each action point; it auto-hides 3 s after the last action. |
| `include_screenshot` | `true` | Capture a per-window PNG in `get_window_state`. |
| `include_text` | `false` | Include the indexed accessibility tree and document text when an element action is needed. On a window-targeted `wait`, include it in the post-wait observation to check application readiness without a second round-trip. |
| `wait_for` | — | On a window-targeted `wait`, wait for `accessibility_present` (any UIA descendant) or `accessibility_available` (a complete UIA tree). A timeout is an explicit, retry-safe `wait_condition_timeout`. |
| `app` | — | pid number, process name, or window-title substring; same-titled duplicate windows are rejected unless `window_index` or `hwnd` identifies one, while differently titled windows of one app auto-resolve and return `chosen_hwnd`. |
| `snapshot_id` | — | Required for desktop element actions; use the id from the latest `get_window_state { include_text: true }`. |
| `browser_endpoint` / `tab_id` / `browser_element` | — | Explicit loopback DevTools endpoint, exact tab id, and token from the latest `browser_state`. |
| `x` / `y` | — | Window-local pixels with `app`/`hwnd`, matching ChatGPT Computer Use; screen coordinates without a target. Set `coordinate_space: "screen"` only for an explicit absolute click. |
| `button` / `click_count` / `keys` | `left` / `1` / — | Mouse button and legacy click repetitions; `keys` supplies standard keypress chords and mouse modifiers. Foreground mouse actions and validated native-window background clicks preserve the modifier state; unsupported background paths report `background_unavailable`. |
| `actions` | — | Ordered batch of action objects (maximum 20); execution continues for classified consequential targets and reports the safety class. |
| `display` | primary | 1-based display index for `screenshot` / `switch_display`. |

## How it works

```
model ── computer tool ──> host (Node ESM bundle)
                              │  persistent PowerShell daemon, bounded one-shot fallback (JSON in / JSON out)
                              ├─> UIA accessibility tree (IUIAutomation)
                              ├─> Windows Graphics Capture → PrintWindow screenshots (occlusion-immune, no screen-DC tier)
                              ├─> background input: UIA patterns → pixel hit-test → WM_* messages
                              ├─> foreground input: SendInput
                              └─> overlay: UpdateLayeredWindow per-pixel-alpha layered window
```

The helper is a single self-contained `pc-pilot-helper.ps1` copied to `%TEMP%` once per host start; the overlay is `virtual-cursor-overlay.ps1` and the status pill is `pcpilot-statusbar.ps1` — resident low-frequency loops that read state files and blit per-pixel-alpha layered windows with `UpdateLayeredWindow`. Registration uses the harness tool API (`defineTool` + `ctx.tools.register`) with `isConcurrencySafe: false`, so desktop actions serialize.

## Security considerations

- The tool can read window titles, accessibility trees and screenshots, and can drive input into the user's applications. The bundled tool description instructs the model to operate **only** what the user explicitly asked for and to never submit forms, send messages, make purchases, delete data, or change account/settings without explicit instruction.
- Background actions never move the user's cursor or steal focus. Foreground actions do — the guidance requires the model to say so.
- No telemetry. The plugin performs no network access and no persistence beyond `%TEMP%\dsh-cua-*` state files.

## Troubleshooting

- **The cursor indicator does not appear** — check `%TEMP%\dsh-cua-diag.log` (boot diagnostics) and make sure the host was restarted after installation.
- **The indicator is visible but misplaced** — ensure the installed version calls `SetProcessDPIAware` (all ≥ 0.1.0 builds do); mismatched DPI awareness shifts the overlay by the scaling factor.
- **Desktop icons vanish / gray boxes appear** — this is a Windows shell (WorkerW) glitch typically caused by desktop-organizer or wallpaper tools, not by this plugin; restarting `explorer.exe` restores the desktop.
- **`background_unavailable`** — the target has no verified background path (canvas, some WinUI surfaces, unsupported native controls). Decide per task whether to go `foreground`; the helper refuses an unverified coordinate fallback.
- **`accessibility_status: unavailable`** — the HWND and screenshot are valid, but the application exposed no usable UI Automation descendants. Wait and observe again; if it remains unavailable, use a screenshot-bound foreground path only when the task permits it. Never invent an `element_index`.
- **`window_activation_unconfirmed`** — an explicitly foreground-launched app did not become the foreground window after the verified activation attempt. The launch may have succeeded, but foreground control did not; observe the returned window instead of assuming focus.
- **`screenshot_black`** — the target is DirectComposition/UWP without the WGC bridge, hardware-accelerated, or hung, so neither occlusion-immune tier could render it. Bring the window forward with `dispatch: "foreground"` (or `activate_window`) and retry.

## Development

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
pwsh -File scripts/smoke-test.ps1
# Rebuild the optional WGC bridge after changing native/wgc-capture:
dotnet publish native/wgc-capture/wgc-capture.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o lib/wgc
```

The smoke test exercises helper actions (`list_apps`, `get_window_state`, background clicks) against a real window. To run the plugin from a local checkout, link it into a DSH profile as shown above.

## License

[MIT](LICENSE)


Background browser mode, helper source modules and timing: [2026-09-10 implementation notes](docs/background-refactor.zh.md).
