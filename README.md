# dsh-pc-pilot

English | [中文](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-green)

A **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) host plugin** that gives the model a single `computer` tool to observe and operate the local Windows desktop: an indexed UIA accessibility tree, per-window screenshots, background synthetic-cursor input that never steals focus, and — when a task truly requires it — real SendInput mouse/keyboard control.

While acting, the model moves a small **on-screen cursor indicator** (a rounded arrow with a soft blue radial glow) to each target point, so a human can follow exactly what the AI is about to click or type. The cursor is click-through, never takes focus, and auto-hides three seconds after the last action.

## Features

- **One tool, full desktop (31 actions)** — baseline: `list_apps`, `get_app_state`, `click_element`, `click`, `set_value`, `type`, `key`, `scroll`, `drag`, `open_app`, `read_clipboard`, `write_clipboard`, `mouse_down`, `mouse_up`, `hold_key`, `list_displays`; parity additions: `mouse_move`, `perform_action`, `select_text`, `screenshot`, `zoom`, `switch_display`, `cursor_position`, `list_windows`, `wait`; workspace additions: `toggle_pip`, `isolate_window`, `setup_virtual_display`.
- **Background-first input** — actions run via UIA action patterns (Invoke / Toggle / Selection / ExpandCollapse / RangeValue / Transform), then pixel hit-testing, then `WM_CHAR` / `WM_KEY` / `WM_MOUSEWHEEL` messages. The target window is not brought forward and the user's real mouse/keyboard are never hijacked.
- **Occlusion-immune background clicks** — with an `app` specified, coordinate clicks aim at the target window's own UIA tree / hwnd, so a fully covered window can be operated unattended while the user keeps working on top.
- **Rich mouse vocabulary** — left / right / middle clicks, double-click (`click_count: 2`), triple-click (`click_count: 3`), and horizontal scrolling (`direction: "left" / "right"`).
- **O(1) element lookup** — `get_app_state` caches the UIA element list inside the persistent helper daemon, so `click_element` / `set_value` / `perform_action` / `select_text` (and `type` with an `element` target) resolve without a second full-tree traversal.
- **Resilient screenshots** — `PrintWindow` first, then a screen-DC `CopyFromScreen` fallback when the frame comes back blank (DirectComposition / UWP windows), so occluded windows still render their own content.
- **Per-task dispatch** — `dispatch: "foreground"` (real SendInput) exists for the cases that genuinely need it (canvas clicks, unsupported drags, apps with no background path); the tool guidance keeps background as the default and asks the model to be explicit when it goes foreground.
- **Virtual-cursor indicator** — per-pixel-alpha layered window (`UpdateLayeredWindow` + `CreateDIBSection`): rounded white arrow with black outline over a soft blue radial glow. Click-through (`WS_EX_TRANSPARENT`), non-activating (`WS_EX_NOACTIVATE` + `SW_SHOWNOACTIVATE`), always-on-top. Auto-hides 3 s after the last action and reappears on the next one.
- **High-DPI accurate** — the overlay calls `SetProcessDPIAware` at startup and positions itself in physical pixels, matching the physical coordinates the helper reports from UIA. Correct placement at 100% / 125% / 150% scaling.
- **PowerShell 5.1 + 7 (Core) compatible** — the overlay adds the `System.Private.Windows.GdiPlus` / `System.Private.Windows.Core` references under .NET Core so both runtimes render the cursor identically.
- **Virtual display canvas, invisible to the user** — AI windows are parked on a real virtual monitor (IddCx virtual display): the OS renders them, the user never sees them, and the Apple-style picture-in-picture overlay mirrors the canvas live — with the AI's virtual cursor (white arrow + blue focus ring) composited into the mirror, so every click point stays visible to you. The driver is installed and activated automatically at the first host boot (one UAC click is the consent gate); the setup is idempotent and, once ready, never touches display hardware again (no primary-screen flicker).

## Requirements

- Windows 10 or 11
- DeepSeek Harness (DSH) with the `dsh-pc-pilot` bundle loaded in the `web` profile
- PowerShell 5.1 (built into Windows) and Node.js ≥ 22.12 (shipped with DSH)

