# ego lite 兼容性评估（第三版 · 决策已落地）

> 第一版（「ego 只做可选后端」）作废；第二版给出方向；**第三版是已实施状态**。
> 2026-11-07 用户批注：「做成首先，优先接入ego，时候清理空间」→ 已按此落地并实测。

## 〇、第三版变更（相对第二版）

| 项 | 第二版 | 第三版（现状） |
| --- | --- | --- |
| 默认后端 | 待定（`auto` 探测） | **`browserBackend=ego`**，探不到 ego 自动回落 Chrome |
| 配置项 | 9 字段 | **11 字段**（+`browserBackend`、`egoCliPath`） |
| 空间生命周期 | 仅提示纪律 | **代码强制**：`executeDoubaoAction` 的 `finally` 调用 `finish({ keep: [] })` |
| 验证 | 只跑过单次探针 | `node --test test/index.test.js` **15/15**；默认后端链路真实出图；清理遗留空间 |

## 一、结论

1. **兼容：要，而且 ego 应当是本机首选后端。** 不是因为「多一个选项」，而是因为 ego 在关键维度上比 chrome-devtools 链路更强。
2. **实现方式：走 ego 自己的脚本通道（`ego-browser nodejs` + TaskSpace/Page API），不要去碰 CDP attach。** 后者确实做不到，但那是「换一条更差的路」，与本项目无关。
3. **降级路径：chrome 仍保留为回落后端。** 其他机器没有 ego 时必须能跑，插件按 `auto` 探测（ego 可用 → ego，否则 chrome）。
4. **唯一真实代价：截图。** ego 的后台空间没有合成帧，`Page.captureScreenshot` 稳定超时，`login.png` / `generation.png` 必须变成「可选、超时即跳过」。图片本体下载不受影响，而且**比 chrome 侧更干净**（`Download.saveAs()` 直接把浏览器下载存到绝对路径，不需要自己塞 `Referer`/`UA`）。

## 二、实测证据（2026-11-07，本机 ego lite 0.6.2.7）

| 维度 | 实测结果 | 含义 |
| --- | --- | --- |
| 窗口可见性 | ego 主进程 pid 18320 拥有 3 个 `Chrome_WidgetWin_1`：`ego lite smoke test 20261107` ×2、`新标签页 - ego`；`IsWindowVisible` **全部 False**；`Get-Process ego` 的 `MainWindowHandle` 全为 0 | 后台空间真的不上屏，不抢用户前台 |
| DOM / 脚本 | 后台空间里 `page.evaluate` 正常：`{visibilityState:"visible", hasFocus:false, innerWidth:2195, innerHeight:1112}`，`page.goto` / `waitForSelector` / `fill` / `keyboard.*` 全可用 | 业务脚本可以完整搬过去 |
| 截图 | `page.screenshot({path})` 与 `page.cdp('Page.captureScreenshot')`（含 `fromSurface:false`、`optimizeForSpeed`、`captureBeyondViewport:false`）**全部 `CDP request timed out: Page.captureScreenshot`，单次 15 秒**；新建空间、已有空间表现一致 | 截图必须降级，且要短超时，否则单次要白等 15 秒 |
| 登录态 | ego 的 `Profile 1`（Jiazhi）里 `History` 中 `doubao.com` 命中 124 次，但打开 `/chat/` 后 `[data-testid="to_login_button"]` **存在** → 当前未登录 | 「复用用户登录」是潜力不是现状：需用户在 ego 里登录豆包一次 |
| 未登录态编辑器 | 同一页面里编辑器是 `<textarea data-testid="chat_input_input" class="textarea-YelHeN" placeholder="发消息...">`，`document.querySelectorAll('.ProseMirror').length === 0` | 页面结构随登录态变化 → 输入脚本需要同时支持 `textarea` 与 `.ProseMirror` |
| 控制面 | `ego-browser nodejs -e` 里 `taskSpace / claimTaskSpace / takeOverTaskSpace / TaskSpace.{page,pages,tabs,newPage,adopt,release,waitForControl,handOff,finish,cdp}`；`Page.{goto,evaluate,fill,click,press,keyboard.*,mouse.*,waitForSelector,waitForFunction,waitForURL,waitForEvent,snapshot,setInputFiles,fetch,cdp,info}` | 能力面显著大于 chrome-devtools CLI 子命令集 |
| 下载 | `page.waitForEvent('download')` → `Download.{url,suggestedFilename,saveAs(absPath),page}`，`saveAs` 自动建父目录并等下载完成 | 出图落盘可以完全交给浏览器，免 `Referer`/UA 拼装 |
| 版本/路径 | `C:\Program Files\Citro Labs\ego lite\Application\0.6.2.7\ego-browser.exe`（不在 PATH，目录带版本号）；`ego lite 0.6.2.7`（beta）/ Chromium 156.0.8078.74 / 内置 Node v24.22.1 | 需「探测一次 + 缓存 + 失效重探」，不能每次硬扫 |

