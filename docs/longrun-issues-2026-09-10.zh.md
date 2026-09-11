# PC-Pilot 长测问题清单（待一并修复）

- 日期：2026-09-10
- 触发：按 `docs/real-world-acceptance.zh.md` 流程做真实长测 + 历史复评/短测
- 代码状态：未改插件（工作区仍为 0.2.0 增量：browser_open/close/replace、expected_url、headless）
- 原则：真实链路优先，不用本地夹具代替主验收；B 站发布在**无正文证据时停止**（符合验收规范）

## 证据目录

- 真实 B 站 run：`artifacts/acceptance/longrun-real-20260910-113500/`
  - `logs/runner.log` / `logs/followup.log`
  - `screenshots/desktop_state.png`（标题为「出错啦! - bilibili.com」）
  - `result.json` / `followup.json`
- 另有本地短测 run：`longrun-20260910-112012`（夹具/静态，仅作对照，**不作为主验收通过依据**）

## 真实长测结论（主）

### 走通

| 步骤 | 结果 |
| --- | --- |
| `open_app` 独立 `--user-data-dir` + `url=BV1dK411H7xq` | 成功，返回 pid/hwnd/`browser_endpoint` |
| `list_windows` / `activate_window` / `get_app_state`（**显式 hwnd**） | 成功；Edge chrome UIA ~67 元素 |
| 全屏 `screenshot` | 成功 |
| `close_window`（显式 hwnd） | 成功 |
| `browser_state` 列 tab | 能列出 bilibili 与 `edge://welcome-new-device` |

### 阻塞（验收无法完成）

| ID | 级别 | 现象 | 影响 |
| --- | --- | --- | --- |
| REAL-01 | P0 | 干净 AI profile 打开 B 站视频页标题为 **「出错啦! - bilibili.com」**，语义树 **0 可控件** | 无法取得作者/字幕/评论框/发布按钮，主验收 8 阶段在「打开目标」后卡死 |
| REAL-02 | P0 | `browser_state(tab)` 在错误页上多次 **CDP command timeout（3s）**；部分快照 `url:""` 或 `url:":"` | 语义浏览器通道对错误页/慢页不可用，失败语义粗糙 |
| REAL-03 | P0 | 仅传 `app:pid`（open 返回的 pid）在 Edge 上 **ambiguous_window** | activate/typing/close 全部失败，直到手工 `list_windows` 选 title 非空 hwnd |
| REAL-04 | P1 | 无正文证据 → **未发布/未点赞/未删除**（规范允许） | 主验收本轮判 **未完成**，不是工具写评论能力单点问题 |
| REAL-05 | P1 | `release_window all:true` 曾报告 **Released all canvas windows … (98 window(s) moved)** | 回收范围过大，可能动到无关窗口；本轮 followup 改为只 close 本轮 hwnd |
| REAL-06 | P2 | 新 profile 出现 `edge://welcome-new-device` | 新配置噪音 tab，干扰 tab 识别 |

复现：

```text
open_app { name: "<edge> --user-data-dir=<tmp>", url: "https://www.bilibili.com/video/BV1dK411H7xq/" }
→ window title: 出错啦! - bilibili.com
→ browser_state { tab_id: <bili> } → n=0 或 CDP timeout
→ get_app_state { app: <pid> } → ambiguous_window
```

说明：错误页更像 **站点风控/无登录态/新 profile**，不一定是渲染 bug；但插件对「已打开失败页」缺少可操作观察与恢复引导，验收流程在工具层就断了。

---

## 历史问题合并（短测 + 复评 + 包装层）

### P0

