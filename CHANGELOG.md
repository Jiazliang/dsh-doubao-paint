# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。只记对外可见的变化；实现细节看代码与 `README.md`。

## [1.4.0] — 2026-11-07

- 修复：面板画廊只渲染前 4 张却按总数显示徽标（`history.slice(0, 4)`）——现在按分组渲染该组全部图片，徽标与分组张数都取真实总数。
- 新增：面板历史按工作区分组。`history` 记录写入 `workspace`，`/doubao-paint/status` 与 `/generate` 返回 `groups`；当前工作区默认展开并置顶，其他工作区折叠；旧记录按 `filePath` 回填工作区，不再全部堆进「未标记工作区」。
- 变更：「✨ 插入对话让 Agent 生图」改为插入技能手势 `/doubao-paint <描述>（比例：…，风格：…）`，与手打手势同一条路径，不再生成「请调用工具」的提示词。
- 变更：面板改为与输入框卡片一致的圆角（`var(--dsw-radius-panel)` = 28px）和同宽对齐，不再窄一圈。
- 变更：去掉面板头部「🌐 唤醒豆包网页 / 检查登录」与状态条「🔑 重新唤起登录框」两个按钮；未登录只显示提示文案（由 `/generate` 的 `login_required` 触发），不再要求用户点专门按钮。
- 修复：面板状态条的 15 秒自动收回在无定时器环境（离线 vm 沙箱）下抛 `ReferenceError: setTimeout is not defined`，改为全程 `typeof` 守卫、按注入的 `timers` 取用。
- 工具：新增 `scripts/sync-profile.mjs`（`npm run sync:profile`），把工作区代码按 SHA256 同步进 `~/.dsh/profiles/desktop/node_modules/dsh-doubao-paint` 副本；宿主加载的是副本而非源码，改完要「同步 + 重启」两步才生效。

## [Unreleased]

- 后续方向：契约自动巡检（定时探活 + 变更告警）、多账号并发配额、面板历史筛选。

## [1.3.3] — 2026-11-07

- 卫生：删除命令面残留的死代码（`lib/render.js` 只留 `renderToolResult`；`lib/orchestrator.js` 删掉零引用的 `getActiveRun`）。
- 卫生：新增 `npm run lint`（`scripts/check.mjs`，无依赖：语法、JSON、发布面存在性、遗留标记、命令面不回潮）并纳入 `npm run verify`；补 `.editorconfig` 与 `.gitattributes`（统一 LF）。
- CI：修正首次上 GitHub 就红的流水线——`setup-node` 的 `cache: npm` 在无 lockfile 时会直接失败（本插件零运行时依赖），改为不缓存、不 install，并把 lint 并入矩阵。
- 测试：离线用例与开发机解耦。`status` 路由断言改为 200/503 二选一、ego 路径期望用 `path.join` 拼（Linux 上 posix 语义）、后端选择与会话工厂改为注入探测器/`egoCliPath` 桩，不再依赖本机装没装 ego lite。
- 文档：`README.md` 重写为「安装 / 用法 / 配置 / 状态码 / 架构 / 验收 / 限制」，删掉逐版本追加的实测流水；移除代码落地前的内部设计稿（`设计方案.md`、`复刻清单.md`、`handoff.md`、`ego-lite-兼容评估.md`），代码注释里对它们的引用一并清掉。

## [1.3.2] — 2026-11-07

- 修复：面板与工具读到的生图历史可能是旧快照（宿主内多个 apply 实例各持一份内存 `history`，只在 apply 时 hydrate 一次，新图进不了 `/doubao-paint/status`）。现在 `/status` 与 `doubao_image_status` 每次调用都先 `hydrateHistory()`。

## [1.3.1] — 2026-11-07

- 修复：技能注册缺 `source` / `provider` 字段，宿主加载器报 `loaded skill "doubao-paint" source must be a string` 并让整轮失败；已显式写 `source: 'runtime'`、`provider: 'doubao-paint'`。

## [1.3.0] — 2026-11-07

- 变更：`/doubao-paint <描述>` 改为 **runtime 技能手势**——宿主按 `SKILL_GESTURE` 注入 `skill_content`，模型先补全提示词再调 `doubao_generate_image`，与「直接说画什么」同一条路径。
- 移除：`lib/commands.js` 与全部命令设施（`/doubao-paint`、`/doubao-paint-direct`、命令图卡槽位 `conversation.chat.commandview`、relay 载荷与 `inputActions` 旁路），`inject` 收敛为 `['tools','attachments','skills']`。