## 三、对四条批注的回应

1. **CDP attach 与否不是重点。** 用户批注成立：ego 有自己的 skill 与 `nodejs` 控制通道，能力面（键盘/鼠标/snapshot/waitForEvent/download）比 CDP 裸调更适合本项目。第一版把「attach 不了」当成否定理由，是选错了评价轴。
2. **不干扰前台：成立。** 隐藏窗口证据如上，ego 的 agent space 与用户 space 都在不可见窗口里运行；我原先担心的「抢用户前台标签」不成立。
3. **路径探测：本来就得做，且应缓存。** 首次探测 + 记录 `{path, version}` + 调用失败（ENOENT/版本变更）时重探；不需要每次扫描。
4. **不上屏：成立。** 但由此带来一个必须写进设计的副作用：**隐藏窗口不合成 → `captureScreenshot` 超时**。这不是「ego 不行」，而是「ego 后端下截图能力为零」，得在适配器层显式处理（短超时 3 秒、失败即 `screenshots: []` 并附 `screenshotSkipped: true`）。

## 四、推荐落地（Stage 2）

后端接缝已存在：`lib/orchestrator.js:206` 的 `deps.chrome || createChromeSession(...)`，与 `lib/chrome-cli.js` 约定的五方法契约。

新增 `lib/ego-cli.js`，把五方法映射到 ego：

| 我方约定 | ego 实现 |
| --- | --- |
| `ensureDaemon()` | 探测 `ego-browser.exe`（探测一次 + 缓存 + 失效重探），`nodejs -e` 冷启动 105–123ms，无常驻 daemon 需要 |
| `ensurePage()` | `await taskSpace('dsh-doubao-paint', { profileId })` 复用同名空间 → `task.page('p1')` / `task.newPage()`；记 `page.targetId` |
| `evaluate(name, source)` | `page.evaluate(<IIFE>)`，直接返回对象（ego 无 chrome-devtools 的 `message`+fenced 信封，解析更简单） |
| `screenshot(path)` | 尝试 `page.screenshot({path})`，**外套 3 秒超时**，失败返回 `{skipped:true}`；不阻塞主流程 |
| `stop()` | `task.release()` / `task.finish({ keep: [...labels] })`（注意 `finish` 必须传对象，否则报 `task.finish options must be an object`） |

配套改动：

- `lib/download.js` 增加 ego 路径：先 `page.waitForEvent('download')` 再点（豆包生成的图片通常走页面内下载），拿到 `Download` 后 `saveAs(绝对路径)`；失败才回落到现有 `fetch + Referer` 路径。
- `lib/doubao-page.js` 的 `buildInputScript` 同时支持 `textarea` 与 `.ProseMirror`（未登录态是 textarea，已验证）。
- 配置新增 `browserBackend`（`auto | chrome | ego`，默认 `auto`，uid 11）+ locale 两条文案。
- 测试：4 条离线用例（探测命中 / 探测失败回落 / 截图超时降级 / download.saveAs 落盘），沿用假对象注入，不启动真浏览器。

## 五、前提与风险

- 用户在 ego 里登录豆包一次（本次实测该 profile 未登录）。
- ego 仍是 0.6.2.7 beta，API 随版本变化；已用 `ego-browser skill` 记录版本号 `v2.2.0`，适配器内做版本探测。
- 其他机器没有 ego：`auto` 必须能干净回落到 chrome，不能让插件因缺 ego 而报错。
- `TaskSpace` 礼仪：不要长期霸占用户空间；只用 agent-owned 空间，用完 `finish({ keep })`。

## 六、证据（可复现）

- `.runs/ego-probe2.mjs`：空间/页面状态（`visibilityState`、`page.info()`）。
- `.runs/ego-probe3.mjs` / `ego-probe4.mjs` / `ego-probe5.mjs`：截图三种路径 × 新旧空间，全部 `CDP request timed out: Page.captureScreenshot`（15s）。
- `.runs/ego-probe6.mjs`：豆包页面探针 → `to_login_button: true`、`hasSendButton: true`、`hasNewConversation: true`。
- `.runs/ego-probe7.mjs`：编辑器 DOM → `<textarea data-testid="chat_input_input">`，`ProseMirror` 计数 0。
- Win32 `EnumWindows` 枚举：ego 三个 `Chrome_WidgetWin_1` 全部不可见。