| ID | 标题 | 详情 |
| --- | --- | --- |
| SEC-01 | 危险动作只分类不拦截 | `requires_confirmation: false`；submit/delete/login 等仅打标 |
| SEC-02 | `browser_replace` 未进敏感分类 | 可整段替换 password/token 输入框却不进 `sensitiveTransmission` |
| SEC-03 | `browser_state` 回传 URL/title | 默认 headless profile 脏页会带出 ntp query、sync 对话框等 |
| DESK-04 | `type` 可能 `dispatched` 假成功 | Win11 Notepad：WM_CHAR 报成功但正文/UIA 未见文本（需后置观察强制门禁） |
| REAL-01/02/03 | 见上 | 真实 B 站验收阻塞 |

### P1

| ID | 标题 | 详情 |
| --- | --- | --- |
| PKG-01 | `npm test` / `build-helper --check` 断裂 | 缺 `native/helper/bootstrap.ps1`，安装物只有拼好的 `pc-pilot-helper.ps1` |
| PKG-02 | `smoke-test.ps1` 在 PS5.1 必挂 | UTF-8 无 BOM + 中文注释，解析后 `$helper` 赋值被吃掉 → no JSON |
| PKG-03 | smoke 用 `explorer` 无 hwnd | 多窗口机 `ambiguous_window`；pwsh7 list_apps 过、get_app_state 挂 |
| DESK-03 | Notepad 刚启动 UIA 过浅 | 常先仅 2 Pane，稍后才 ~26；`set_value` 无 ValuePattern |
| DESK-05 | Win11 记事本后台写入不稳 | 依赖 activate 时机；默认 Minimized+隔离画布加重 |
| BR-02 | 默认 headless profile 不干净 | `%LOCALAPPDATA%\pc-pilot\headless-profile` 跨 run 残留 tab |
| BR-04 | `browser_open` 拒 `file://` | 仅 http(s)；本地调试需自起 HTTP（可接受但要写进文档） |
| BR-07 | `browser_replace` 对部分页面校验失败 | `replacement_verification_failed` 需与 contenteditable/受控输入分支对齐 |
| REAL-05 | `release_window all` 过宽 | 实测移动 98 个窗口 |

### P2

| ID | 标题 |
| --- | --- |
| UX-01 | 工具描述仍写 browser 路由 “does not start a browser process”，与 headless `open_app` 矛盾 |
| UX-02 | `setup` schema 已改 enum，描述需与文档/市场文案再对齐 |
| PKG-04 | helper 单文件 ~3.8k 行，回归成本高 |
| REAL-06 | 新 profile welcome tab |

---

## 按 acceptance 矩阵的映射（本轮实测）

| 编号 | 场景 | 本轮结果 |
| --- | --- | --- |
| B01–B02 | 动态评论区/遮挡发布 | **未覆盖**（B 站错误页，无评论区） |
| B03–B04 | 窗口移动/过期 snapshot | 短测：错误 snapshot 应拒绝；Edge 必须显式 hwnd |
| B05 | 多窗口同标题 | Edge 多 hwnd，**必须 hwnd/window_index** |
| B06 | 中文输入/替换 | Notepad/browser_replace 短测有假成功与校验问题；B 站未到位 |
| B08 | CDP/helper 超时 | 实测 **CDP 3s timeout**，outcome=not_executed |
| B09 | 后台不抢焦点 | open 默认 Minimized；activate 显式可控 |
| B10 | 证据不足不发布 | **本轮遵守**，记未完成 |
| B12 | 出口回收 | 只 close 本轮窗口可用；`all:true` 过宽 |

主验收判定：**未完成（环境/站点阻塞 + 工具观察不足）**，不是「评论质量」问题。

---

## 建议修复优先级（你之后一起改）

