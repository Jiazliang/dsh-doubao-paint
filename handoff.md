# handoff · dsh-doubao-paint

> 交接时间：2026-11-06 22:10
> 上游：`dsh-doubao-image`（Tabbit 后端）拆解完成，Chrome 替代可行性已实测确认
> 本文件自足：实现方无需读本会话上下文，只需读本文件 + [复刻清单.md](复刻清单.md) + [设计方案.md](设计方案.md)

---

## 任务状态

<!-- type:state -->
**设计定稿，代码零行。** 目录 `D:\Projects\active\dsh-plugins\dsh-doubao-paint` 下现有 4 份文档（README / 复刻清单 / 设计方案 / 本文件），无 `package.json`、无 `lib/`、无测试。

已完成的研究（可直接引用，不必重做）：

| 结论 | 依据 |
| --- | --- |
| Tabbit CLI 是 Playwright 封装 + 命名管道服务 | `launcher-target.json` 指向 `tabbit-playwright-cli.exe`；`endpoint.json` 为 `transport:"named_pipe"` + token + generation |
| Tabbit 全量 1394.3 MB（Application 910.6 + User Data 483.7） | 本机实测 |
| Chrome 侧能力可覆盖原插件约 90% | 官方 `chrome-devtools-mcp` 的 CLI：`evaluate_script` / `take_screenshot --filePath` / `navigate_page` / `new_page` / `click` / `fill` / `list_pages` / `start` / `stop` / `status` + `--output-format=json` |
| 登录态三通道 | `--userDataDir`（持久，默认 `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile`）、`--autoConnect`（Chrome 144+，需 `chrome://inspect/#remote-debugging` 授权）、`--browserUrl`（仍受 136+ 非默认目录限制） |
| 唯一功能损失 | 「不抢窗口 + 独立标签组」 |
| 迁移量 | 约 120–150 行新增（其余照搬） |

本机环境（2026-11-06 实测）：Chrome **156.0.8078.80**、Node **v22.23.2**、`chrome-devtools-mcp` **未全局安装**、`~\.agents\skills\tabbit` 存在（本方案不用它）。

---

## 目标

<!-- type:goal -->
在 `D:\Projects\active\dsh-plugins\dsh-doubao-paint`（或你被指派的新目录）实现 DSH 插件 **`dsh-doubao-paint`**：用本机已登录的 Chrome，经官方 `chrome-devtools-mcp` 的 CLI/daemon，驱动豆包网页版生图，免 API Key，不依赖 Tabbit。

**分两阶段，严格按序：**

- **Stage 1（唯一当前任务）：完整复刻原插件所有功能。** 验收即 [复刻清单.md](复刻清单.md) 的 A–G 全表 + DoD 五条。原实现的已知缺陷（表内标 ⚠）**照搬不改**。
- **Stage 2（Stage 1 DoD 全绿后才启动）：加固与新功能。** 候选清单在复刻清单末尾，本阶段一条都不要提前做。

---

## 已试方案与失败原因

<!-- type:dead-end -->
已排除，不要重走：

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 直连 CDP（自己读 `DevToolsActivePort` / 固定 9222） | 放弃 | 要自写 `DevToolsActivePort` 握手、target 归属、进程生命周期、幂等队列、产物目录——正是原插件一行没写的部分；CLI 已把这些封好 |
| `--browserUrl` 连默认 profile | 不可行 | Chrome 136+ 拒绝在默认 user-data-dir 上开远程调试端口 |
| 打包 Tabbit 绿色版进插件 | 放弃 | 1394 MB 量级、无再分发授权、版本漂移、登录态仍带不走 |
| 自带 Playwright Chromium 作降级 | 暂缓 | +150 MB，且换来的是「无登录态复用、无任务隔离」的阉割版；Stage 2 再议 |
| 把 CLI 调用拆成十几个原子工具逐一调用 | 否决 | 一次生成会变成几十次进程往返且状态易错位；改为「探针 / 输入 / 取数」三段脚本，轮询复用第三段 |
| 页面内 `fetch` 下载图片 | 否决 | 撞 CORS 与 blob 处理；沿用宿主侧 fetch + `Referer` |

**本次未验证、实现时必须自己验的**（不要照抄结论）：

| 未知 | 怎么验 |
| --- | --- |
| CLI `start` 能否转发 `--autoConnect` | `chrome-devtools start --help` |
| `--headless=false` 的写法 | 同上 |
| `fill` 参数顺序、有无 `press_key`、`take_snapshot` 输出格式 | `chrome-devtools <tool> --help` |
| 默认 profile 登录是否被豆包风控挡 | 用持久 profile 起有头 Chrome，人工登录一次看是否成功 |
| daemon 单次调用开销 | 计时 10 次 `evaluate_script "() => 1"`，目标 < 300 ms/次 |

---

## 进度与下一步

<!-- type:progress -->
### Phase 0 · 探针（半天，**先做这个，决定 Stage 1 的登录态写法**）

