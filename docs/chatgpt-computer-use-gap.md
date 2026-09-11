# PC-Pilot 与 ChatGPT Computer Use 的当前差距

更新：2026-09-11。

PC-Pilot 的模型可见桌面接口已采用 ChatGPT Windows Computer Use 名称：`list_apps`、`list_windows`、`get_window`、`launch_app`、`get_window_state`、`click`、`press_key`、`type_text`、`scroll`、`drag`、`set_value`、`perform_secondary_action` 和 `activate_window`。返回的 `window: { id, app }` 可直接复用，元素操作使用 `element_index`。

这解决的是 agent 学习成本，不等于运行时已经与 ChatGPT 原生实现完全等价。下表记录实际差距，避免把接口一致误写成任务成功率一致。

| 维度 | PC-Pilot | ChatGPT Computer Use | 结论 |
| --- | --- | --- | --- |
| 桌面接口 | 同名动作和 `window` 对象可直接复用 | 原生 `sky` 运行时 | 已对齐 |
| 基础能力 | SendInput、UI Automation、Windows.Graphics.Capture / PrintWindow | 同样使用 SendInput、UI Automation、Windows.Graphics.Capture | 技术路线对齐 |
| 遮挡窗口 | WGC 优先，PrintWindow 兜底；失败返回 `screenshot_black` | 原生窗口捕获 | 接近；PC-Pilot 需覆盖更多实际窗口类型 |
| 后台操作 | 默认不抢焦点；没有可验证 UIA 路径即返回 `background_unavailable` | 原生运行时具备更成熟的输入与窗口处理 | PC-Pilot 更保守，复杂 Chromium/自绘控件成功率仍较低 |
| 元素可靠性 | 快照、窗口绑定、元素身份和 `expected_name` 校验；变更后强制重新观察 | 原生运行时的截图和 UIA 工作流 | PC-Pilot 的拒绝策略更显式，但也增加一次观察成本 |
| 浏览器 | AI 独立 profile 的 CDP 语义通道、tab/元素令牌、Shadow DOM、网络证据 | ChatGPT 的 Browser Use / 原生环境能力 | PC-Pilot 在自有 Chromium 会话上更可审计；不操作用户浏览器 |
| 失败恢复 | 超时、断连和已分发动作返回 `unknown`，绝不自动重放 | 原生产品有更成熟的端到端恢复 | PC-Pilot 的语义正确，仍需更多真实应用回归 |
| 性能 | PowerShell 守护进程；近期热调用约 420 ms | 原生进程内运行时 | PC-Pilot 延迟仍偏高 |
| 产品成熟度 | DSH 插件、单一 `computer` 工具和运行时 skill | 深度集成的 ChatGPT 产品能力 | 是当前最大差距：安装、诊断、可观测性和跨版本兼容仍需持续打磨 |

## 真实判断

PC-Pilot 适合浏览器中的结构化操作、常规 Win32 控件、需要不打断用户的后台任务，以及需要明确证据链的自动化。对于自绘画布、复杂 Chromium 控件、拖拽和高频多步桌面编辑，应预期它比 ChatGPT 原生 Computer Use 更慢、也更常返回可解释的拒绝。

下一阶段优先做三件事：收集真实应用回归样本；缩短 PowerShell/UIA 观察路径；为拒绝的自绘控件提供经过验证的前台路径，而不是放宽后台点击校验。