1. **目标解析**：`app:pid` 在多窗口时强制要求 hwnd，或自动选非空 title 主窗口并返回 `chosen_hwnd`（修 REAL-03 / smoke）。
2. **失败页观察**：错误页/慢页 CDP 超时要可配置；`url:""`/`":"` 规范化；返回 `page_status`（标题可见「出错啦」）而不是 0 元素假 pass。
3. **type 后置门禁**：`dispatched` 且未验证时标 `needs_observation`/`unverified`，禁止上层当成功（DESK-04）。
4. **safetyFor**：纳入 `browser_replace` / `browser_open`；仍可先只分类，但字段要完整（SEC-02）。
5. **headless profile**：默认每次临时 dir，或启动前清 session；`browser_state` 列表默认可不吐 URL/title（SEC-03）。
6. **包装层**：smoke 改 ASCII/带 BOM；`app` 换成可唯一 hwnd；补回或去掉 `build-helper --check` 依赖（PKG-01/02/03）。
7. **回收**：`release_window all` 改为只释放本轮 `open_app` 登记的窗口（REAL-05）。
8. **B 站主验收**：需可登录的 AI profile 或用户预登录；否则把「站点错误页」记为环境阻塞，不要假写评论。

---

## 未做 / 不做

- 未在真实 B 站发布、点赞、删除（无正文证据 + 避免污染第三方评论区）
- 未改 `dsh-pc-pilot` 任何代码（遵守「我的插件做完之前不要改」）
- 未把本地夹具结果算作 acceptance 通过
- 文件管理器/表格/下载对话框/画布拖拽等「浏览器之外」真实任务：**未覆盖**（Edge 主链路已阻塞）

---

## 验收状态更新

`real-world-acceptance.zh.md` 文首状态仍可保留「测试设计」；本文件补充：

> 2026-09-10 首次真实链路尝试：isolated Edge + BV1dK411H7xq → 站点「出错啦!」页，语义 0 元素，CDP 超时，主验收未完成。修复项见本文件清单。

---

## 修复记录（2026-09-10，按上述优先级逐项处理）

代码改动：`lib/browser-session.js`、`lib/index.js`、`native/helper/{observation,workspace,dispatch,capture}.ps1`、`scripts/smoke-test.ps1`、README 中英文；helper bundle 已重建并通过全部 `npm test`（含真实 Edge headless 会话测试）。

