# dsh-doubao-paint

> 用你已登录的本机 Chrome，经 Google 官方 `chrome-devtools-mcp`，驱动豆包网页版生图。
> 免 API Key、不依赖第三方浏览器、插件包仍在百 KB 级。

**本项目是 [`xt765/dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image) 的功能复刻与重构版本**，非官方分支，与原作者无隶属关系。功能设计、工具契约与业务逻辑来源见 [参考与致谢](#9-参考与致谢credits)。

**状态：v0.3.0 — 离线验收 21/21 全绿、`npm run smoke` 通过、CI 矩阵（Ubuntu/Windows × Node 20/22）就绪、已装进 desktop profile 并在 GUI 内真实出图跑通（DoD 五条全部达成）。** 浏览器后端默认 `browserBackend=auto`：探测到本机 ego lite 就走 ego，否则回落 Chrome（见 §6.6）。`node --test test/index.test.js` 21/21（G1–G17 + G5b：编排三条路径、scoped-ctx 服务读取、后端选择、错误码归类、原子落盘、并发单飞锁、选择器契约快照、`/file` 路由收口、client 结构断言）；`lib/` 共 12 个模块 + `test/` + `scripts/smoke.mjs`，逐项对照见 [复刻清单.md](复刻清单.md)，技术细节见 [设计方案.md](设计方案.md)，交接见 [handoff.md](handoff.md)。四条 `/doubao-paint/*` 路由与两个 Agent 工具已在运行中的 GUI 上实测通过（见 §6.2）；真实出图 `2848×1600`、5278162 字节落盘并注入对话（见 §6.3、§6.4）；鲁棒性与发布工程见 §6.7。

**分两步走（用户 2026-11-06 定，不可跨越）：**
1. **Stage 1 — 完整复刻原插件的所有功能**，已知缺陷照搬不改，验收＝[复刻清单.md](复刻清单.md) A–G 全表 + DoD 五条；
2. **Stage 2 — 加固与新功能**（错误码、CLI 探测链、路径收口、超时预算、选择器加固、并发互斥…），候选见设计方案 §11。

---

## 1. 一句话

原插件 [`dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image) 把「谁去点网页」这一层外包给了 **Tabbit 浏览器**；本项目把这一层换成 **Chrome + `chrome-devtools-mcp`**，其余业务逻辑（提示词组装、选图打分、下载落盘、附件注入、Web 面板）原样继承。

## 2. 为什么可以不要 Tabbit

2026-11-06 在本机拆开 `tabbit-cli` 后的实测事实：

| 观察点 | 实测值 | 含义 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Tabbit\LocalAgent` | 3.60 MB（`bin\tabbit-cli.exe` 2.58 MB） | CLI 只是个转发器 |
| `launcher-target.json` → `cliPath` | `...\1.20.21.0\TabbitDance\tabbit-playwright-cli.exe` | 真身是 **Playwright 封装** |
| `endpoint.json` → `transport` | `named_pipe`，另有 `token` 与 `generation` | 靠命名管道连浏览器，不是 CDP 端口 |
| `Tabbit Browser` 总体积 | 1394.3 MB（Application 910.6 + User Data 483.7） | 多装一整个 Chromium |

也就是说，Tabbit CLI 实际只提供三样东西：**一个已登录的浏览器轮廓**、**一次进程调用能跑一段带 `page` 的脚本**、**任务与标签组的生命周期**。这三样 Chrome 侧都有对应物：

| Tabbit 提供 | Chrome 对应物 |
| --- | --- |
| 已登录轮廓 | `--userDataDir=<持久目录>`（登录一次长期有效）/ `--autoConnect`（Chrome 144+ 直连运行中的默认 profile） |
| 一段带 `page` 的脚本 | `evaluate_script "() => ..."` + `take_screenshot --filePath` + `navigate_page` |
| 任务/标签组生命周期、幂等 | CLI daemon 的 `start/stop/status` + `pageId` 路由 |

唯一换不来的是 Tabbit 的产品级承诺：**新任务在独立标签组里执行、不抢用户焦点**。

## 3. 能力对照（原插件逐项）

### 3.1 原样保留（7 项，宿主侧零改动）

| 功能 | 代码位置（原插件） |
| --- | --- |
| 宿主侧带 `Referer`/UA 下载图片 | `lib/index.js:1056-1076` |
| 文件名生成与落盘、`previewUrl` | `lib/index.js:1103`、`1130` |
| 附件注入（`attachments.saveImage`） | `lib/index.js:1000-1050` |
| 会话内 history（上限 30） | `lib/index.js:1153-1155` |
| 工具输出渲染（文本 + image 块） | `lib/index.js:1177-1221` |
| Web 4 条路由（status/open/generate/file） | `lib/index.js:1441-1558` |
| 输入框工具行触发条 + 对话框上方展开面板 | `lib/client.js:644-1057`（`conversation.input.left` + `conversation.input.dock`） |

### 3.2 同构替换（9 项，逻辑照搬，调用方式变）

| 功能 | 原实现 | 新实现 |
| --- | --- | --- |
| 关推广弹窗 | 脚本内 `dismissPromoDialogs()` | `evaluate_script` 内同名函数 |
| 登录检测 | `[data-testid="to_login_button"]` 等 | 同选择器，走 `evaluate_script` 返回 |
| 云电脑模式回退 | 点 `workspace-switch-chip` | 同 |
| 新建会话 | 点 `create_conversation_button` | 同 |
| 技能按钮 | `skill_bar_button_3` | 同（该选择器本身脆弱，见改进项） |
| 输入提示词 | `keyboard.insertText` | `fill <pageId> <uid> <text>`，兜底 `execCommand('insertText')` |
| 发送 | 点 `chat_input_send_button` / Enter | `click` 或 `evaluate_script` 内 `.click()` |
| 轮询取图 + 过滤打分 | 单脚本内 2500ms 循环 | 宿主侧循环多次 `evaluate_script` |
| 未登录/生成完成截图 | `artifactPath('*.png')` | `take_screenshot <pageId> --filePath <绝对路径>` |

### 3.3 必须新写（4 项）

| 项 | 说明 |
| --- | --- |
| daemon 生命周期 | `status` 探活 → `start --userDataDir=...` → 空闲 `stop` |
| 登录态路线选择 | persistent profile / `--autoConnect` 二选一（见设计文档 D3） |
| CLI 缺失与路径探测 | 取代原插件「只认一个绝对路径」的 `tabbitCliPath` |
| 错误码映射 | `cli_missing` / `daemon_unavailable` / `login_required` / `timeout_or_no_image` … |

### 3.4 删除（2 项）

`tabbitCliPath`（改名 `chromeCliPath`）、**`taskName`（已彻底删除）**。

> `taskName` 是原插件里给 Tabbit「任务」起的名字，用于在 Tabbit 侧定位/复用标签组。本项目的 `pageId` 由 `list_pages` / `new_page` 现取现用，没有可命名的任务对象，因此该配置项、其 locale 文案、工具参数与请求体字段**全部移除**；`Config` 现为 11 项（原 9 项 + 后端的 `browserBackend` / `egoCliPath`），旧配置里带 `taskName` 也不会报错（归一化时直接忽略）。

## 4. 架构

```
┌──────────────────────── DSH 插件进程 ────────────────────────┐
│  lib/index.js       注册 tools / 4 条 route / systemPrompt    │
│  lib/chrome-cli.js  daemon 探活、命令拼装、JSON 信封解析       │
│  lib/doubao-page.js 页面侧脚本常量（选择器 / 过滤器 / 轮询片段）│
│  lib/download.js    宿主侧 fetch（Referer + UA）→ 落盘        │
│  lib/client.js      触发条 + 面板（IIFE + ModuleLoader）      │
└───────────────────────────┬──────────────────────────────────┘
                            │ execFile("chrome-devtools", [...])
                            │ （Windows 命名管道，与 Tabbit 同族）
┌───────────────────────────▼──────────────────────────────────┐
│  chrome-devtools-mcp daemon（start / stop / status）           │
│      └─▶ Chrome 156（持久 profile 或 --autoConnect）           │
│              └─▶ https://www.doubao.com/chat/                 │
└───────────────────────────────────────────────────────────────┘
```

## 5. 与原插件的主要差异

| 维度 | 原作 | 本项目 |
| --- | --- | --- |
| 浏览器依赖 | Tabbit（闭源，1394 MB） | Chrome（用户已有）+ 官方 npm 包 |
| 传输层 | 命名管道 + token + generation | CLI daemon 命名管道（同一族，由官方维护） |
| 登录态 | Tabbit profile | 持久 `chromeUserDataDir` 或 `--autoConnect` |
| 任务隔离 | 独立标签组，**不抢窗口** | `pageId` 路由，**会抢窗口**（唯一损失） |
| 新增依赖 | — | `chrome-devtools-mcp`（可选 npx 拉起） |
| 插件包体积 | ~100 KB | ~110 KB（依赖外置） |

## 6. 本机实测过的命令（Phase 0 结论，替换掉旧的「未知项」）

```powershell
# ① 装 CLI（两秒，全局）
npm i -g chrome-devtools-mcp@latest

# ② Windows 上不要走 .cmd，直接用 node 跑 JS 入口（避免 shell 引号歧义）
$cli = "$env:APPDATA\npm\node_modules\chrome-devtools-mcp\build\src\bin\chrome-devtools.js"
node $cli status
node $cli list_pages --output-format=json

# ③ 只探活；daemon 是进程级单例，不重复 start
node $cli status

# ④ 起有头 Chrome + 持久 profile（首次登录用；插件里的写死路径）
node $cli start --headless=false --userDataDir "$env:USERPROFILE\.dsh\doubao-chrome-profile"

# ⑤ 证明「一条命令能拿回结果」
node $cli evaluate_script "() => document.title" --pageId 1 --output-format=json
```

实测要点：

| 项 | 实测值 |
| --- | --- |
| `start` 默认 headless | **`--headless` 缺省为 true**，有头必须显式 `--headless=false` |
| `start` 是否阻塞 | 不阻塞，后台化后立刻 rc=0，`status` 立即报 running |
| `status` 输出 | 纯文本 + `pid=` / `socket=` / `args=["--viaCli",...]`，**无 JSON** |
| `evaluate_script` JSON | 结果包在 `{"message":"…```json\n{…}\n```"}` 信封里，需取 `.message` 再解析 |
| 长脚本 | 走 `--sourcePath <abs.js> --format script`，脚本体为 `(async () => {…})()` |
| 截图 | `take_screenshot <pageId> --filePath <abs.png> --format png`，**不加** `--output-format` |

第 ④ 步必须**有人工一次登录**（扫码/手机号），此后同一 profile 长期有效。

## 6.1 插件的 daemon 归属判定（实现中新增的必需项）

CLI daemon 是**进程级单例**：如果本机已有别的工具起的隔离实例，直接复用会让「持久 profile + 有头登录」失效（登录态落在临时目录里，下次又变未登录）。
因此 `ensureDaemon()` 不只做「running 就复用」：

1. `status` 里解析出 `args=[...]`；
2. 比对 `--headless=<期望值>` 与 `--userDataDir <profileDir>`；
3. 不匹配 → `stop` → 按 Stage 1 参数 `start`，返回 `{ started:true, restarted:true }`。

## 6.2 安装进 profile（2026-11-06 实测）

desktop profile 由 Electron 独占（`dsh plugin --profile desktop …` 直接报 `profile "desktop" is managed exclusively by the Electron application`），因此**只能走宿主的 plugin manager**。本会话实测：

```
plugin_manager install_bundle  target=file:D:/Projects/active/dsh-plugins/dsh-doubao-paint
→ {"stage":"enable","bundle":"dsh-doubao-paint","version":"0.1.0",
   "application":"applied","packageResult":{"exitCode":0}}
```

落盘结果三处：

| 位置 | 结果 |
| --- | --- |
| `~/.dsh/profiles/desktop/package.json` | `dependencies["dsh-doubao-paint"]="file:D:/…/dsh-doubao-paint"`，`dsh.profile.bundles` 追加 `dsh-doubao-paint`（16 项） |
| `~/.dsh/profiles/desktop/node_modules/dsh-doubao-paint` | pnpm 落地的链接，`lib/client.js` 可读 |
| `~/.dsh/profiles/desktop/pnpm-lock.yaml` | 由 pnpm 重写（v11.28.5，2.3s） |

热加载生效，无需重启。四条路由与两个工具的实测响应：

| 请求 | 实测 |
| --- | --- |
| `GET /doubao-paint/status` | `200` + `{"ok":true,"cliExists":true,"config":{…9 字段…},"presets":[8 条],"aspectRatios":[8 条],"history":[]}` |
| `GET /doubao-paint/generate` | `405`（正确拒绝非 POST） |
| `GET /doubao-paint/file?path=C:\Windows\win.ini` | `400`（扩展名白名单拦下） |
| `GET /doubao-paint/file?path=C:\nope\missing.png` | `404`（路径合法但文件不存在） |
| `Tool.listTools`（宿主 inspect） | `doubao_generate_image`、`doubao_image_status` 均在列，参数 schema 与参考实现逐字段一致 |

注意：`outputDir` 未配置时按参考实现用 `process.cwd()` 解析，宿主进程 cwd 是 profile 目录，所以默认落点是 `~/.dsh/profiles/desktop/doubao_images`。想放到工作区就显式配绝对路径。

### 6.3 真实出图验收（2026-11-06，DoD ③）

一次人工扫码后，用同一份 `lib/orchestrator.js` 在纯 node 下跑完整链路（`.runs/e2e-live.mjs`，有头 + 持久 profile）：

| 步骤 | 实测 |
| --- | --- |
| `mode:status`（未登录） | `{"status":"succeeded","isLoggedIn":false,"pageTitle":"豆包 - 字节跳动旗下 AI 智能助手"}`，7.5s |
| 人工扫码登录后 `mode:generate` | `{"status":"succeeded","isLoggedIn":true,"imageCount":1,...}`，52.3s |
| 落盘文件 | `doubao_2026-11-06T14-33-31_1.png`，4155616 字节，PNG 签名 `89504e470d0a1a0a` 校验通过 |
| 图片尺寸 | `width=2848 height=1600`（≥360 门限通过，`wm0` 无水印图优先） |
| 附件注入 | `attachments.saveImage` 返回 `attachmentId`，`renderDoubaoToolOutput` 走 img 块 |
| 过程截图 | `.runs/e2e-output/.runs/doubao-generate-…/generation.png` |

daemon 归属判定同样实测成立：`status` 报 `args=["--viaCli","--no-headless","--user-data-dir=C:\\Users\\Jiaz\\.dsh\\doubao-chrome-profile"]`，说明有头 + 持久 profile 是插件自己拉起来的，登录态落在持久目录里，下次复用。

**宿主内的一处坑（已修，需重启生效）**：宿主跑在 Electron 里，`process.execPath` 是 `DeepSeek Harness.exe` 而不是 node，早期实现直接把 `.js` 入口交给它 → 报 `Unknown argument: …chrome-devtools.js`。现在 `lib/chrome-cli.js` 的 `resolveNodeExecutable()` 按 `DSH_NODE_EXEC_PATH` → PATH 里的 `node(.exe)` → `%ProgramFiles%\\nodejs\\node.exe` 探测真实解释器。`plugin_manager set_plugin` 关闭再开启只会重挂载、**不会重新 import 模块**（ESM 缓存），因此这条修复要桌面版重启一次才进入运行进程。

### 6.4 GUI 内直接调用工具（2026-11-06，DoD ③ 闭环）

在 DSH 桌面版会话里直接调 `doubao_generate_image`（prompt「一只戴墨镜的橘猫坐在霓虹雨夜的街边」、`aspectRatio: 16:9`、`style: cyberpunk`、`maxImages: 1`）实测成功：

| 项 | 值 |
| --- | --- |
| 返回 | `status: succeeded`、`isLoggedIn: true`、`imageCount: 1` |
| 页面 | `https://www.doubao.com/chat/38451959397187074` |
| 落盘 | `%USERPROFILE%\.dsh\profiles\desktop\doubao_images\doubao_2026-11-06T14-59-24_1.png`，5278162 字节 |
| 尺寸 | `2848 × 1600`，`watermarkFree: true` |
| PNG 签名 | `89504e470d0a1a0a`（磁盘直读校验） |
| 附件 | `attachedToChat: true`，图片在对话里直接渲染 |
| 过程截图 | `doubao_images\.runs\doubao-generate-2026-11-06-14-58-44-59ac7e\generation.png` |
| `/doubao-paint/file` | `200`、`5278162` 字节，与磁盘同尺寸 |

**踩到并修掉的一处**：`lib/orchestrator.js` 原先用 `ctx?.attachments` 访问服务，Cordis 的 scoped ctx 在插件未 inject 该服务时**属性访问直接抛错** → `Error: cannot get property "attachments" without inject`（出图已成功、只是注入环节炸在返回前）。现在：`lib/index.js` 的 `inject` 显式声明 `['tools', 'attachments']`，`apply` 顶部用 `readService(ctx, 'attachments')` 取一次并随 `deps` 传下去；`lib/orchestrator.js:readService` 先 `ctx.get(name)`、再兜底 `ctx[name]`，两条都吞异常，服务缺失时降级为纯路径对象而不是抛错。回归项 G5b 用 Proxy 模拟「属性访问必抛错」的 ctx 锁住这个行为。

**已知未收口（留待下一阶段）**：本次会话里插件被 `set_plugin` 反复关开过，宿主内残留了两个挂载实例——工具侧（新模块，能出图）与 `/doubao-paint/status` 路由侧（旧实例，`history` 恒为 `[]`）。代码已加防御（`sharedHistory` 提到模块层，同一模块实例内多次 `apply` 共用一个数组），但跨实例仍各持一份；**干净重启桌面版即可回到单实例**，届时 `status.history` 会与工具返回一致。

## 6.5 面板按钮的宿主接法（2026-11-06 二次修复）

前端两处交互原先都静默失效：`插入对话让 Agent 生图`、缩略图卡上的 `引用路径`。根因不是按钮没绑事件，而是插入路径找错了对象——`lib/client.js` 的 `insertIntoComposerDraft` 读 `ctx.conversation.input.shell(sessionId)`，而 **client 侧根本没有 `conversation` 这个 Service**（实测只有 layout / locale / sessions / slots / theme / timer / uiWorkspace / workspaces），`shell` 恒为 `undefined`，函数返回 `false` 却不报错。

宿主的正确接法（`@deepseek-ai/dsh-client-ui-conversation/lib/client.js:19969-19985`）：会话 slot 通过 `ctx.uiSession.provide({ props: ["inputActions"], … props: { inputActions: shell.actions } })` 把 **`InputActions`** 直接下发成组件 props。其方法面（同文件 `SessionInputShell.actions`，14998-15024）：

| 方法 | 用途 |
| --- | --- |
| `captureInsertion()` | 取插入点 `{ offset, length, draftRev }` |
| `insertText(text, span)` | 在 span 处插入，`draftRev` 不匹配则返回 `false` |
| `setDraft(text)` | 整篇替换草稿 |
| `persistDraft()` | 落本地持久化 |
| `submit()` | 提交（本插件不用） |

现在 `DoubaoStudioDock({ sessionId, inputActions })` 接住该 prop，插入顺序为 `captureInsertion → insertText →（失败）setDraft → persistDraft`；拿不到 `inputActions` 时保留旧 shell 兜底，仍失败就把「插入失败：输入框尚未就绪」写回面板状态，不再假装成功。回归项 G8 用假 `inputActions` 锁住三条分支（`insertText` 正常、只有 `setDraft` 时的兜底、两者都没有时返回 `false`）。

**提示词前缀去重**（同一轮反馈第二条）：`lib/prompt.js:buildDoubaoPrompt` 新增 `collapseDrawPrefix()`，把 `生成图片：请生成图片：一只猫` 折叠成 `请生成图片：一只猫`（只在外层前缀带冒号、内层仍是画图指令时折叠，避免误伤「生成器架构」这类正文）；`画面风格：` / `画面比例：` 的存在性改成按标签判重，同一提示词重复格式化**幂等**（G2 锁住）。同时客户端插入的指令文案由「操控豆包网页版生成图片：…」改为「操控豆包网页版生图：…」，避免 Agent 把「生成图片：」当成提示词前缀原样回传。

以上客户端改动刷新页面（Ctrl+F5）即生效；`prompt.js` 属宿主侧，需重启桌面版才吃到新的去重逻辑（不去重也不会出错，只是极端情况下会多一层前缀）。

## 6.6 浏览器后端：默认 ego lite，Chrome 回落（2026-11-07 实测）

「谁去点豆包网页」现在是可替换的一层，由 `browserBackend` 决定：

| 值 | 行为 |
| --- | --- |
| `ego`（默认） | 用本机 `ego-browser.exe` 的 `nodejs` 脚本通道（`lib/ego-cli.js`）；探不到 ego 时自动回落 Chrome |
| `auto` | 与 `ego` 同一判定（探到即用 ego，否则 Chrome），语义上留给「不想固定后端」的场景 |
| `chrome` | 强制走现役 `chrome-devtools-mcp` CLI/daemon（`lib/chrome-cli.js`） |

`resolveBrowserBackend(config)`（`lib/orchestrator.js`）做判定，`createBrowserSession(config, { runDir, signal })` 造会话；`executeDoubaoAction` 只依赖六方法契约（`ensureDaemon / ensurePage / evaluate / screenshot / stop / finish`），编排、下载、附件、history、路由与 UI 零改动。`/doubao-paint/status` 现在返回 `backend` 与 `backends:{ ego:{path,exists}, chrome:{path,exists} }`。

**实测对比（同一台机器、同一个提示词）**

| | ego lite 0.6.2.7 | Chrome 链路 |
| --- | --- | --- |
| 登录态 | 直接复用 `Profile 1`，**零扫码** | 独立 profile，首次需扫码 |
| `status` | 6.6s | 7.5s |
| `generate` | 31.4s | 52.3s |
| 产物 | 4072118 字节 / 2848×1600 / PNG | 3970341 字节 / 2848×1600 / PNG |
| 截图 | 后台隐藏窗口偶发超时 → `{skipped:true}` | 稳定落盘 |
| 解释器陷阱 | 无（ego 自带 Node 24） | 需 `resolveNodeExecutable()` 绕开 Electron `execPath` |

**空间纪律**（用户级硬性要求，已写进代码）：每次动作结束 `executeDoubaoAction` 的 `finally` 都会 `chrome.finish({ keep: [] })`，ego 任务空间用完即弃；`keepTab` 在 ego 后端下是 no-op（ego 没有可停的 daemon），Chrome 后端照旧映射到 `stop`。

**ego 后端的已知坑**

1. 脚本只能落盘成 `.mjs` 再 `ego-browser nodejs -e "await import('file:///…')"`，PowerShell 会吃掉命令行里的双引号；脚本内的 `console.log` 走 **stderr**（`parseEgoPayload` 两个流都试）。
2. 载荷必须是 JSON **对象**；顶层数组（`JSON.stringify(list)`）解析不出来。
3. `page.url()` / `page.title()` 返回 Promise；`page.evaluate` 直接吃 IIFE 字符串，`lib/doubao-page.js` 的脚本零改造复用。
4. 后台空间无合成帧：`Page.captureScreenshot` 会超时，`screenshot()` 用 4s 超时后返回 `{skipped:true, reason:'ego-background-space-has-no-compositor'}`，不阻断出图。
5. 触碰用户自己的 space（`id 0`，`createdBy:user`）会把它翻成 `ownership:agent`，导致用户失去控制；探针误碰后用 `takeOverTaskSpace(0)` + `task.handOff()` 可还原成 `agentDelegatedToUser`（本次已还原，标签页未丢）。
6. `ego-browser.exe` 在 `Application\<version>\` 版本目录内，升级会漂移；`resolveDefaultEgoCliPath()` 扫目录取最高版本并按安装根缓存，路径消失才重扫。**0.6.2.7 仍是 beta**。

## 6.7 鲁棒性与发布工程（v0.3，2026-11-07）

这一节记录「可以推荐给别人」所需的加固项，全部有代码与离线断言兜底。

**① 12 个结构化状态码**（`lib/errors.js`）

| code | 含义 | 触发点 |
|---|---|---|
| `ok` | 成功 | 正常返回 |
| `login_required` | 豆包未登录 | probe / 技能 / 轮询三处登录墙 |
| `no_image` | 超时且无图 | 轮询到期仍无合格图（带 `tailText` 末 800 字） |
| `partial` | 部分图失败 | 下载阶段有成功也有失败（`savedCount` / `failedCount`） |
| `download_failed` | 图全下载失败 | 同上，成功数为 0 |
| `busy` | 已有生成在跑 | 单飞锁命中（带 `activeRequestId` / `activeMode` / `activeSince`） |
| `cancelled` | 调用被取消 | `AbortError` / `signal.aborted` |
| `cli_missing` | 后端 CLI 不存在 | ego / chrome 探测失败、`ENOENT` |
| `backend_unavailable` | 无可用后端 | `/doubao-paint/status` 返回 503 |
| `contract_changed` | 豆包改版 | 必需选择器缺失、输入/发送未生效 |
| `rate_limited` | 被限流 | 429 / rate limit / 验证码关键词 |
| `unknown` | 其他 | 兜底 |

**② 并发单飞锁**：`lib/orchestrator.js` 的模块级 `activeRun` + `getActiveRun()`。第二次并发调用立即拿到 `busy`，不再出现「两个实例各自点同一个豆包标签页」的互相踩踏；`request.skipLock` 保留给壳层内部复用。

**③ 落盘原子性 + 重名保护**：`lib/download.js` 的 `writeFileAtomic`（同目录 `.tmp-<8hex>` + `rename`）与 `uniqueFilePath`（`_1.png` 已存在则 `_1-2.png`…），避免半截文件与同秒重名覆盖。

**④ 选择器契约漂移检测**：`lib/contract.js` 把 8 个 `data-testid` 与 2 个图片特征收敛成单一真源；`buildProbeScript` 会回报每个选择器的命中数，`missingSelectors()` 判定 `loginButton` / `loginModal` / `inputEditor` / `sendButton` 是否缺失 → 缺失即 `contract_changed`（错误文案直接提示升级插件或反馈 issue）。G16 还会校验「契约表里的每个选择器都真的出现在页面脚本源码里」，防止改了表忘了改脚本。

**⑤ 超时预算统一**：`resolveToolTimeoutMs(config.timeoutMs)` 把工具超时按 `配置 + 30s` 夹到 `60s…300s`（120s 配置 → 150s 工具超时）；轮询内部只用 `timeoutMs × 0.85` 的预算，给截图、下载、附件注入留出余量；单图下载另有 `DOWNLOAD_TIMEOUT_MS = 45s` 并和外部 `AbortSignal` 合并。

**⑥ 发布工程**：`npm run smoke`（`scripts/smoke.mjs --offline`，7 项离线检查，输出 JSON）、`npm run verify`（测试 + 冒烟）、`.github/workflows/ci.yml`（Ubuntu/Windows × Node 20/22：`npm test` → 冒烟 → `npm pack --dry-run` → 断言发布包内不含内部设计文档）。

## 7. 目录（已落盘的实际结构）

```
dsh-doubao-paint/
  lib/index.js          插件入口（name / inject / Config / apply / 2 工具 / 4 路由 / render）
  lib/config.js         配置归一化 + schemastery（11 字段，含 fallback 分支）
  lib/chrome-cli.js     Chrome 适配层（探活 / daemon 归属判定 / 命令拼装 / JSON 信封解析 / 会话对象）
  lib/ego-cli.js        ego lite 适配层（exe 探测 / .mjs 脚本通道 / TaskSpace 生命周期 / 空间释放）
  lib/prompt.js         提示词组装、风格解析、输出目录、文件名前缀
  lib/doubao-page.js    页面脚本（wait-ready / probe / 切模式 / 新会话 / 技能 / 输入 / 发送 / 取图 / 尾文本）+ 选图打分
  lib/orchestrator.js   一次生成的完整时序（E1–E11）+ 单飞锁 + 后端选择 + 契约判定
  lib/download.js       宿主侧下载、原子落盘、附件注入、history
  lib/errors.js         12 个状态码表、PaintError、classifyError、failureResult
  lib/contract.js       豆包页面选择器契约（8 选择器 + 2 特征）+ 缺失判定
  lib/constants.js      比例 / 风格 / 默认值 / 超时预算 / 系统提示词（client 复用同一份）
  lib/client.js         触发条 + 面板（1057 行，自包含 IIFE + ModuleLoader）
  scripts/smoke.mjs     离线冒烟（7 项检查，CI 复用）
  test/index.test.js    离线断言（node --test test/index.test.js，21 项）
  .github/workflows/ci.yml  CI：测试 + 冒烟 + 打包内容检查
  locale/zh.json        配置项文案（11 字段）
  locale/en.json
  cordis.patch.yml      以 id `doubao-paint` 挂载 dsh-doubao-paint
  package.json
  README.md  ← 当前文件
  复刻清单.md
  设计方案.md
  handoff.md
```

`lib/index.js` 直接 `import` 宿主包 `@deepseek-ai/dsh-tools` 取 `defineTool`，取不到时回落到本地 `fallbackDefineTool`——所以离线测试不需要宿主环境。

## 8. 已知损失与代价

1. **不抢窗口没了（ego 后端下不成立）。** Chrome 新建标签会抢焦点，自动化跑的时候用户看得见。缓解：`--headless`（但首次登录必须有头）+ 复用同一页面不新建。**默认改走 ego lite 后该问题消失**：ego 的 agent space 跑在隐藏窗口里（`IsWindowVisible=False`），用户前台不受打扰；只有显式 `browserBackend=chrome` 时才回到这条代价。
2. **隔离性方向反转。** 若用 `--autoConnect`，MCP 能读默认 profile 的全部登录态（官方 README 自己写了 disclaimer）；用持久独立 profile 则没有这个问题——**推荐后者**。
3. **多一个依赖。** 从「零 npm 依赖」变成依赖一个 Google 包，需要处理版本与 npx 冷启动。

## 9. 参考与致谢（Credits）

### 9.1 参考插件

| 项 | 值 |
| --- | --- |
| 项目名 | `dsh-doubao-image`（Doubao Web Image Studio） |
| 作者 | [@xt765](https://github.com/xt765) |
| 仓库 | <https://github.com/xt765/dsh-doubao-image> |
| 与本项目关系 | **功能复刻 + 架构重构**。非官方分支，未经上游作者审核或背书，与其无隶属关系 |

本项目的存在前提就是上游作者把「DSH 插件如何驱动豆包网页版生图」这件事跑通了。没有 `dsh-doubao-image` 的公开实现，本项目无从复刻。

### 9.2 继承自上游的部分

- **功能契约**：工具名 `doubao_generate_image` / `doubao_image_status`、参数表（`prompt` / `aspectRatio` / `style` / `negativePrompt` / `outputDir` / `filenamePrefix` / `maxImages` / `newConversation` / `keepTab`）、四条 `/…/{status,open,generate,file}` Web 路由、`conversation.input.dock` 面板形态；
- **业务逻辑**：提示词装配（画图前缀判重 + 风格/比例后缀）、选图打分与去重（`/rc_gen_image/` 键、`wm0.png` 水印优先、宽高 ≥ 360 过滤）、下载落盘（带 `Referer` 与 UA）、附件注入与 `history` 上限 30；
- **页面契约**：豆包网页版的 `data-testid` 选择器集合（`chat_input_input` / `chat_input_send_button` / `skill_bar_button_3` / `create_conversation_button` 等）与轮询跳出策略；
- **设计文档结构**：`复刻清单.md` 的 A–G 对照表与 DoD 五条，源自上游功能面的逐项拆解。

### 9.3 本项目重写的部分

- **浏览器驱动层**：上游外包给 Tabbit + Playwright；本项目重写为两条可切换后端 —— `ego-lite`（`TaskSpace` / `page.evaluate` / `page.fetch({saveAs})`）与 `chrome-devtools-mcp` CLI（`evaluate_script` / `take_screenshot` / daemon 归属判定），见 `lib/ego-cli.js`、`lib/chrome-cli.js`；
- **命名空间**：`doubao-image` → `doubao-paint`（配置 id、locale 命名空间、slot id `doubao-paint-studio-dock` / `doubao-paint-studio-chip`），避免与原插件在同一 profile 内冲突；
- **新增约束**：`/doubao-paint/file` 只服务 `history` 记录或 `outputDir` 内的图片（P0 安全收口）、`browserBackend` 三值选择、任务结束 `finish({keep:[]})` 释放 ego 空间；
- **测试**：`test/index.test.js` 的 G1–G12 全部为本项目新写（假 ctx / 假 DOM / 假浏览器 / 真实文件系统断言）。

### 9.4 许可

- 本项目代码以 **MIT** 发布（见 [LICENSE](LICENSE)）。
- 上游仓库的许可证与署名要求**以上游仓库自身的 `LICENSE` 为准**；本仓库不复制、不改写上游许可条款。若上游要求特定署名形式，请在上游仓库确认后按需补充。
- 商标与产品：豆包 / Doubao / 字节跳动 等名称与商标归其权利人所有，本项目为第三方非官方工具，仅通过用户已登录的浏览器界面操作其网页版。

## 10. 文档索引

- [复刻清单.md](复刻清单.md)：Stage 1 的逐项对照表（A 注册面 / B 配置 / C 工具 / D 业务逻辑 / E 页面流程 / F 产物与 UI / G 测试），含 DoD 与 Stage 2 候选
- [设计方案.md](设计方案.md)：模块划分、配置 schema、工具 schema、执行时序、命令映射、决策记录、Stage 2 加固清单
- [handoff.md](handoff.md)：四段式交接、Phase 0 探针命令、Phase 1–5 拆解、风险登记、未决问题