## Installation

### From the DSH plugin market

Once listed, search for *dsh-pc-pilot* in the market and click install.

### From a GitHub release

```powershell
npm install https://github.com/JeremyWangCY/dsh-pc-pilot/releases/download/v0.2.0/dsh-pc-pilot-0.2.0.tgz
```

Run this inside the DSH profile (`~/.dsh/profiles/web`), then restart the host.

### From source

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
npm install ./dsh-pc-pilot
```

Or link it manually: add `"dsh-pc-pilot": "link:./vendor/dsh-pc-pilot"` to the profile's `package.json` dependencies, add the bundle to `dsh.profile.bundles`, run `npm install`, and restart the host.

### Virtual display setup (built-in, automatic)

The virtual display is part of the plugin, not an add-on. After installation, the **first host boot finishes it automatically**:

1. About 4 seconds after boot, the plugin runs an idempotent setup check in the background;
2. If the driver is missing, it downloads the signed driver package (integrity double-verified by a pinned SHA256 and an Authenticode signature check; anything else aborts) and installs it silently — the single **UAC prompt** you approve is the only manual step;
3. It applies the extended-display topology and calibrates the virtual monitor to the lowest supported tier (falls back from 1280×720 to 1366×768 @ 60Hz) — larger UI elements keep the picture-in-picture mirror readable at a glance;
4. The result is written to `%TEMP%\dsh-cua-diag.log` (`virtual display ready: [status] ...`).

Windows occasionally reverts programmatic topology changes on indirect displays — if that happens, press `Win+P` once and pick **Extend**; it never needs to be done again.

Manual run / verification (same idempotent logic):

```powershell
npx dsh-pc-pilot       # or: npm run setup
```

The AI can do the same in-session:

```jsonc
computer { "action": "setup_virtual_display" }                       // install + activate
computer { "action": "setup_virtual_display", "setup": "status" }    // status only
```

To uninstall the driver (the next host boot reinstalls it automatically):

```powershell
pnputil /delete-driver oem138.inf /uninstall /force
```

## Usage

The plugin registers one global tool, `computer`. Typical flow:

1. `computer { action: "list_apps" }` — running apps with pids, window titles, hwnds and rects.
2. `computer { action: "get_app_state", app: "Notepad", screenshot: true }` — indexed accessibility tree (element index / role / name / value / automation_id / rect / invokable) plus a window screenshot.
3. Act on the state — `click_element { app, element }`, `set_value { app, element, value }`, `type { app, text }`, `key { app, key, modifiers }`, `scroll { app, x, y, amount, direction }`, `drag { app, from_x, from_y, to_x, to_y }`, `perform_action { app, element, perform }`, `select_text { app, element, start, length }`.
4. Refresh the state after every UI change; element indexes are only valid for the `get_app_state` that produced them.

### Action reference (31 actions)

| Action | Purpose |
| --- | --- |
| `list_apps` / `list_windows` / `list_displays` | Enumerate apps / per-app windows / display topology |
| `get_app_state` | Indexed UIA tree + per-window PNG screenshot + document text |
| `click` / `click_element` | Coordinate or element click (left / right / middle, `click_count` 1-3) |
| `set_value` / `type` / `perform_action` / `select_text` | Element-level write, text entry, named UIA pattern, text-range selection |
| `key` / `hold_key` | Key presses and keyboard chords (Control_L+a, ctrl+c, alt+f4, ctrl+shift+p) with timed holds |
| `scroll` | Vertical and horizontal scrolling (`direction: down / up / left / right`) |
| `mouse_move` / `mouse_down` / `mouse_up` | Raw mouse primitives |
| `drag` | Element move (background) or real SendInput drag (foreground) |
| `screenshot` / `zoom` | Full-display or region capture; crop the latest shot |
| `switch_display` / `cursor_position` | Default capture display; real cursor location |
| `open_app` / `wait` | Launch an app silently in the background (WindowStyle Minimized at the bottom, zero flicker or focus theft); pause between actions |
| `activate_window` / `close_window` / `get_window` | Bring window to foreground / graceful WM_CLOSE / query fresh window geometry & metadata |
| `read_clipboard` / `write_clipboard` | Clipboard round-trip |
| `toggle_pip` / `isolate_window` | Show/hide the PiP overlay; park or restore a window on the virtual display canvas |
| `setup_virtual_display` | One-command virtual display setup (`setup`: auto / status / install / activate) |

### Key parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| `dispatch` | `background` | UIA patterns + window messages; never steals focus. `foreground` uses real SendInput — pick it per task only when the user asked for real control or the essential action has no background path. |
| `overlay` | `true` | Show the click-through cursor at each action point; it auto-hides 3 s after the last action. |
| `screenshot` | `true` | Capture a per-window PNG in `get_app_state`. |
| `app` | — | pid number, process name, or window-title substring; `window_index` disambiguates multiple windows. |
| `x` / `y` | — | Window-local pixels (with `app`) or screen coordinates (without). |
| `button` / `click_count` | `left` / `1` | Mouse button and click repetitions for `click` (double = 2, triple = 3). |
| `display` | primary | 1-based display index for `screenshot` / `switch_display`. |

## How it works

```
model ── computer tool ──> host (Node ESM bundle)
                              │  spawns PowerShell 5.1 helper per action (JSON in / JSON out)
                              ├─> UIA accessibility tree (IUIAutomation)
                              ├─> PrintWindow / CopyFromScreen screenshots
                              ├─> background input: UIA patterns → pixel hit-test → WM_* messages
                              ├─> foreground input: SendInput
                              └─> overlay: UpdateLayeredWindow per-pixel-alpha layered window
