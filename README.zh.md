# dsh-pc-pilot

[English](./README.md) | 中文

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-green)
[![npm](https://img.shields.io/npm/v/dsh-pc-pilot.svg)](https://www.npmjs.com/package/dsh-pc-pilot)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-host%20plugin-blueviolet)

## 运行边界

**PC-Pilot 只面向同一交互式 Windows 会话：用户正常工作，AI 尽量走不抢焦点的后台路径。** 浏览器优先 CDP；桌面优先 UIA、目标窗口消息、WGC / PrintWindow。虚拟机、第二桌面或隐藏的另一套 Windows 会话不属于 PC-Pilot 的架构。某个应用如果确实依赖真实前台 SendInput，就应准确返回后台不支持，而不是假装能保证用户与 AI 的键鼠完全独立。

优化优先级：**浏览器批量/局部观察 → UIA 缓存与能力路由 → WGC 会话复用 → 条件批处理 → 高频软件专用适配。** 截图能力和后台输入能力分别验证：能稳定抓到窗口画面，不代表这个应用也能可靠接收后台输入。

**PC-Pilot（`dsh-pc-pilot`）** 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）宿主插件，让 AI 模型通过单一 `computer` 工具观察并操作本地 Windows 桌面。

它把三件事整合进一个工具：

1. **看**：索引化的 UIA 无障碍树 + 逐窗口 PNG 截图——模型"读"到的是结构化元素列表（index / role / name / value / automation_id / rect / invokable），而不是靠视觉猜坐标；
2. **动**：默认走**后台合成输入**（UIA 动作模式 → 像素命中测试 → 窗口消息），全程不抢焦点、不动你的真实鼠标键盘；
3. **看得见**：每个动作执行前，屏幕上会出现一个**虚拟光标指示器**（圆润白色箭头 + 柔和蓝色径向光晕）移动到目标点，屏幕上方中央同时显示**毛玻璃状态条**（"PC-Pilot 运行中" + 右侧绿色呼吸灯点）——点击穿透、绝不取焦点，让人能实时看清 AI 正在做什么。

插件同时注册模型可调用的 **`pc-pilot` 技能**。它不是网站流程脚本：无上下文 agent 在处理多步骤桌面或网页任务前加载该技能，即会获得与工具一致的目标选择、观察后操作、状态刷新、单次副作用确认及原地恢复规则。

需要真键鼠的场景（画布点击、不支持的拖拽等）可按任务切换 `dispatch: "foreground"`（真实 SendInput）。

## 特性总览

| 特性 | 说明 |
| --- | --- |
| 单工具全桌面加浏览器 | 桌面动作直接采用 Windows Computer Use 标准名称：`list_apps` / `list_windows` / `get_window` / `launch_app` / `get_window_state` / `click` / `press_key` / `type_text` / `scroll` / `drag` / `set_value` / `perform_secondary_action` / `activate_window` |
| 轻量条件批处理 | 支持最多 20 个有序 `actions`；每一步可用 `when` 做执行前门控、用 `expect` 做执行后验证，首个条件不满足/失败/不确定步骤立即停止。`when` 默认只检查当前状态一次（`timeout_ms: 0`），不满足时绝不派发动作；不提供分支 DSL，也不会隐藏重试 |
| 结构化安全分类 | 检测到明显的提交、发布、购买、删除、认证或敏感浏览器字段时标记 `safety.class=consequential`；当前 pc-pilot 不拦截执行，后续可由宿主接入确认策略 |
| 后台优先输入 | 三级回退通道：UIA 动作模式 → 像素命中测试 → `WM_CHAR` / `WM_KEY` / `WM_MOUSEWHEEL` 消息；不把目标窗口带回前台，不占用真实键鼠 |
| 观察快照绑定 | `get_window_state` 返回 `snapshot_id`；元素动作必须携带同一快照，快照过期、窗口移动、元素身份变化或动作消费后都会拒绝；未经验证的后台坐标点击不会回退到可能错误的控件 |
| 持久浏览器会话 | 每个 AI 隔离浏览器 endpoint 复用一条有界 CDP WebSocket，并复用每个 tab 的 CDP session，不再每个动作重连；`browser_tabs`、`browser_history`、`browser_back` / `browser_forward`、条件式 `browser_wait` 提供会话级导航；`browser_events` 用游标返回新的 console/network/lifecycle 证据，`browser_downloads` 跟踪下载进度与已落盘文件。截图使用独立的非致命超时，慢截图不会误杀健康浏览器会话；`browser_state` 为兼容性保留原始 token 与紧凑 `@eN` ref，`browser_observe` 则默认只返回短 ref、不把 UUID 噪声送进 Agent 上下文；两者都严格绑定 tab/document/name/role，click / type / replace / key 两种形式都可使用，且绝不附着用户自己的浏览器 |
| UIA 稳定身份与增量状态 | `include_text: true` 时每个控件增加稳定 `element_id`，并返回单调递增的 `accessibility_revision` 与 `accessibility_delta`（新增/删除/变化/未变化计数）。原有 `element_index + snapshot_id` 动作契约不变；stable id 只帮助跨观察推理，不绕过快照过期检查 |
| 动作后验证与确定性恢复 | 动作可携带 `expect`，验证窗口存在/关闭、UIA 是否变化、stable element value、桌面文本、浏览器 URL/文本/ready、下载完成等结果；未满足时返回 `postcondition_failed`，不会盲目重放。可选 `recovery: "foreground_once"` 仅在明确 `not_executed + background_unavailable` 时尝试一次；元素恢复必须提供 `element_id`，先重新观察并映射新 index/snapshot，再执行 foreground |
| 稳定应用身份与精确定位 | `list_apps` / `list_windows` / `get_window` 返回 `app_identity`：Win32 使用完整 exe path，packaged app 使用 AUMID，并带 parent pid 与同进程家族 root pid。后续优先复用 `identity_key` 精确锁定应用；`get_app_identity` 按需补充 product/version/company，并可验证 Authenticode publisher/subject/thumbprint，结果按 executable 缓存 |
| 有界失败语义 | one-shot helper 有外部 watchdog；超时、断连或已派发后的传输错误返回 `outcome: "unknown"`，变更型动作不会自动重放 |
| 遮挡免疫后台点击 | 指定 `app` 时，坐标点击瞄准目标窗口自身的 UIA 树 / hwnd——窗口被完全遮挡也能无人值守操作，用户可继续在前台工作 |
| 标准动作词汇 | 同时接受常见 computer-use `double_click` / `type` / `keypress.keys` / `move` 与 Windows canonical `click` / `type_text` / `press_key` / `mouse_move`；支持 `scroll_x/scroll_y`、`drag.path`、三击和窗口级后台操作 |
| O(1) 元素拾取 | `get_window_state` 在常驻 helper 守护进程内缓存 UIA 元素列表，`click { element_index }` / `set_value` / `perform_secondary_action` / `select_text` / `type_text` 直接 O(1) 命中，不再二次整树遍历 |
| 真实应用就绪诊断 | 请求 `include_text: true` 时，`accessibility.status` / `accessibility_status` 区分 `available`、`partial` 与 `unavailable`；现代 WinUI/UWP 应用尚未暴露 UIA 树时，明确提示等待重观察或在授权时改走截图绑定的前台路径，绝不虚构元素索引 |
| 遮挡免疫截图链 | 优先使用随包的 Windows Graphics Capture 按 HWND 抓取目标内容，并为每个 HWND 复用有界的 `GraphicsCaptureItem + FramePool + CaptureSession` 捕获槽；尺寸变化只重建 frame pool，窗口关闭、捕获异常或长时间空闲时回收该槽。失败时降级 `PrintWindow` 多旗标阶梯——两级都要求窗口自己渲染帧，遮挡物永远进不了截图；**刻意不提供屏幕 DC 降级**。没有 .NET 8 时仍可用 `PrintWindow` 路径 |
| 按任务判断 dispatch | `foreground`（真实 SendInput）作为逃生舱口；工具指引要求模型保持 background 默认、切换时明确说明、不静默循环重试 |
| 虚拟光标指示器 | `UpdateLayeredWindow` + `CreateDIBSection` 逐像素透明分层窗口：黑描边圆润白箭头 + 柔和蓝色径向光晕；`WS_EX_TRANSPARENT` 点击穿透、`WS_EX_NOACTIVATE` + `SW_SHOWNOACTIVATE` 永不抢焦点、置顶显示 |
| 3 秒自动隐藏 | 最后一个动作 3 秒后光标自动消失（即 AI 本轮输出结束光标随之关闭），下一个动作再出现 |
| 高 DPI 精确落点 | overlay 启动即调 `SetProcessDPIAware`，以物理像素定位，与 UIA 上报的物理坐标一致；100% / 125% / 150% 缩放下均准确 |
| 双运行时兼容 | helper 恒以 PowerShell 5.1 运行（系统内置）；PowerShell 7 (Core) 下 overlay 渲染自动补齐 `System.Private.Windows.GdiPlus` / `System.Private.Windows.Core` 引用，两个运行时渲染一致 |
| 毛玻璃状态条 | 动作执行期间屏幕上方中央显示深色毛玻璃圆角胶囊"PC-Pilot 运行中"，右侧绿色呼吸灯点（正弦 1.8s 呼吸）；与虚拟光标同一套 `UpdateLayeredWindow` + `CreateDIBSection` 逐像素透明分层窗口技术：`TOPMOST` + `NOACTIVATE` + 点击穿透，活动停止 4 秒后自动隐藏 |

## 环境要求

- **操作系统**：Windows 10 或 Windows 11
- **宿主**：DeepSeek Harness（DSH），`web` profile 中加载 `dsh-pc-pilot` bundle
- **运行时**：Node.js ≥ 22.12（DSH 自带）与 PowerShell 5.1（Windows 系统内置）或 PowerShell 7+（Core，可选）
- **WGC 桥接（可选）**：.NET 8 Desktop/Runtime；存在时可按 HWND 获取不受遮挡影响的原生窗口截图，没有时自动使用 `PrintWindow` 遮挡免疫路径

## 安装

已发布到 [npm](https://www.npmjs.com/package/dsh-pc-pilot)，npm 随 Node.js 一起提供。

### 方式一：DSH 插件市场（推荐）

收录后，在 DSH 市场中搜索 **dsh-pc-pilot**（或 PC-Pilot），一键安装并按提示重启宿主。

### 方式二：从 npm 安装

在 DSH profile 目录（`~/.dsh/profiles/web`）内执行：

```powershell
npm install dsh-pc-pilot
```

确认 profile 的 `package.json` 中 `dsh.profile.bundles` 数组包含 `"dsh-pc-pilot"`（市场安装会自动加入；手动安装需自行添加），然后重启 DSH 宿主。

### 方式三：从源码安装

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
npm install ./dsh-pc-pilot
```

或者手动 link 调试：把仓库放到 profile 的 `vendor/` 下，在 profile `package.json` 的依赖中写 `"dsh-pc-pilot": "link:./vendor/dsh-pc-pilot"`，`dsh.profile.bundles` 中加入 `"dsh-pc-pilot"`，`npm install` 后重启宿主。

### CLI 与 Runtime API

PC-Pilot 同时提供轻量独立 runtime。CLI 刻意保持“薄”：不维护 action 白名单、不替 Agent 编排固定工作流，也不会把不确定的写操作自动重试。

```powershell
npm install -g dsh-pc-pilot
pc-pilot status
pc-pilot doctor
pc-pilot list_apps --json
'{"action":"list_apps"}' | pc-pilot request --stdin --json
```

`act` / 直接 action 模式只是方便层；`request` 是给 Agent 的开放入口，会把完整 computer request（包括批量 `actions` 和未来新增字段）原样交给与 DSH `computer` 工具相同的 core。

```js
import { createPcPilotRuntime } from 'dsh-pc-pilot/runtime'

const pc = createPcPilotRuntime()
const apps = await pc.act('list_apps')
const batch = await pc.run({ actions: [{ action: 'wait', seconds: 1 }] })

// 只是可选便利层：绑定可复用 target，不创建隐藏 session。
const launched = await pc.act('launch_app', { name: 'msedge.exe', headless: true })
const opened = await pc.act('browser_open', { browser: launched.browser, url: 'https://example.com' })
const page = pc.bind({ browser: opened.browser })
const observed = await page.act('browser_observe')
await page.act('browser_click', { browser_element: observed.elements[0].ref })

pc.close()
```

Runtime 原样返回 core 的 outcome。尤其是 `outcome: "unknown"`，它代表 Agent 应先检查当前状态，而不是由 CLI 擅自重放动作。`runtime.bind(defaults)` 只是浅层请求便利层：单次调用字段优先，嵌套 `window` / `browser` target 会合并，不创建 session daemon，也不会背着 Agent 增加 lifecycle、页面选择、观察、导航或重试。

Browser 后端同样只是一个可注入的轻量 provider，而不是第二套策略层。默认 provider 继续使用当前 persistent CDP session；其他后端只需实现 `execute(action, args, signal)`。这样以后可以接 BrowserSkill-compatible backend，但不会强迫所有 Agent 遵循同一套固定工作流。

### 状态条与光标指示器

overlay 默认开启（`overlay: true`）。每个动作序列的第一次活动会让 helper 拉起两个常驻低频 PowerShell 循环（`virtual-cursor-overlay.ps1` 与 `pcpilot-statusbar.ps1`），它们轮询 `%TEMP%\dsh-cua` 下的状态文件：

- **状态条**：活动保持新鲜（≤ 4 秒）时显示在主屏上方中央，之后淡出；空闲 120 秒自动退出，下次动作按需重启。
- **无驱动、无 UAC、无显示器改动**：PC-Pilot 完全在用户的真实桌面上后台运行。

### 验证安装

宿主启动日志（或 `%TEMP%\dsh-cua-diag.log` 诊断文件）出现：

```
[pc-pilot] computer tool registered globally (persistent profile plugin; helper at ...)
```

即表示 `computer` 工具注册成功。

## 使用

### 典型工作流

```jsonc
// 1. 看看有哪些应用
computer { "action": "list_apps" }

// 2. 读取目标窗口的截图；需要元素索引时显式请求 UIA 文本
computer { "action": "get_window_state", "window": { "id": 12345, "app": "notepad" }, "include_screenshot": true, "include_text": true }

// 3. 依据状态执行动作；浏览器结果会返回可原样复用的 browser: { endpoint, tab_id } target
computer { "action": "click", "window": { "id": 12345, "app": "notepad" }, "element_index": 7, "snapshot_id": "<上一步返回的 id>" }
computer { "action": "type_text", "window": { "id": 12345, "app": "notepad" }, "text": "Hello, PC-Pilot!" }

// 4. 只有状态 stale/unknown、目标变化或下一步缺少信息时再观察；桌面元素 index 仍只对产生它的那次 get_window_state 有效
```

### 动作参考（57 个动作）

| 动作 | 用途 | 关键参数 |
| --- | --- | --- |
| `list_apps` / `list_windows` / `list_displays` | 列出运行中的应用及精确身份 / 单应用多窗口 / 显示器拓扑 | 无 / `app`? / 无 |
| `get_app_identity` | 把进程/窗口解析为稳定 Win32 exe path 或 packaged AUMID 身份；按需补充 product/version/company，并可验证 Authenticode signer | `app`?、`hwnd`?、`verify_signature`? |
| `get_window_state` | 默认截图优先；`include_text: true` 时构建带稳定 `element_id`、revision/delta 的索引化无障碍树并附带 `document_text` | `window`、`include_screenshot`、`include_text` |
| `click` | 标准坐标、左/右/中键、`wheel`（中键）、扩展 `back` / `forward` 键与多击，或绑定快照的 UIA 元素点击 | `window`、`x`、`y`、`mouse_button`、`click_count`；元素动作还需 `element_index`、`snapshot_id` |
| `set_value` | 直接替换元素文本值（UIA ValuePattern）；读回值不一致时返回 `value_verification_failed`，要求重新观察 | `window`、`element_index`、`snapshot_id`、`value` |
| `type_text` | 向已验证焦点输入文本 | `window`、`text` |
| `perform_secondary_action` | 对元素执行命名 UIA 动作（invoke / toggle / select / expand / collapse / focus / scroll_*） | `window`、`element_index`、`snapshot_id`、`secondary_action` |
| `select_text` | 选中元素文本范围（TextPattern）；`length: 0` 仅定位光标 | `app`、`element`、`start`、`length` |
| `press_key` / `hold_key` | 标准 keysym 风格组合键与定时按住；Windows/Meta/Command 键会被拒绝 | `window`、`key`、`duration_ms` |
| `scroll` | 标准滚动增量（同时给出横纵轴时两者均会执行；指定窗口时横向滚动先走其自身 UIA 树），或旧式滚轮刻度 | `x`、`y`、`scroll_x`、`scroll_y`，或 `amount`、`direction` |
| `mouse_down` / `mouse_up` | 原始鼠标原语 | `x`、`y`、`button`；无法安全后台投递时返回 `background_unavailable` |
| `drag` | 标准有序路径，或旧式端点；前台真实 SendInput 逐段拖动，后台 UIA 移动返回端点模式 | `path`，或 `from_x`、`from_y`、`to_x`、`to_y` |
| `screenshot` / `zoom` | 整屏或区域截图 / 裁剪最近一张截图 | `display`?、`x`、`y`、`width`、`height`、`path`? |
| `switch_display` / `cursor_position` | 设置默认截图显示器 / 读取真实光标位置 | `display` / 无 |
| `launch_app` / `wait` | 默认在不激活、不抢焦点的前提下把新窗口放到当前工作窗口后层，并保持正常可渲染状态，便于 WGC/UIA 持续后台操作；只有用户明确要求带到前台时才传 `activate: true`。支持 `ms-settings:display` 等已注册 Windows 激活协议。经代理启动时仅在能安全识别唯一新窗口后返回可直接复用的 `window`；带窗口时可用 `wait_for: "accessibility_present"` 等待任意 UIA 元素，或用 `accessibility_available` 等待完整树，超时返回可重试的明确状态 / 动作间等待 | `app` / `activate`? / `duration_s` / `wait_for` |
| `activate_window` / `close_window` / `get_window` | 显式前台激活窗口 / 优雅关闭窗口 (WM_CLOSE) 并核验窗口确实消失，否则返回 `window_close_unconfirmed` / 实时获取窗口最新几何与状态元数据 | `app`?、`hwnd`?、`window_index`? |
| `read_clipboard` / `write_clipboard` | 剪贴板读写 | 无 / `text` |
| `browser_tabs` / `browser_state` / `browser_observe` / `browser_history` / `browser_back` / `browser_forward` / `browser_wait` | 精确管理标签页；`browser_observe` 返回只含短 ref 的紧凑语义状态，`browser_state` 为兼容性保留原始 token；支持历史前进后退并等待 ready/URL 变化/指定文本 | `browser_endpoint`、`tab_id`?、`include_url`?、`browser_wait_for`? |
| `browser_events` / `browser_downloads` | 按 `event_cursor` 增量读取 console/network/lifecycle 证据；跟踪 Chromium 下载进度和已落盘文件 | `browser_endpoint`、`tab_id`?、`event_cursor`? |
| `browser_shutdown` | 仅关闭同一 PC-Pilot 实例启动的整浏览器 | `browser_endpoint` |
| `browser_click` / `browser_type` / `browser_replace` / `browser_key` | 操作最新 state/observe 返回的原始 token 或紧凑 `@eN` ref；目标过期或身份变化时拒绝 | 优先复用 `browser: { endpoint, tab_id }`，或兼容使用 `browser_endpoint`、`tab_id`；`browser_element` |
| `browser_click_point` | 仅在绑定 `browser_state` / `browser_observe { with_screenshot: true }` 返回的精确 `screenshot_id` 时点击浏览器 viewport 坐标；tab/document/URL 变化或截图过期就拒绝 | `browser`、`screenshot_id`、`x`、`y` |
| `browser_upload` | 把 1–20 个明确的绝对本地文件路径选择到已观察到的 `<input type=file>`，并验证浏览器确实收到；不会替 Agent 提交外围表单 | `browser`、`browser_element`、`files` |

#### 动作前后条件

`when` 与 `expect` 复用同一套轻量条件词汇：`window_exists`、`window_closed`、`accessibility_changed`、`element_value`、`text_present`、`browser_url`、`browser_text`、`browser_ready` 与 `download_completed`。

- `when` 在动作派发前检查；默认 `timeout_ms: 0`，即只看当前状态一次。条件不满足时返回 `precondition_not_met + not_executed`，动作不会发生。
- `expect` 在动作后验证，例如 `{ "type": "element_value", "element_id": "...", "value": "done" }` 或 `{ "type": "browser_text", "text": "完成" }`。验证失败返回 `postcondition_failed`，不会自动重复可能已经发生的变更。

`recovery: "foreground_once"` 只处理一种确定情况：后台动作明确返回 `not_executed + background_unavailable`。如果是 element action，还必须同时传入观察时返回的 stable `element_id`，PC-Pilot 会先重新观察目标窗口、找回新的 `element_index + snapshot_id`，再做一次前台路径。任何 `unknown` 结果都不会自动重放。

> `list_apps` 返回的应用与窗口目标可直接复用；发现目标后优先保留 `identity_key`，packaged app 使用 `aumid:<AUMID>`，Win32 使用 `win32:<完整 exe path>`，比进程名/标题更适合后续精确续接。`app` 仍可用 pid 数字、进程名或窗口标题子串。桌面元素动作必须携带同一次 `get_window_state { include_text: true }` 返回的 `snapshot_id`。

批量调用适合**短、可预测**序列，例如：`computer { "actions": [{ "action": "browser_click", "browser_element": "@e3", "expect": { "type": "browser_text", "text": "已保存" } }, { "action": "browser_key", "key": "Escape", "when": { "type": "browser_text", "text": "已保存" } }] }`。前一步没有被验证，后一步就不会执行。它用于减少明显的模型往返，不是脚本分支系统；每个步骤仍返回在 `steps` 中，整批完成后只保留必要的最终观察。

### dispatch：后台与前台

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `background`（默认） | UIA 动作模式 → 像素命中测试 → `WM_CHAR`/`WM_KEY`/`WM_MOUSEWHEEL`；不抢焦点、不动真实键鼠 | 绝大多数 UI 自动化 |
| `foreground` | 真实 SendInput：移动真实光标、真实点击、把窗口带向前台 | 画布/游戏类点击、无后台路径的 WinUI/Chromium 表面、真实拖拽 |

工具指引会要求模型：保持 background 默认；仅当用户明确要求真实键鼠、或任务必需的动作确实没有后台路径时才切 foreground，并且**明确告知用户**、一次做完受影响步骤、不静默循环重试。当后台路径不可用时，helper 返回 `background_unavailable: true` 及解释信息。

### overlay：虚拟光标指示器

- **渲染**：48×48 逐像素透明 DIB，`UpdateLayeredWindow` 直绘——柔和蓝色径向光晕（`PathGradientBrush`，中心 alpha 130 渐变到 0，无硬边）叠加圆角白色箭头（`LineJoin.Round`）与黑色描边。
- **行为**：每个动作前移动到目标点；`SW_HIDE` 隐藏 / `SW_SHOWNOACTIVATE` 显示；最后一个动作 **3 秒后自动隐藏**（AI 本轮输出结束即消失），期间点击穿透、不夺焦点、不影响真实键鼠。
- **DPI**：进程启动即 `SetProcessDPIAware`，窗口坐标即物理像素，与 helper 写入状态文件的 UIA 物理坐标一致——125% 缩放下也精确落点。
- **开关**：单次动作传 `overlay: false` 可隐藏。

## 工作原理

```
模型 ── computer 工具 ──> DSH 宿主进程（Node ESM bundle，lib/index.js）
                            │
                            │ 每个动作 spawn 一次 PowerShell 5.1 helper
                            │ （JSON 从 argv 进，JSON 从 stdout 出）
                            ▼
                    lib/pc-pilot-helper.ps1
                            │
                            ├─> UIA 无障碍树（IUIAutomation COM）
                            ├─> Windows Graphics Capture → PrintWindow 截图（遮挡免疫，无屏幕 DC 层）
                            ├─> 后台输入：UIA 模式 → 像素命中 → WM_* 消息
                            ├─> 前台输入：SendInput
                            └─> 写光标与状态条状态文件（%TEMP%\dsh-cua\cursor.state / status.state）
                                        │
                                        ▼
                    lib/virtual-cursor-overlay.ps1 + lib/pcpilot-statusbar.ps1（常驻低频循环）
                            │  SetProcessDPIAware → CreateDIBSection
                            │  光标：光晕+箭头；状态条：毛玻璃胶囊+绿色呼吸点
                            │  UpdateLayeredWindow 定位显示
```

- **helper**：单文件自包含 PowerShell 脚本，宿主启动时从包内复制到 `%TEMP%\pc-pilot-helper.ps1`；默认使用持久 JSONL 守护进程降低延迟，one-shot 路径带 watchdog 作为隔离回退。
- **overlay**：`virtual-cursor-overlay.ps1` 常驻循环（100ms 轮询状态文件），内嵌 C#（`Add-Type`）实现分层窗口；`isConcurrencySafe: false` 使桌面动作在宿主侧串行执行。
- **注册**：`defineTool`（`@deepseek-ai/dsh-tools`，DSH 官方运行时包）+ `ctx.tools.register`，带三级加载回退与文件级启动诊断（`%TEMP%\dsh-cua-diag.log`）。

## 安全与隐私

- **能力边界**：该工具可读取窗口标题、无障碍树与截图，并可向用户应用注入输入。内置工具指引明确要求模型**只操作用户 explicitly 要求**的应用与窗口，未经明确指示**绝不**提交表单、发送消息、下单购买、删除数据或更改账号/设置。
- **最小干扰**：后台动作绝不移动真实光标、绝不抢焦点；foreground 动作会——指引要求模型必须先说明再做。
- **最小网络、无遥测**：插件运行时不发起任何网络请求；除 `%TEMP%\dsh-cua-*` 状态与诊断文件外不做任何持久化。
- **开源可审计**：控制逻辑在 `lib/`，WGC 桥接源代码在 `native/wgc-capture/`，欢迎审阅。

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| `computer` 工具不存在 | 确认 profile `dsh.profile.bundles` 含 `dsh-pc-pilot` 且宿主已重启；查看 `%TEMP%\dsh-cua-diag.log` 的启动诊断（模块加载 / apply / 注册三步各有记录） |
| 光标指示器不出现 | 同上查诊断日志；确认没有第二个旧版 overlay 进程残留（可在任务管理器搜 powershell） |
| 光标可见但位置偏移 | 安装版本必须调用 `SetProcessDPIAware`（≥ 0.1.0 均有）；DPI 感知不匹配会使位置按缩放系数偏移（如 125% 下偏 25%） |
| 桌面图标消失 / 出现灰色方块 | Windows shell（WorkerW）故障，通常由桌面整理或壁纸类工具触发，**与本插件无关**（本插件从不触碰 Progman/WorkerW）；重启 `explorer.exe` 即可恢复 |
| 返回 `background_unavailable` | 目标没有经过验证的后台路径（画布、部分 WinUI 表面、不支持的原生控件）。按任务判断是否切 `foreground`；helper 不会执行未经验证的坐标回退 |
| 返回 `foreground_activation_unconfirmed` | 明确要求前台操作的应用在经过激活后仍未成为前台窗口。此时不会发送真实输入；若返回 `launch_succeeded: true`，不能重试启动，应观察已返回的 `window` |
| 截图黑屏/空白 | 截图链只有遮挡免疫两级：WGC 按 HWND 捕获，失败再走 `PrintWindow` 旗标阶梯（2→0→3）。DirectComposition/UWP 无 WGC、硬件加速或挂起时两级都无法渲染，返回 `screenshot_black` 错误——此时用 `dispatch: "foreground"`（或 `activate_window`）把窗口带到前台再试 |

## 开发

```text
lib/index.js                    宿主端：工具注册（defineTool + ctx.tools.register）、helper 调度
lib/pc-pilot-helper.ps1     单文件 helper：UIA / 截图 / 输入 / 光标与状态条通知
lib/virtual-cursor-overlay.ps1  常驻 overlay：内嵌 C# 分层窗口渲染
lib/pcpilot-statusbar.ps1       常驻状态条：毛玻璃胶囊 + 绿色呼吸灯点
scripts/smoke-test.ps1          冒烟测试：对真实窗口执行 list_apps / get_window_state / 后台点击
docs/plugin-entry.yml           awesome-dsh-plugin 目录收录条目
```

```powershell
git clone https://github.com/JeremyWangCY/dsh-pc-pilot.git
cd dsh-pc-pilot
pwsh -File scripts/smoke-test.ps1
# 修改 native/wgc-capture 后重建可选的 WGC 桥接：
dotnet publish native/wgc-capture/wgc-capture.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o lib/wgc
```

本地调试：把仓库复制（或 link）到 profile 的 `vendor/` 下，按上文"从源码安装"配置后重启宿主。

## 许可证

[MIT](LICENSE)


Background browser mode, helper source modules and timing: [2026-09-10 implementation notes](docs/background-refactor.zh.md).
