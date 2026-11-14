# 豆包网页改版鲁棒性方案（dsh-doubao-paint）

> 结论先行：**不要试图「追上」豆包的 DOM，而是把「硬路径」降级为「软语义 + 可降级失败」**。一次投入约 4 个文件、300 行，把「页面一改整条链路报 contract_changed」变成「最多某一步降级、还能跑完，且失败时留下现场」。

## 1. 现状：哪里依赖 DOM，依赖到什么程度

驱动层能力不缺，缺的是「定位策略」与「失败取证」。所有页面脚本都是 `evaluate_script` 注入的 IIFE 字符串（`lib/doubao-page.js`），后端可执行任意 JS（Chrome：`lib/chrome-cli.js:450-468`；ego：`lib/ego-cli.js:310-316`），也能截图（`lib/chrome-cli.js:473-482`、`lib/ego-cli.js:324-331`）。

| 环节 | 依赖什么 | 脆弱度 | 现状 |
|---|---|---|---|
| 就绪等待 | `[data-testid=chat_input_input]` / `.ProseMirror` / 登录几点（`doubao-page.js:115`） | 中 | 只影响等待，超时即失败 |
| 登录判定 | 2 个 testid（`doubao-page.js:156-157`） | 中 | 未命中会误判「已登录」 |
| 契约体检 | shell = `workspaceChip` + `newConversation`（`contract.js:39-45`） | **高** | 任一缺失 → `orchestrator.js:302-311` 直接 fail-fast，后面都白跑 |
| 工作区 chip | `button[data-testid=workspace-switch-chip]` + 文本「豆包」（`doubao-page.js:222-233`） | 高 | 单点，改版即 `chip_not_found` |
| 新建会话 | `[data-testid=create_conversation_button]`（`doubao-page.js:239`） | 高 | 单点 |
| 技能按钮 | `skill_bar_button_3`（`doubao-page.js:254`） | **最高** | 序号化 testid，豆包加/删一个技能就漂移 |
| 输入框 | 4 级降级：textarea → 其内 ProseMirror → 可见 ProseMirror → 可见 textarea（`doubao-page.js:278-317`） | 低 | 全仓库唯一已做降级链的环节，可作为模板 |
| 发送 | 2 个 testid，再退到 Enter（`doubao-page.js:413-436`） | 低 | 有兜底 |
| 取图 | 只用 `img` + URL 正则 `rc_gen_image` / `wm0`（`doubao-page.js:441-453`、`contract.js:26-29`） | 低 | 不依赖结构，天然抗改版 |

三个真实的「结构性」问题（与具体选择器无关）：

1. **选择器两处副本**：`contract.js:14-23` 是权威表，但 probe 脚本内又硬编码了一遍字面量（`doubao-page.js:156-170`）。改一处漏一处，`G16`（`contract.js:4-8` 注释）只保证表与脚本字符串一致，不保证脚本内部同源。
2. **hard 集合过宽**：只有「能写进输入框、能按发送」是生图必需；workspace chip / 新建会话 / 技能按钮缺失时，旧会话照样能发图。把这三者设为 hard，等于用最易变的元素当生死线——历史两次事故之一（输入区 `ProseMirror` → `textarea + ProseMirror` 双形态）就是 hard 判定与实际能力脱节。
3. **失败无现场**：`contract_changed` 抛错处（`orchestrator.js:302-311`、`:397-404`、`:409-421`、`:423-431`）只带 `missingSelectors` 与计数（`contract.js:61`），不截图、不存 DOM；截图只发生在登录/无图/生成（`orchestrator.js:365`、`:485`、`:501`）。事后只能靠用户描述猜页面长什么样。

## 2. 候选手段评估（取舍）

