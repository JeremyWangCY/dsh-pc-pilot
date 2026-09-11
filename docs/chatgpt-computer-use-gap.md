# PC-Pilot and OpenAI computer use

> Updated 2026-09-10: interface compatibility is not evidence of task-level parity. See [background refactor and validation limits](background-refactor.zh.md). The Bili end-to-end acceptance remains incomplete.

This comparison uses the current official OpenAI computer-use action contract as the compatibility baseline. OpenAI documents these model-facing actions: `click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, and `screenshot`.

Reference: [Computer use](https://developers.openai.com/api/docs/guides/tools-computer-use) and [integration recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration).

## Current interface

The DSH host exposes one model tool named `computer`. Its action enum now puts the standard action names first. The adapter accepts the standard shapes and normalizes them to the existing Windows helper:

| Model action | PC-Pilot adapter | Result |
| --- | --- | --- |
| `click` | `click` | Supported, with PC-Pilot target validation and background delivery where possible |
| `double_click` | `click_count: 2` | Supported through the canonical alias |
| `move` | `mouse_move` | Supported through the canonical alias |
| `scroll` with `scroll_x/scroll_y` | `amount/direction` | Supported with conservative wheel-notch conversion |
| `drag` with `path` | `from_*` and `to_*` plus validated array or `{x,y}` point paths | Supported end-to-end in foreground `SendInput`; background UIA remains endpoint based |
| `keypress` with `keys` | `key` chord | Supported through the canonical alias |
| `type`, `wait`, `screenshot` | Existing actions | Supported |

The older DSH names remain accepted for compatibility. `computer` remains the tool name because it is the model-facing host capability; `pc-pilot` is the plugin and loader identity.

## Gap assessment

| Area | PC-Pilot today | OpenAI computer use baseline | Gap and priority |
| --- | --- | --- | --- |
| Tool vocabulary | One `computer` tool with standard names plus DSH extensions | One `computer` tool with the standard action set | Naming gap is implemented; extensions are useful for native Windows work |
| Action batching | Ordered `actions` array, maximum 20, per-step results, abort propagation, stop-on-failure/unknown | An ordered `actions` array can contain several actions in one computer call | Implemented, with validation limits for the DSH adapter; nested batches are rejected |
| Observation loop | Canonical actions automatically receive a fresh native screenshot/state observation; a batch returns one final observation; browser mutations receive CDP capture | The runtime returns a fresh screenshot after a computer call | Implemented, with validation limits at the contract level; capture backend remains platform dependent |
| Screenshot source | Bundled Windows Graphics Capture bridge for HWND capture; PrintWindow and screen-DC fallback; CDP `Page.captureScreenshot` for owned browser tabs; explicit method/error metadata | The integration expects a current screenshot and preserves original resolution | **Implemented, with validation limits**: WGC is preferred for native windows and the existing fallbacks remain available when .NET 8/WGC cannot run |
| Coordinates | Supports global screen coordinates and app-local window coordinates; every screenshot includes an explicit viewport and screen origin | Coordinates are interpreted in the environment coordinate space shown to the model | Implemented, with validation limits for the supported screen/window coordinate spaces |
| Mouse modifiers | `keys` is normalized and held for foreground click/move/scroll/drag; validated native-window clicks also work in background | `keys` can accompany mouse actions and is held for that action | Implemented, with validation limits where Windows has a safe delivery path; background UIA scroll/move reports `background_unavailable` |
| Drag path | Validated numeric path; foreground follows every segment; background TransformPattern reports endpoint mode | The handler follows the ordered path points | Implemented, with validation limits for foreground input; native background controls cannot expose a physical path |
| Targeting | UIA snapshots, snapshot IDs, target names, window binding, stale identity refusal | Screenshot coordinates plus application-defined execution rules | Semantic targeting is available, but comparative accuracy has not been measured; Chromium UIA remains unreliable |
| Browser control | Explicit loopback CDP endpoint, isolated AI-owned profile, tab IDs, semantic tokens, stale-token checks, and post-mutation PNG | Browser or desktop runtime is supplied by the integrator; standard actions operate on the supplied environment | Implemented, with validation limits for the owned Chromium route; browser remains an extension because it is not the user's default browser |
| State persistence | Persistent PowerShell daemon and persistent isolated browser profile | The application must preserve the same environment between calls | Comparable; keep the daemon single-flight and no-replay guarantees |
| Cancellation and bounds | Per-action budgets, abort handling, circuit breaker, no replay after dispatch | The integration guidance requires step/time/cost limits and cancellation | Comparable; add a run-level step budget for parity |
| Outcome verification | Automatic post-action observation plus explicit `outcome` (`completed`, `not_executed`, or `unknown`) | The application executes actions and returns the updated screenshot; verification remains part of the loop | Implemented, with validation limits at the adapter boundary; visual postcondition checking remains model-driven |
| Safety metadata | Advisory classification only; plugin confirmation gates removed at the user’s request | Host policy is separate from plugin behavior | No confirmation-parity claim |
| Tool output protocol | DSH result JSON with per-step results, safety metadata, post-action observation, viewport/screenshot metadata, and optional image attachment | `computer_call_output` carries the matching call ID and screenshot | Implemented, with validation limits for this host contract; DSH correlation remains the host's responsibility |

## Priority order

The remaining implementation work is:

1. Add visual postcondition assertions only where an app exposes a stable semantic state; keep them outside the input dispatcher.
2. Improve semantic targeting and verification without introducing plugin confirmation gates.
3. Add a run-level budget when DSH exposes a stable per-call or per-task correlation context.

The adapter implements a control-loop interface. Actual reliability, background isolation, task completion time, and Chromium coverage still require end-to-end measurement.
