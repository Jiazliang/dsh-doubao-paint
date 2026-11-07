# dsh-doubao-paint

> **本项目是 [`xt765/dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image) 的功能复刻与重构版本**，非官方分支，与原作者无隶属关系。继承与重写范围见 [参考与致谢](#参考与致谢)。

用本机浏览器操控豆包网页版生成图片：下载高清原图（通常 2848×1600、无水印源）、注入对话附件、写进输出目录，并把结果同时呈现在会话、工具图卡和底部面板里。

- 版本 **1.4.3** · 离线测试 **33 项全绿** · 冒烟 **13 项全绿**
- 浏览器后端：优先本机 **ego lite**，回落 **Chrome + chrome-devtools-mcp**
- 已在本机真机跑通：`/doubao-paint <描述>` → 模型补全提示词 → 生图 → 落盘 + 附件 + 面板记录

## 安装

```powershell
# 1) 让 DSH 装上本插件（desktop profile 由应用独占，只能这样装）
#    在 DSH 里执行 plugin_manager:
#    action=install_bundle, target=file:D:/Projects/active/dsh-plugins/dsh-doubao-paint

# 2) 首次使用先登录豆包（后端为 chrome 时是有头窗口；ego 复用其 Profile）
#    让插件打开登录页：
#    doubao_image_status({ openLoginIfNeeded: true })
```

后端依赖（二者任一即可，插件会自己探测）：

| 后端 | 依赖 | 说明 |
|---|---|---|
| ego lite（首选） | 已安装 ego lite 0.6.x | 复用其已登录 Profile，无需扫码；任务结束自动 `finish({keep: []})` 释放空间 |
| Chrome（回落） | Chrome + 全局 `chrome-devtools-mcp`（`npm i -g chrome-devtools-mcp`） | 使用持久 profile `~/.dsh/doubao-chrome-profile`，首次需人工扫码 |

## 三个入口，同一条通道

| 入口 | 形态 | 何时用 |
|---|---|---|
| **`/doubao-paint <画面描述>`** | 技能手势（宿主注入 `skill_content`，模型先补全提示词再调工具） | 日常主入口；描述不完整时最有用 |
| **`doubao_generate_image`** | Agent 工具 | 模型自己决定要出图时（与手势完全同一条路径） |
| **输入框下方「豆包网页生图」面板** | 前端 UI（`lib/client.js`） | 手动填参数、按工作区看历史、引用路径 |

面板里的「✨ 插入对话让 Agent 生图」会把参数整理成一条技能手势写进输入框（形如 `/doubao-paint 一只橘猫（比例：16:9，风格：电影级 CG）`），由你确认后再发送——和手打 `/doubao-paint` 完全同一条路径。面板历史按工作区分组：当前会话工作区默认展开，其他工作区的图折叠在下面，各自显示张数。

三者最终都调 `lib/entry.js` 的 `submitPaintRequest`，返回同一份 `PaintOutcome`；工具把结果渲染成纯文字详情，图片由独立图卡（`tool.call.toolview`）呈现。

### 工具参数

| 参数 | 说明 |
|---|---|
| `prompt` | 必填。画面描述；**不要**再写「生成图片：」前缀，也不要带比例/风格 |
| `aspectRatio` | `1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3` `21:9`，默认取配置 |
| `style` | `auto` `cinematic-cg` `photorealistic` `cyberpunk` `chinese-ink` `anime` `3d-isometric` `minimal-editorial`，或自定义描述 |
| `negativePrompt` | 不要出现的元素 |
| `maxImages` | 1–8，默认取配置 |
| `newConversation` | 每次开新会话（默认 `true`）；`false` 复用当前会话继续改图 |
| `outputDir` / `filenamePrefix` / `keepTab` | 覆盖落盘目录 / 文件名前缀 / 是否保留标签页 |

`doubao_image_status({ openLoginIfNeeded })` 返回登录态、后端探测与 `health`（命令行是否存在、输出目录可写性、契约选择器数量）。

## 配置（11 项）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉即完全不注册工具/路由/UI |
| `browserBackend` | `auto` | `auto`（探到 ego 用 ego，否则 chrome）/ `ego` / `chrome` |
| `egoCliPath` | 空=自动探测 | 指定 `ego-browser.exe` |
| `chromeCliPath` | 空=自动探测 | 指定 chrome-devtools CLI 入口（优先 `<pkg>/build/src/bin/chrome-devtools.js`） |
| `doubaoUrl` | `https://www.doubao.com/chat/` | 生图会话地址 |
| `defaultAspectRatio` / `defaultStyle` | `16:9` / `auto` | 工具未传时的默认值 |
| `outputDir` | `doubao_images` | 相对路径按宿主 cwd 解析 |
| `timeoutMs` | `120000` | 单次生图预算，夹 30000–180000；工具超时按它推导 |
| `keepTab` | `true` | 生成后是否保留浏览器标签页（ego 后端下空间始终释放） |
| `injectSystemPrompt` | `true` | 是否注入插件级系统提示（教模型何时调工具） |

## 结果与状态码

成功返回 `status: "succeeded"`，`images[]` 每项含 `filePath`（绝对路径）、`previewUrl`、宽高、字节数、是否无水印；图片已作为附件注入对话。

| `code` | 含义 |
|---|---|
| `ok` | 成功 |
| `partial` | 有图但部分下载失败（看 `images[]` 里的失败项） |
| `login_required` | 豆包未登录，按返回的 `message` 引导登录后重试 |
| `no_image` | 页面没产出图片（含 `tailText` 末 800 字便于判断） |
| `download_failed` | 全部下载失败 |
| `busy` | 已有生图任务在跑（单飞锁，附 `activeRequestId`） |
| `cancelled` | 被取消 |
| `cli_missing` / `backend_unavailable` | 后端命令行不存在 / 两个后端都不可用（`/status` 此时回 503） |
| `contract_changed` | 豆包页面结构变了（附 `details.missingSelectors`） |
| `rate_limited` / `unknown` | 触发风控 / 未归类错误 |

## 架构

```
入口层   /doubao-paint 手势 · doubao_generate_image 工具 · 面板 · 4 条 HTTP 路由
           └─ lib/entry.js  submitPaintRequest()   ← 唯一通道，返回 PaintOutcome
编排层   lib/orchestrator.js   探针 → 新对话 → 技能 → 输入 → 发送 → 轮询取图 → 下载
后端层   lib/ego-cli.js (TaskSpace/Page)  |  lib/chrome-cli.js (chrome-devtools CLI/daemon)
页面层   lib/doubao-page.js  {探针, 等待就绪, 切工作模式, 新对话, 技能, 输入, 发送, 收集, 尾巴}
支撑     lib/download.js 落盘/附件 · lib/history.js 持久化与保留 · lib/health.js 体检
         lib/contract.js 选择器契约 · lib/errors.js 12 状态码 · lib/render.js / lib/client.js UI
```

产物：`<outputDir>/<prefix>_<ISO>_<n>.png`、`<outputDir>/.history.json`、`<outputDir>/.runs/<requestId>/`（截图与脚本，保留最近 20 个请求、5 张截图）。

HTTP 路由（端口随宿主）：`/doubao-paint/status`（`?probe=1` 时才真探页面）、`/open`、`/generate`（仅 POST）、`/file`（只服务 history 记录或 `outputDir` 内的图片，支持 `?id=` 或 `?path=`）。

## 前置条件

- **DSH 桌面版**：插件通过 `plugin_manager.install_bundle` 装进 desktop profile；`dsh plugin` 命令行管不了该 profile。
- **本机浏览器**：ego lite（0.6.x，推荐）或 Chrome + 全局 `chrome-devtools-mcp`，二者任一能被探测到，否则 `/status` 返回 503 `backend_unavailable`。
- **豆包账号已登录**：ego 复用其 `Profile 1`；Chrome 用持久 profile，首次需人工扫码一次。插件不会代填账号密码，也不保存登录凭证。
- **网络**：需能访问 `www.doubao.com` 与生成图所在 CDN（`*.byteimg.com`）；企业代理/地区限制会让探针停在 `login_required` 或 `contract_changed`。
- **磁盘**：默认输出目录 `<宿主 cwd>/doubao_images`（通常即 profile 目录），单张原图约 4–5 MB；`.runs/` 只保留最近 20 个请求。

## 隐私与数据边界

- 只驱动本机已登录的浏览器，凭据留在浏览器 profile 里，不经过插件代码，也不写进日志。
- 发给豆包的内容就是你的 `prompt`（加上比例/风格后缀），与手动在豆包网页里打字等价。
- 落盘位置由 `outputDir` 决定；`.history.json` 只记文件名、尺寸、工作区标签等元数据，不存图片内容本身。
- HTTP 路由只监听本机；`/file` 只服务 `history` 记录或 `outputDir` 内的图片（`resolveImageRequest` + `isInsideDirectory`），不接受任意路径读取。
- 会话内嵌图使用 `http://127.0.0.1:<port>/doubao-paint/file?...`，图片本身不上传到任何第三方。

## 验收

```powershell
node --test test/index.test.js     # 33 项：纯函数、编排、路由、UI、契约、history、单飞锁、状态条
node scripts/smoke.mjs --offline   # 13 项：发布前冒烟，不碰浏览器
npm pack --dry-run                 # 发布包不含内部文档
```

真机复核（需已登录豆包）：调用 `doubao_generate_image`，检查 `status`、`images[0].filePath` 是否落盘、宽高 ≥ 360、`previewUrl` 在 Web UI 能打开（必须是 `http://127.0.0.1:<port>/doubao-paint/file?...`，本地盘符路径浏览器不解）。

## 已知限制

- 豆包改版会命中 `contract_changed`：契约集中在 `lib/contract.js`（骨架段 `workspaceChip`/`newConversation`，输入区段 `inputEditor`），改这里即可。
- ego 后端在后台空间截图不稳定：截图失败会被跳过（`screenshots` 为空或仅路径），不影响图片下载。
- 插件代码改动后需两步才生效：先 `node scripts/sync-profile.mjs` 把工作区源码同步进宿主实际加载的 profile 副本（默认 `~/.dsh/profiles/desktop/node_modules/dsh-doubao-paint`，脚本按 SHA256 逐文件核对），再重启宿主——ESM 模块在进程内只求值一次，不重启仍是旧代码。
- 单机单任务：并发第二次调用会立刻拿到 `busy`。
- 图片与 `.history.json` 统一落在 `<宿主进程 cwd>/doubao_images`（默认即 profile 目录），不按会话工作区分散存放；工作区只作为记录上的标签用于面板分组，切换工作区不会改变落盘位置。

## 目录

```
lib/
  index.js       入口：Config / apply / 2 工具 / 4 路由 / 系统提示
  entry.js       唯一入口 submitPaintRequest
  orchestrator.js 生图编排 + 单飞锁 + 后端选择
  ego-cli.js     ego lite 后端（TaskSpace）
  chrome-cli.js  chrome-devtools CLI 后端（daemon）
  doubao-page.js 页面脚本（探针/输入/发送/收集）
  download.js    下载、原子落盘、附件注入
  history.js     .history.json 持久化与 .runs 保留
  health.js      环境体检
  contract.js    选择器契约
  errors.js      12 状态码与归类
  prompt.js      提示词装配、路径与前缀清洗
  render.js      工具结果渲染
  constants.js   默认值、比例/风格、版本号
  client.js      前端：触发条 + 面板 + 工具图卡（IIFE）
locale/          zh.json / en.json（配置面板文案）
scripts/smoke.mjs / test/index.test.js
```

## 参考与致谢

- **参考插件**：[`xt765/dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image)（作者 [@xt765](https://github.com/xt765)）。本项目是它的功能复刻 + 架构重构，**非官方分支，未经上游背书**。
- **继承**：工具契约与四条路由、业务逻辑（提示词装配、选图打分、`Referer` 下载、附件注入、history 30 条）、豆包页面 `data-testid` 契约、上游文档里的能力分类口径。
- **重写**：浏览器驱动层（ego `TaskSpace` 与 chrome-devtools CLI 双后端）、命名空间 `doubao-image` → `doubao-paint`、`/file` 可读性收口、`browserBackend` 三值、12 状态码、契约两段判定、原子落盘与单飞锁、`history` 持久化与面板事件刷新、工具图卡；测试全部新写。
- **许可**：本项目 MIT（见 `LICENSE`）；上游代码/文档的许可与版权归其仓库所有；豆包与字节跳动相关商标归权利人，本项目与字节跳动无关联。

## 许可

MIT © 2026 Jiazliang