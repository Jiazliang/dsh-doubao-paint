# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.1] — 2026-11-07

### 修复

- **契约检测不再把正常页面判成改版**：探针只校验页面骨架（`workspaceChip` + `newConversation`），
  输入区在「开新对话之后」单独探测，且只要求 `inputEditor`（`sendButton` 只在有草稿时渲染）。
  首页引导态、已登录态都不再触发 `contract_changed`。
- **输入框写入失败自动重试**：豆包路由切换会重建 ProseMirror 节点，若写入落进已丢弃的执行上下文，
  `execCommand('insertText')` 返回成功但读回为空。现在最多重试 3 次（每次新上下文），并复查文本是否一致。

### 不变

- 三个入口、同一条通道、同一份 `PaintOutcome` 保持不变；命令图卡渲染逻辑未改。

## [Unreleased]

- 后续方向：豆包页面契约的自动巡检（定时探活 + 变更告警）、多账号/多标签并发配额、生成历史的面板筛选与检索。

## [1.1.0] — 2026-11-07

### 新增

- `lib/entry.js`：`submitPaintRequest(request, deps)` 成为**唯一入口**（工具 / 命令 / HTTP 路由共用），`normalizePaintRequest` 统一缺省（`maxImages=4`、`newConversation=true`），history 落盘只在 `succeeded` 时发生。
- `lib/render.js`：三个哑适配器——`renderToolResult` / `renderCommandResult` / 路由 `sendJson`；`encodeCommandPayload` 与 `decodeCommandPayload`（前缀 `doubao-paint:v1 `）承载机器可读尾行。
- `lib/commands.js`：人类命令 `/doubao-paint <画面描述> [--ratio] [--style] [--count] [--neg] [--dir] [--prefix] [--reuse]`，零模型回合；支持 `--flag value` 与 `--flag=value`、引号剥离、未知 flag 留在提示词、缺值报错。
- `lib/skill.js`：runtime 技能 `doubao-paint`（`modelInvocable` + `userInvocable`），教模型何时调工具、参数怎么写、结果怎么读。
- `lib/client.js`：注册 keyed slot `conversation.chat.commandview`（key = `doubao-paint`），把命令结果渲染成**图卡**（网格 + `figure/img` + `figcaption`），图源走 `/doubao-paint/file?id=`。
- `scripts/smoke.mjs`：新增 `unified entry`、`command + skill`、`adapter parity` 三项（共 13 项）。

### 变更

- `inject` 从 `['tools','attachments']` 扩为 `['tools','attachments','commands','skills']`。
- 工具与三条路由全部改调 `submitPaintRequest`；`apply` 内的 `syncHistory` 移除（收敛进入口）。
- 命令在 CLI / 远程终端只呈现文本（`GenericCommandCard`），在 Web UI 呈现图卡——同一份 outcome、不同渲染器。
- `PLUGIN_VERSION` 与 `package.json` 版本升至 `1.1.0`。

### 测试

- 新增 G21（三适配器同契约）、G22（命令解析与 handler）、G23（技能注册）、G24（命令图卡渲染，含失败态与 running 态）、G25（统一入口与 history 落盘条件）；`node --test test/index.test.js` **29/29**。

## [1.0.0] — 2026-11-07

### 新增

- `lib/errors.js`：`PAINT_ERROR_MESSAGES_EN`（12 个 code 全量英文文案）与 `errorMessage(code, lang)`——`en` 取英文、缺条目回落中文、未知语言中文、未知 code 归一 `unknown`。
- `lib/client.js`：面板文案表扩到 23 键（含 12 条 `err_<code>` 与 `genPartial`），新增 `currentLang(ctx)` / `t(ctx, key, vars)` / `errorText(ctx, code, fallback)`。
- `lib/ego-cli.js`：`EGO_CLI_EXTRA_ROOTS` 补 macOS/Linux/用户级安装目录，并在 `PATH` 逐目录兜底探测。
- `lib/chrome-cli.js`：非 Windows 分支遍历 npm 全局根（`npm_config_prefix`、`~/.npm-global`、`/usr/local`、`/opt/homebrew`、`~/.local/share/pnpm`、`/usr`）后回落 `~/.local/bin/chrome-devtools`。
- `scripts/smoke.mjs`：新增 `error messages i18n` 检查（共 10 项）。

### 变更