## [1.2.1] — 2026-11-07

- 修复：命令转交在真机报「输入框未就绪」（命令卡片拿不到 `inputActions` prop）——改为会话级旁路缓存 + 写入方法按候选名探测（`setDraft|setText|…` / `submit|send|…`）+ 最多 5 次 400ms 重试，失败把原因和「重试」按钮显示在卡片上。

## [1.2.0] — 2026-11-07

- 新增：工具结果图卡——keyed slot `tool.call.toolview`（key = `doubao_generate_image`）渲染状态行 + 提示词 + 图片网格，其余细节折叠；生图结束派发 `dsh-doubao-paint:generated`，面板据此刷新 history（事件驱动，不轮询）。
- 变更：`renderToolResult` 只输出文字块（文件名、尺寸、路径、`previewUrl`），图片只由会话图卡与面板呈现。

## [1.1.1] — 2026-11-07

- 修复：契约检测把正常页面判成改版——骨架只要求 `workspaceChip` + `newConversation`，输入区在开新对话后单独探测且只要求 `inputEditor`。
- 修复：输入框写入假成功（路由切换会重建 ProseMirror）——最多重试 3 次并复查文本一致。

## [1.1.0] — 2026-11-07

- 新增：唯一入口 `lib/entry.js` 的 `submitPaintRequest`，工具 / 命令 / 路由共用一套 `PaintOutcome` 与哑适配器；runtime 技能 `doubao-paint`；`scripts/smoke.mjs`。
- 变更：工具与三条路由改调入口，`apply` 内的落盘逻辑收敛进入口。

## [1.0.0] — 2026-11-07

- 新增：12 个状态码的中英双语文案（`errorMessage(code, lang)`）；面板文案扩到 23 键（含 `partial` 语义化）；`ego-cli` / `chrome-cli` 补齐 macOS、Linux 与 PATH 兜底探测。
- 变更：触发条无障碍（`role` / `tabIndex` / `aria-label` / Enter·Space）；清除 "Tabbit" 残留文案。

## [0.4.0] — 2026-11-07

- 新增：`lib/history.js` 把 history 持久化到 `<outputDir>/.history.json`（原子写、30 条上限、坏 JSON 容错、按路径去重合并）；`.runs/<requestId>/` 保留策略（最近 20 个请求、其中 5 个留截图）。
- 新增：`lib/health.js` 环境体检（`ok` / `problems[]` / `cli` / `outputDir` / `contract` / `versions`），`/status` 与状态工具都返回 `health`。

## [0.3.0] — 2026-11-07

- 新增：12 个结构化状态码 + `PaintError` / `classifyError`；选择器契约单一真源 `lib/contract.js`；并发单飞锁（第二次调用立即 `busy`）；`scripts/smoke.mjs` + `npm run verify` + GitHub Actions（Ubuntu/Windows × Node 20/22）。
- 安全：`/doubao-paint/status` 在两个后端都探不到时返回 503 `backend_unavailable`。
- 修复：落盘改原子写 + 重名递增（`_1-2.png`），单图下载 45s 超时；`browserBackend` 公共默认收敛为 `auto`。

## [0.2.0] — 2026-11-07

- 新增：ego lite 后端（复用其已登录 Profile，零扫码；任务结束 `finish({keep:[]})` 释放空间）；`browserBackend: auto|ego|chrome` 与 `egoCliPath`；`/status` 返回后端探测结果。
- 安全：`/doubao-paint/file` 收口——只服务 history 记录或 `outputDir` 内图片，越界 403。
- 变更：命名空间 `doubao-image` → `doubao-paint`；面板入口移到输入框工具行（`conversation.input.left`），展开面板与 composer 卡片等宽。
- 修复：输入框写入前清空（修 `生成图片：请生成图片：…` 重复前缀）；Electron 宿主 `process.execPath` 陷阱（`resolveNodeExecutable`）；scoped ctx 未 inject 时属性访问抛错（`readService`）。
- 文档：README 加「参考与致谢」，新增 `LICENSE`（MIT）。

## [0.1.0] — 2026-11-07

- Stage 1 复刻完成：两个原生工具、四条 `/doubao-paint/*` 路由、面板与触发条、提示词装配、选图打分、下载落盘、附件注入与 history。
- Chrome 后端：经 `chrome-devtools-mcp` CLI 驱动有头持久 profile（daemon 归属判定、脚本信封解析、截图）。