```

The helper is a single self-contained `computer-use-helper.ps1` copied to `%TEMP%` once per host start; the overlay is `virtual-cursor-overlay.ps1`, a resident low-frequency loop that reads a state file and blits a 48×48 DIB with `UpdateLayeredWindow`. Registration uses the harness tool API (`defineTool` + `ctx.tools.register`) with `isConcurrencySafe: false`, so desktop actions serialize.

## Security considerations

- The tool can read window titles, accessibility trees and screenshots, and can drive input into the user's applications. The bundled tool description instructs the model to operate **only** what the user explicitly asked for and to never submit forms, send messages, make purchases, delete data, or change account/settings without explicit instruction.
- Background actions never move the user's cursor or steal focus. Foreground actions do — the guidance requires the model to say so.
- No telemetry. The plugin itself performs no network access; the virtual-display setup downloads exactly one driver package, verified against a pinned SHA256 and an Authenticode signature before install. No persistence beyond `%TEMP%\dsh-cua-*` state files.

## Troubleshooting

- **The cursor indicator does not appear** — check `%TEMP%\dsh-cua-diag.log` (boot diagnostics) and make sure the host was restarted after installation.
- **The indicator is visible but misplaced** — ensure the installed version calls `SetProcessDPIAware` (all ≥ 0.1.0 builds do); mismatched DPI awareness shifts the overlay by the scaling factor.
- **Desktop icons vanish / gray boxes appear** — this is a Windows shell (WorkerW) glitch typically caused by desktop-organizer or wallpaper tools, not by this plugin; restarting `explorer.exe` restores the desktop.
- **`background_unavailable`** — the target has no background path (canvas, some WinUI/Chromium surfaces). Decide per task whether to go `foreground`. With an `app` specified, element and coordinate clicks fall back to the target-window WM path (occlusion-immune) instead of failing.
- **Virtual display does not activate** — Windows may revert programmatic topology changes on indirect monitors. Press `Win+P` once and pick **Extend**, then re-run `npx dsh-pc-pilot` to verify. Without the driver the plugin automatically falls back to off-desktop parking.

## Development

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
pwsh -File scripts/smoke-test.ps1
```

The smoke test exercises helper actions (`list_apps`, `get_app_state`, background clicks) against a real window. To run the plugin from a local checkout, link it into a DSH profile as shown above.

## License

[MIT](LICENSE)


[MIT](LICENSE)