| 手段 | 结论 | 依据 |
|---|---|---|
| ① 多候选选择器 + 语义降级 | **采用（作为第 2 层，不单独用）** | 单靠它只是把 12 条选择器变 40 条，仍是「猜 class/testid」；但作为「最快命中的第一段」成本最低 |
| ② 自愈式定位（失败后按 role/aria/文本/相对位置打分推断节点） | **采用（核心）** | 一次 `evaluate` 内就能完成「扫描 → 打分 → 返回节点」，不用改后端协议；ideally 只在①全空时启用，避免误命中 |
| ③ 用 a11y 树 / 原生可交互元素枚举替代 `querySelector` | **部分采用（仅 Chrome 后端，且只用于等待与取证）** | CLI 已内置 `take_snapshot`（a11y 文本树 + 每元素 uid）与 `wait_for(text)`（`…/chrome-devtools-mcp/build/src/tools/snapshot.js:10`、`:42`），插件从未调用；但 uid 点击仍要回 `evaluate`/`click`（跨后端不一致），且 ego 后端无快照 API（`ego-cli.js` 只有 `evaluate/screenshot/fetch`） |
| ④ probe 与动作分离、每步独立错误 | **采用（先做，收益最高）** | `orchestrator.js:295`/`:386` 已有 probe 雏形，只需把「hard/soft 分级」与「reason → 建议」补齐，不改架构 |
| ⑤ 用开放接口/稳定入口替代 DOM 驱动 | **不可行，明确不做** | 豆包网页版生图没有公开 API；插件的前提就是「复用已登录网页会话」。若将来有官方 API，接入点是 `lib/orchestrator.js` 的单一动作入口，不必现在预留抽象层 |
| ⑥ 失败自动 DOM 快照落 `.runs/` | **采用** | `runDir` 已存在（`orchestrator.js:282`），`finally` 已有收尾点（`:572-581`），增量最小、收益最直接 |

## 3. 唯一推荐方案：三层降级 + 一次验收

### Layer 0 — 契约分级（`lib/contract.js`）
把每个语义目标从「字符串数组」升级为 `{name, selectors[], semantic, required}`：

- `required: 'hard'`：仅 `inputEditor`、`sendButton`（生图必需）。
- `required: 'soft'`：`workspaceChip`、`newConversation`、`workMode`、`skillButton`、`loginButton/loginModal` 保留但缺失只告警；告警进结果字段 `degraded:[]`。
- `SHELL_SELECTORS`（`contract.js:39-45`）随之拆成 hard/soft 两组；`orchestrator.js:302-311` 的 fail-fast 改为「hard 缺失才抛，soft 缺失仅记录」。**这一改动单独就能消掉「chip 一改全挂」。**

### Layer 1 — 定位器链（新增 `lib/locator.js`，注入脚本共享）
页面内按三段降级，返回 `{via: 'contract'|'selector2'|'semantic', node, score, debug}`：

1. `contract.selectors`（原表，一字不改）；
2. 可见性 + 几何过滤（沿用 `doubao-page.js:278` 已验证的 `getBoundingClientRect` 判可见）；
3. 语义打分器：`semantic = {role?, ariaLabel?, text?[], near?: 选择器/关系, tag?}`。打分项包括 role/可编辑、aria-label 与文本包含、相对位置（如「`[role=dialog]` 内最后一个 button」）。打分器写成**注入源码字符串常量**（与 `COLLECT_IMAGES_FN` `doubao-page.js:19` 同风格），各 `build*Script` 复用同一份，单测可 `eval` 字符串直接验证。

**误命中风险由调用策略兜住**：语义层只在上两层全空时启用；命中记 `via=semantic`，命中次数进探针统计，便于一周后回收语义层里无效的启发式。

