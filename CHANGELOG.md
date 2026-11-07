# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划（v0.2 发布阻断项，见 README §9 与 `memory_log` 2026-11-07 的 P0 清单）

- `browserBackend` 公共默认收敛为 `auto`，探测不到就返回 `backend_unavailable`；
- 结构化错误码：`cli_missing` / `backend_unavailable` / `contract_changed` / `download_failed` / `busy` / `cancelled` / `rate_limited` / `no_image` / `partial`；
- 选择器契约漂移检测 + 契约快照测试；
- 落盘原子性（`tmp` + `rename`，同秒重名加 `requestId` 后缀）与 `.runs/` 保留策略；
- 并发互斥单飞锁、超时预算统一、`AbortSignal` 贯通；
- CI：`npm test` / `npm pack --dry-run` / 契约快照 / `node scripts/smoke.mjs --offline`。

## [0.2.0] — 2026-11-07

### 新增

- **ego lite 后端（默认）**：`lib/ego-cli.js`（`resolveDefaultEgoCliPath` / `buildEgoInvocation` / `runEgoScript` / `parseEgoPayload` / `createEgoSession`），复用用户已登录的 `Profile 1`，零扫码出图；实测 status 6.6s、generate 31.4s，落盘 `2848×1600`。
- `browserBackend: auto | ego | chrome` 与 `egoCliPath` 配置项（配置字段 11 项）；`lib/orchestrator.js` 的 `resolveBrowserBackend` / `createBrowserSession` 工厂 + `try/finally` 中 `finish({keep:[]})` 释放 ego 空间。
- `/doubao-paint/status` 返回 `backend` 与 `backends.{ego,chrome}` 探测结果。

### 安全

- `/doubao-paint/file` 收口：只服务 `history` 记录或 `outputDir` 内的图片（`resolveImageRequest` / `isInsideDirectory`），越界一律 403。

### 变更

- 命名空间 `doubao-image` → `doubao-paint`（配置 id、locale 命名空间、slot id `doubao-paint-studio-dock` / `doubao-paint-studio-chip`），避免与原插件在同一 profile 冲突。
- 面板入口从 `conversation.input.dock` 触发条改为 `conversation.input.left` 工具行胶囊按钮；展开面板仍在对话框上方，宽度对齐 composer 卡片（`--dsh-composer-card-max-width`）。
- 插入对话 / 引用路径改用宿主 `inputActions`（`captureInsertion` → `insertText` → 兜底 `setDraft` + `persistDraft`），不再依赖不存在的 `conversation` client 服务。
- 提示词前缀改为循环折叠（`collapseDrawPrefix`），并与风格/比例后缀幂等。

### 修复

- 页面输入框写入前置空（`buildInputScript` 先 `execCommand('delete')` 再插入，写后校验 `readText()===expected` 并自愈），修掉 `生成图片：请生成图片：…` 的重复前缀。
- Electron 宿主 `process.execPath` 指向 `DeepSeek Harness.exe` 导致 CLI 无法执行：新增 `resolveNodeExecutable()`（`DSH_NODE_EXEC_PATH` → PATH → 平台常见路径）。
- scoped ctx 未 inject 时属性访问抛错：新增 `readService(ctx,name)`，`inject` 补 `attachments`。

### 文档

- README 新增 §9「参考与致谢（Credits）」：标注上游插件 `xt765/dsh-doubao-image`、继承范围、重写范围与许可说明；新增 `LICENSE`（MIT）。

## [0.1.0] — 2026-11-07

### 新增

- Stage 1 复刻完成：两个原生工具（`doubao_generate_image` / `doubao_image_status`）、四条 `/doubao-paint/*` Web 路由、`conversation.input.dock` 下的面板与触发条、提示词装配、选图打分、下载落盘、附件注入与 `history`。
- Chrome 后端：`lib/chrome-cli.js` 经 `chrome-devtools-mcp` CLI 驱动有头持久 profile（daemon 归属判定、`evaluate_script` 信封解析、`take_screenshot`）。
- 离线测试 G1–G11（假 ctx / 假 DOM / 假浏览器）+ 真机端到端出图验收。