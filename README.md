# dsh-doubao-paint

> 功能复刻自 [`xt765/dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image)，非官方分支，与原作者无隶属关系。致谢见文末。

用本机浏览器操控豆包网页版生成图片：下载高清原图（通常 2848×1600、无水印源）、放进对话附件、存到输出目录，并把结果同时呈现在会话、工具图卡和输入框下方的面板里。

- 版本 **1.4.4** · 离线测试 **34 项** · 冒烟 **13 项**
- 浏览器后端：优先本机 **ego lite**，没有则用 **Chrome + chrome-devtools-mcp**
- 已真机跑通：`/doubao-paint <描述>` → 补全提示词 → 生图 → 落盘 + 附件 + 面板记录

## 安装

在 DSH 里执行 `plugin_manager`（desktop profile 由应用独占，装插件只走这个入口）。两种方式任选：

```text
# A. GitHub 直装（推荐，可换版本号或 ref）
action=install_bundle, target=github:Jiazliang/dsh-doubao-paint#v1.4.4

# B. Release 包（离线可传阅）
action=install_bundle, target=https://github.com/Jiazliang/dsh-doubao-paint/releases/download/v1.4.4/dsh-doubao-paint-1.4.4.tgz
```

装完重启 DSH，然后首次登录豆包：

```text
doubao_image_status({ openLoginIfNeeded: true })
```

后端依赖（二者任一即可，插件自己探测）：

| 后端 | 依赖 | 说明 |
|---|---|---|
| ego lite（首选） | 已安装 ego lite 0.6.x | 复用其已登录 Profile，无需扫码 |
| Chrome（回落） | Chrome + 全局 `chrome-devtools-mcp`（`npm i -g chrome-devtools-mcp`） | 使用持久 profile，首次需人工扫码 |

## 三个入口

| 入口 | 形态 | 何时用 |
|---|---|---|
| **`/doubao-paint <画面描述>`** | 技能手势 | 日常主入口；描述不完整时最有用，模型会先补全提示词 |
| **`doubao_generate_image`** | Agent 工具 | 模型自己决定要出图时（与手势同一条路径） |
| **输入框下方「豆包网页生图」面板** | 前端 UI | 手动填参数、按工作区看历史、引用路径 |

面板里的「✨ 插入对话让 Agent 生图」会把参数整理成一条技能手势写进输入框（形如 `/doubao-paint 一只橘猫（比例：16:9，风格：电影级 CG）`），你确认后再发送。

面板历史按工作区分组：当前会话工作区默认展开并置顶，其他工作区的图折叠在下面，各自显示张数。每组标题右侧有「清除」，删掉该组的历史记录和本地图片（会先确认一次），其他工作区不受影响。

### 工具参数

| 参数 | 说明 |
|---|---|
| `prompt` | 必填。画面描述；**不要**再写「生成图片：」前缀，也不要带比例/风格 |
| `aspectRatio` | `1:1` `16:9` `9:16` `4:3` `3:4` `3:2` `2:3`，默认取配置 |
| `style` | `auto` `cinematic-cg` `photorealistic` `cyberpunk` `chinese-ink` `anime` `3d-isometric` `minimal-editorial`，或自定义描述 |
| `negativePrompt` | 不要出现的元素 |
| `maxImages` | 1–8，默认取配置 |
| `newConversation` | 每次开新会话（默认 `true`）；`false` 复用当前会话继续改图 |
| `outputDir` / `filenamePrefix` / `keepTab` | 覆盖落盘目录 / 文件名前缀 / 是否保留标签页 |

`doubao_image_status({ openLoginIfNeeded })` 返回登录态、后端探测结果与环境体检信息。

## 配置（11 项）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉即完全不注册工具、路由和界面 |
| `browserBackend` | `auto` | `auto`（有 ego 用 ego，否则 chrome）/ `ego` / `chrome` |
| `egoCliPath` | 空=自动探测 | 指定 ego lite 可执行文件 |
| `chromeCliPath` | 空=自动探测 | 指定 chrome-devtools 命令行入口 |
| `doubaoUrl` | `https://www.doubao.com/chat/` | 生图会话地址 |
| `defaultAspectRatio` / `defaultStyle` | `16:9` / `auto` | 未指定时的默认值 |
| `outputDir` | `doubao_images` | 相对路径按宿主目录解析 |
| `timeoutMs` | `120000` | 单次生图预算，范围 30000–180000 |
| `keepTab` | `true` | 生成后是否保留浏览器标签页 |
| `injectSystemPrompt` | `true` | 是否注入插件级系统提示（教模型何时调工具） |

## 结果与状态码

成功返回 `status: "succeeded"`，每张图含绝对路径、预览地址、宽高、字节数、是否无水印，并已作为附件注入对话。

| `code` | 含义 |
|---|---|
| `ok` | 成功 |
| `partial` | 有图但部分下载失败 |
| `login_required` | 豆包未登录，按提示登录后重试 |
| `no_image` | 页面没产出图片（附页面末尾文本便于判断） |
| `download_failed` | 全部下载失败 |
| `busy` | 已有生图任务在跑 |
| `cancelled` | 被取消 |
| `cli_missing` / `backend_unavailable` | 没有可用浏览器后端 |
| `contract_changed` | 豆包页面结构变了，需要更新插件 |
| `rate_limited` / `unknown` | 触发风控 / 未归类错误 |

## 已知限制

- 豆包改版会命中 `contract_changed`，需等插件更新适配。
- ego lite 后台截图偶尔拿不到，会被跳过，不影响图片本身下载。
- 升级插件要连版本一起换：GitHub / Release 装就指向新 tag 或新 `.tgz`，本地源码装就重新同步一次，然后重启 DSH——不重启仍是旧代码。
- 单机同一时间只跑一个生图任务，并发第二次会立刻返回 `busy`。
- 图片统一存在宿主目录下的 `doubao_images`，不按会话工作区分目录；工作区只作为面板分组标签。

## 隐私

- 只驱动本机已登录的浏览器，账号凭据留在浏览器里，不经过插件、不写日志。
- 发给豆包的内容就是你的画面描述（加上比例/风格），与手动在网页里打字等价。
- 生成的图只落在本机输出目录；对话里显示的是本机地址，不上传第三方。
- 面板里的「清除」会连同本地图片文件一起删除，删前有一次确认。

## 参考与致谢

- 参考插件：[`xt765/dsh-doubao-image`](https://github.com/xt765/dsh-doubao-image)（作者 [@xt765](https://github.com/xt765)）。本项目是它的功能复刻与架构重写，未经上游背书。
- 继承：工具契约、四条基础路由、提示词装配与选图打分、下载与附件注入、页面选择器口径。
- 重写：浏览器驱动层（ego lite / chrome-devtools 双后端）、命名空间、错误码与状态码体系、面板与工具图卡、持久化与测试。
- 豆包与字节跳动相关商标归权利人，本项目与其无关联。

## 许可

MIT © 2026 Jiazliang