```powershell
npm i -g chrome-devtools-mcp@latest
chrome-devtools status
chrome-devtools start --userDataDir="$env:USERPROFILE\.dsh\doubao-chrome-profile"   # 有头，人工登录豆包一次
chrome-devtools list_pages --output-format=json
chrome-devtools evaluate_script "() => document.title" --pageId <N> --output-format=json
chrome-devtools take_screenshot <N> --filePath "$env:TEMP\probe.png"
```

判据：`list_pages` 的 JSON 里能找到 `doubao.com/chat`；`evaluate_script` 返回的 title 含「豆包」；截图文件 > 10 KB；上面五次调用总耗时 < 5 s。

**Phase 0 的产出决定两件事**：①登录态路线（持久 profile 够用就固定它；`--autoConnect` 只在 CLI 支持且用户不想多登一次时才启用）；②若 CLI 连不上已登录的页，立刻切 D2 备胎（插件自 spawn `chrome-devtools-mcp` 走 stdio JSON-RPC，约 80 行）。

### Phase 1 · 骨架（0.5 天）

1. `package.json` / `dsh.plugin.json` / `cordis.patch.yml`（字段见设计方案 §1）
2. `lib/index.js`：`name` / `inject` / `Config`（主轨 + 降级轨）/ `apply()` 空壳
3. `lib/chrome-cli.js`：`resolveCliPath()`、`callTool()`、`parseEnvelope()`
4. 装到 DSH 验证：插件能被识别、`Config` 表单能渲染

### Phase 2 · 纯函数层（1 天，先补测试再接线）

`lib/prompt.js`（D1/D2）、`lib/doubao-page.js`（D3/D4/D5/D6，含 `pickImages`）、`lib/download.js`（F1/F2）。
同步搬 `test/index.test.js` 的 G1–G4 四条用例。**这一步不碰浏览器，全部可离线跑。**

### Phase 3 · 页面流程（1.5 天）

`lib/doubao-page.js` 三个脚本常量（`SCRIPT_PROBE` / `SCRIPT_INPUT` / `SCRIPT_COLLECT`）→ `lib/orchestrator.js` 串 E1–E11。
先在 Phase 0 那个已经登录的页上手工敲 CLI 命令验证每一步，再写成代码。

### Phase 4 · 产物与 UI（1 天）

附件注入、history、4 条路由、`lib/client.js` dock 面板、locale 两文件、G5–G8 用例。

### Phase 5 · 端到端验收（0.5 天）

跑复刻清单 DoD 五条，把结果贴进本文件「验收记录」小节。

**顺序不可换**：Phase 2 的纯函数必须先绿，否则 Phase 3 一旦出错分不清是选择器问题还是逻辑问题。

---

## 验收约束（用户既定，硬性）

1. **验收一律用 HTTP / 数值断言，不得把页面内容显示到屏幕上**，必要时用 headless。
2. 只有「首次人工登录豆包」这一步可以出现有头界面——那是用户交互，不算验收。
3. 登录完成后置 `chromeHeadless=true` 再跑回归。
4. 建目录规约：本项目在 `D:\Projects\active\dsh-plugins\` 下，与 `dsh-worktree` / `dsh-autoshutdown` 同级；`playground` 只放一次性验证件。

---

## 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 豆包对自动化浏览器风控 | 登录被拒 / 生成被拦 | 持久 profile + 人工登录；输入走 `fill`（真实输入管线）而非 `textContent` 赋值；不并发 |
| `skill_bar_button_3` 改版 | 找不到技能按钮 | Stage 1 照搬；Stage 2 换语义选择器（按文案「图片生成」匹配） |
| CLI 单次调用开销大 | 一次生成几十次往返，总时长超预期 | Phase 0 先量；超 300 ms 就把轮询间隔提到 3 s，并合并取数与截图 |
| daemon 残留 | 端口/管道占用、下次起不来 | `keepTab:false` 在 `finally` 收尾；status 路由提供手动 `stop` |
| `--autoConnect` 暴露默认 profile | 隐私面扩大 | Stage 1 不用它，默认持久独立 profile |
| 原插件缺陷被照搬 | 未加载完的图导致下载失败 | Stage 1 接受（复刻优先），Stage 2 补 `item.complete` |

---

## 未决问题（实现中如遇，按「复刻优先」裁定，不要自行加功能）

1. `pageId` 是否稳定（CLI 重启后编号是否重排）？若重排，需在 `ensureDaemon()` 后重新 `list_pages` 取号。
2. 一次生成期间用户在同一 Chrome 里点开豆包页，会不会被 `evaluate_script` 打到错页？Stage 1 用「记住 pageId + 每步校验 `location.href`」兜。
3. `keepTab` 保留原名后，README 里要不要解释它现在停的是 daemon？—— 要，一句话，不写实现细节。

---

## 验收记录

（实现完成后由实现方填写：日期 / 命令 / 判据结果 / 失败项）