### Layer 2 — 步骤编排与错误语义（`lib/orchestrator.js` + `lib/doubao-page.js`）
- 每步返回统一 `{ok, via, reason, hints}`；`reason` 为枚举（新增 3 个错误码，`lib/errors.js:12-25`）：`locate_failed`、`edit_readback_mismatch`、`send_not_ready`。`errors.js:96` 的 `classifyError` 相应扩展。
- 硬编码重试次数（`orchestrator.js:386` 6 次、`:409` 3 次、`:423` 1 次）改为「等待 → 定位 → 动作」三态循环：等待按 500ms 轮询到总预算，定位仅在「节点失效」时重扫。重试必须留在 orchestrator（新会话会换执行上下文，见 `doubao-page.js:198` 注释），但每次重扫都走 Layer 1。
- 失败文案从「豆包页面结构与插件契约不一致」×4 处，改成「第 3 步（写入提示词）失败：输入框未找到 / 已找到但回读不一致」+ 建议（重试 / 开诊断）。落点 `orchestrator.js:302-311`、`:397-404`、`:409-421`、`:423-431`。

### Layer 3 — 失败取证（`orchestrator.js` `finally`）
任何非成功出口，在 `runDir`（`orchestrator.js:282`）写入：

- `dom-<step>.html`：`document.documentElement.outerHTML`（上限 2 MB）；
- `page-url.txt`、`contract.json`（现有 probe 计数）；
- 结果里只回 `{runDir, step, reason}`，不把 HTML 塞进工具输出。

30 行左右，挂在 `orchestrator.js:572-581` 现有 `finally` 之前。

### 验收：用「伪页面变体注入」证明鲁棒性
沿用现有 `vm`/stub 手法（`test/index.test.js` 的 G16 已在比对脚本字符串 ↔ 契约表）。新增 4 个变体：

| 变体 | 变更 | 期望 |
|---|---|---|
| A | 改掉 `skill_bar_button_3` 的 testid | 仍成功，`via=semantic` |
| B | 删除 workspace chip | 仍成功，`degraded=['workspaceChip']`（不抛 contract_changed） |
| C | 输入区退回纯 `textarea` | 成功，走 `doubao-page.js:278` 第 1/4 级 |
| D | 把输入框与发送按钮一起删掉 | `contract_changed` + `runDir` 内有 `dom-05-input.html` |

「鲁棒性提升」的可证伪定义就这一句：**A/B/C 从「整链失败」变成「成功或单步降级」，D 从「无信息失败」变成「带现场失败」。**

## 4. 落地顺序与收益（按性价比）

| 阶段 | 内容 | 工作量 | 立刻消除的失败面 |
|---|---|---|---|
| P1 | Layer 0 分级 + Layer 2 错误语义 | ~1 天 / 3 文件 | soft 目标缺失不再整链 fail-fast；用户能看懂「哪一步坏了」 |
| P2 | Layer 3 取证 | ~半天 / 1 文件 | 下次改版有 DOM 现场，定位时间从「猜」变「看」 |
| P3 | Layer 1 定位器链（先覆盖 4 个 soft 目标 + 发送/输入） | ~2-3 天 / 新增 1 文件 + 改 7 个 `build*Script` | 选择器全空时仍能跑（覆盖 5/7 单点脆弱环节） |
| P4（可选） | Chrome `take_snapshot`/`wait_for` 作为就绪信号与取证附录 | ~半天 / 1 文件 | 减少「等 DOM 稳定」造成的假超时 |

**不做**：a11y uid 作为主链路点击（跨后端不一致、多一次 RPC）；开放 API 兜底（无此接口）。

## 5. 改动量与风险

- 规模：`contract.js` +60 行（结构）；新增 `lib/locator.js` ~150 行；`doubao-page.js` 7 个脚本各换定位入口 +120 行；`orchestrator.js` +50 行（分级与取证）；`errors.js` +3 码；`test/index.test.js` +4 用例。
- 风险与缓解：
  - 语义打分器误命中（把「重试」当发送）→ 只在①②全空时启用；`via=semantic` 记入统计，可观察后收紧。
  - `G16` 契约测试要同步：`contract.js:4-8` 注释约定的「脚本字符串 ↔ 表」比对需扩展到「脚本内不得再出现字面量选择器」，否则两处副本问题会复发。
  - `health.js:72-76` 只暴露选择器计数，建议加「最近 20 次定位 via 分布」，让「鲁棒性」有可观测指标。