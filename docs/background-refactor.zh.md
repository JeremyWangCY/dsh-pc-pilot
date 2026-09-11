# 后台控制修订（2026-09-10）

## 使用路径

浏览器纯后台任务用 `open_app { name: "msedge.exe", headless: true }`，得到 `browser_endpoint` 后调用 `browser_open { browser_endpoint, url }`，使用返回的精确 `tab_id` 调用 `browser_state`。核对 URL 后，在后续操作中传入 `expected_url`。打开动作返回不等于页面加载完成。

无窗口模式每次启动使用独立临时 profile，不继承用户浏览器的登录态。CDP 页面截图用于观察它。虚拟显示功能及旧预览窗口已删除；2026-09-10 已卸载本机对应的 MikeTheTech 驱动及安装程序，保留其他软件的显示设备。

修改草稿用 `browser_replace`；它选择全部文本、输入并验证最终值，验证失败返回 unknown，不能直接重试提交。`browser_close` 仅关闭指定 tab。后台观察不自动恢复最小化窗口。后台截图仅使用 WGC 和 PrintWindow，失败即返回错误，不改抓桌面遮挡物。

原生输入活动显示顶部状态胶囊，四秒没有活动则隐藏。状态条不接收点击，不激活窗口。当前为透明渐变绘制，不应把它描述成系统级背景模糊。无窗口浏览器动作的状态条提示尚未接入。

## 耗时记录

`npm run session -- <日志绝对路径>` 启动单个持久工具实例，从 stdin 接收逐行 JSON。输出限制为摘要，完整结果写入 JSONL。日志包含每次调用耗时、调用之间的间隔、整个会话 wall_ms；不能把调用耗时之和当作完整测试耗时。日志可能包含页面内容，应按本地测试资料保存。

工具结果自身增加 timing，包括起止时间和 elapsed_ms。会话中保持同一个 Node 进程，避免每步重新启动 helper 和丢失元素 token。

## helper 维护

源码位于 native/helper，分为 bootstrap、observation、background-input、capture、dispatch 五个模块。修改源码后运行 `npm run build:helper`，生成 lib/pc-pilot-helper.ps1。部署仍用单文件，测试检查源码和生成文件一致。拆分提高维护性，本身不代表启动性能提升。

## 验证边界

本轮浏览器回归使用独立无窗口 Edge、本地页面、1200 个隐藏控件、Shadow DOM 编辑框，检查替换、提交、点赞、元素失效、URL 拒绝、精确开关 tab 和超时。它不会发布真实评论。页面观察支持主文档及开放 Shadow DOM，不覆盖跨源 iframe、关闭的 Shadow DOM 或完整浏览器无障碍语义。

仍需真实验收：B 站登录态、完整相关评论流程、五分钟总耗时，以及用户同时操作主屏时的长期隔离。原生 UIA 大树扫描仍有耗时，不能据此宣称达到 ChatGPT 内置 computer use 的整体水平。