- 面板生成结果按状态分流：`succeeded` / `partial`（成功 N 张、失败 M 张，warn 级）/ `login_required` / 其他按 `code` 给原因；"Tabbit" 字样全部清除。
- 触发条无障碍：`role="button"`、`tabIndex=0`、`aria-label` 随展开态切换、`title`、Enter / Space 键盘激活、图标 `aria-hidden`。
- `PLUGIN_VERSION` 与 `package.json` 版本升至 `1.0.0`。

### 说明

- v1.0.0 的判据：P0 全清（v0.3.0）、P1 全清（v0.4.0 + 本版 i18n / `partial`）、P2 全清（跨平台探测 + a11y）、离线 24/24 与冒烟 10 项全绿、真机 ego 后端出图通过。

## [0.4.0] — 2026-11-07

### 新增

- `lib/history.js`：history 跨进程持久化到 `outputDir/.history.json`（原子写、`MAX_HISTORY = 30`、坏 JSON 容错），`apply` 时读回并与内存记录按 `filePath` / `filename` / `previewUrl` 去重合并（`mergeHistory`，内存优先）。
- `lib/history.js`：`.runs/<requestId>/` 保留策略 `pruneRunDirs` —— 保留最近 20 个请求目录，其中最近 5 个保留 png 截图，更早的整目录删除。
- `lib/health.js`：环境体检 `buildHealthReport` / `inspectOutputDir`；`doubao_image_status` 与 `GET /doubao-paint/status` 的返回新增 `health`（`ok` / `problems[]` / `cli` / `outputDir` / `contract` / `versions`），`problems` 带 `code` + 中文 `message` + `detail`，面板与 Agent 可直接转述「缺什么、下一步做什么」。
- `lib/constants.js`：`PLUGIN_VERSION`。

### 变更

- history 与 `.runs` 清理在 `apply` 时执行，生成成功后 `saveHistory`；持久化失败只影响「记住历史」，不影响出图。
- `inspectOutputDir` 在目标目录多级不存在时向上寻找最近的已存在祖先探写权限（与 `mkdir -p` 行为对齐）。

## [0.3.0] — 2026-11-07

### 新增

- `lib/errors.js`：12 个结构化状态码（`ok` / `login_required` / `no_image` / `partial` / `download_failed` / `busy` / `cancelled` / `cli_missing` / `backend_unavailable` / `contract_changed` / `rate_limited` / `unknown`）+ `PaintError` + `classifyError` + `withCode` / `failureResult`；所有工具返回值都带 `status` / `code` / `message` 三件套。
- `lib/contract.js`：豆包页面选择器契约（8 选择器 + 2 图片特征）成为单一真源，`buildProbeScript` 回报每个选择器命中数，缺失即 `contract_changed`。
- `scripts/smoke.mjs`（`npm run smoke`）与 `npm run verify`；`.github/workflows/ci.yml`（Ubuntu/Windows × Node 20/22，测试 + 冒烟 + 打包内容检查）。
- 并发单飞锁（`activeRun` / `getActiveRun()`）：第二次并发调用立即返回 `busy`，附 `activeRequestId` / `activeMode` / `activeSince`。

### 安全

- `/doubao-paint/status` 在 ego 与 chrome 都探不到时返回 **503 `backend_unavailable`**，不再假装健康。

### 变更

- `browserBackend` 公共默认由 `ego` 收敛为 **`auto`**（探到 ego 用 ego，否则回落 Chrome）；想固定 ego 的机器显式配置 `ego'`。
- 工具超时由硬编码 185000/65000 改为公式：`resolveToolTimeoutMs(config.timeoutMs)`（配置 + 30s，夹 60s…300s），状态工具取 `max(60s, 配置/2 + 20s)`；轮询预算改为 `timeoutMs × 0.85`。
- `package.json`：`engines.node >=20`、`engines.dsh >=0.2.0-0`，peerDependencies 由 `"*"` 收紧为 `>=…`，`files` 增 `scripts/smoke.mjs`。

### 修复

- 同秒重名覆盖：下载落盘改为 `writeFileAtomic`（`.tmp` + `rename`）+ `uniqueFilePath`（`_1-2.png` 递增），不再产生半截文件或静默覆盖。
- 单图下载无超时：新增 `DOWNLOAD_TIMEOUT_MS = 45s`，并与外部 `AbortSignal` 合并。

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