| ID | 状态 | 修复方式 |
| --- | --- | --- |
| REAL-01 | 环境阻塞（不改代码） | 站点风控/无登录态问题，属「需可登录的 AI profile」；插件侧已通过 REAL-02 让错误页可观察 |
| REAL-02 | **已修** | `browser-session.js`：CDP 命令超时可配置（`command_timeout_ms`，2–30s，默认 12s）；frame `url:""`/`":"` 规范化（回退 targetInfo URL，仍不可读则 `unknown`）；`browser_state` 快照返回 `page_status`（`page_error`/`no_interactive_elements`/`unreadable`），错误页不再表现为 0 元素假成功 |
| REAL-03 | **已修** | `observation.ps1` Resolve-TargetWindow：仅**同标题**多窗口才抛 `ambiguous_window`（B05 场景保持要求 hwnd/window_index）；标题不同的多窗口自动选定最优（非空 title + 可见 + 面积）并在结果返回 `chosen_hwnd`/`chosen_title`/`chosen_candidates` 与 message 注记。实测 pid+11 窗口自动解析 |
| REAL-04 | 规范内停止（不改代码） | 无正文证据不发布，符合验收规范 |
| REAL-05 | **已修** | `workspace.ps1` Release-AllCanvasWindows：只处理仍存活且当前确实位于虚拟画布上的已登记窗口；无画布时空操作；释放失败保留登记，陈旧登记直接清除。不再出现 98 窗口级联搬移 |
| REAL-06 | **已修** | `dispatch.ps1` headless 启动后用 DevTools HTTP 端点（`/json/list` + `/json/close/<id>`）关闭 `edge://welcome*`/`chrome://welcome*` 噪音标签页 |
| SEC-01 | 分类字段完整（设计如此） | 维持「只分类不拦截」并保证字段完整：`class`/`requires_confirmation: false`/`reason` 均有值，宿主可后续接入确认策略 |
| SEC-02 | **已修** | `safetyFor`：`browser_replace` 无条件分类为 consequential（整字段替换）；`browser_open`/`open_app{url}` 分类并补上缺失的 `reason` |
| SEC-03 | **已修** | `browser_state` 无 tab_id 时默认只返回 tab_id（脱敏，避免脏 profile 泄露 ntp query/sync 对话框）；`include_url: true` 才返回 url/title |
| DESK-03 | **已缓解** | `capture.ps1` Do-AppState：元素数 ≤2 时延迟 250ms 重扫一次（Notepad 启动期浅树） |
| DESK-04 | 已缓解（前次 + 本轮补强） | helper 收尾已统一 `needs_observation = 未 verified`；本轮补上 `set_value` ValuePattern 回读验证（verified/dispatched 区分），`type` 后置观察门禁维持 |
| DESK-05 | 部分（依赖观察门禁兜底） | 后台写入受 activate 时机影响，本质难点未除；未验证输入不再报成功（DESK-04 门禁 + browser_replace 校验）兜底诚实性 |
| BR-02 | **已修**（前次 + 本轮补强） | headless profile 已是每次启动的临时目录；本轮补 TEMP 内 >24h 且无进程占用的 `pc-pilot-headless-*` 目录清理 |
| BR-04 | **文档化** | `browser_open`/`open_app{url}` 仅接受 HTTP(S)、拒绝 `file://` 已写入 README 中英文与工具描述 |
| BR-07 | **已修** | `browser_replace` 校验覆盖 value/textContent/innerText 分支，替换后派发 `input`/`change` 事件（受控输入提交）；校验失败返回 `replacement_verification_failed` + `needs_observation: true` 并引导 browser_state 观察 |
| PKG-01 | **核对通过** | 工作区源码完整，`npm run build:helper --check` 通过；打包态（无 native/helper）时 `--check` 以 skip+exit 0 通过，`npm test` 不断裂 |
| PKG-02 | **已修** | smoke-test.ps1 已 ASCII-only；本轮实测又暴露 PS5.1 原生参数吞双引号问题 → payload 改走 stdin（`-PayloadStdin` + 管道），PS5.1 实测通过 |
| PKG-03 | **已修** | smoke 已改为从 list_apps 取非空 title 窗口的显式 hwnd（实测通过）；配合 REAL-03 的 chosen_hwnd 双保险 |
| PKG-04 | 不做（本轮） | helper 拆分为 `native/helper/*.ps1` 六模块后构建合并，单文件回归成本问题维持现状 |
| UX-01 | **已修** | 工具描述：明确 `open_app { headless: true }` 会启动 AI 独立浏览器进程；`browser_*` 路由仅强调「不附着用户浏览器」 |
| UX-02 | 已对齐 | `setup` enum（auto/status/install/activate）描述与 README/市场文案一致 |

复验建议：B 站主验收仍需可登录的 AI profile 或用户预登录；本地复验已覆盖 helper 全测试 + smoke（PS5.1）+ 真实 Edge headless 会话 + 多窗口 chosen_hwnd 实测。

## 续跑收尾（2026-09-10，状态条版本）

- helper 重建、PS_PARSE_OK 和全量 npm test 通过，含新增状态条测试。
- 状态条的 PS5.1 中文编码问题已修复：C# 使用 Unicode 转义；错误不再静默；样图模式不写运行进程 PID。
- 原生动作触发显示、空闲隐藏、观察期间前台不变均通过。当前是透明渐变视觉，未实现系统背景模糊，CDP 分支状态提示尚未统一。
- 旧测试依赖被最小化的应用自动恢复，现改为显式准备自有窗口；无 UIA 模式时验证正确拒绝，不把消息发送成功当作任务成功。
- 本机 MikeTheTech oem138.inf 驱动及安装程序已卸载，保留 GameViewer 与物理显卡。
- 交接九张正文截图无效；原视频标签已关闭；新建无窗口浏览器访问目标 BV 返回站点错误页。未发送评论或点赞。
- 详细证据：artifacts/acceptance/resume-20260910-statusbar/report.md。上述历史条目的旧接口不是当前可用接口。
