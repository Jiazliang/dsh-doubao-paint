/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — chrome-devtools CLI 客户端
 *
 * 本模块是「浏览器后端」的唯一出口：把参考实现的 `tabbit-cli nodejs <script>` 一步调用，
 * 换成官方 `chrome-devtools-mcp` 的 CLI 子命令序列（start / status / stop / list_pages /
 * new_page / evaluate_script / take_screenshot）。
 *
 * 设计约束（Stage 1）：
 * - 持久化独立 profile（`~/.dsh/doubao-chrome-profile`）写死，重复使用以便保留豆包登录态；
 * - 必须有头（`--headless=false`），用户需要肉眼看到豆包页面完成首次扫码登录；
 * - 复用已运行的 daemon：CLI 的 daemon 是进程级单例，已存在就不再 start。
 *
 * @module dsh-doubao-paint/chrome-cli
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CHROME_PROFILE_DIRNAME } from './constants.js';

/** CLI 默认超时（毫秒）。 */
const DEFAULT_CLI_TIMEOUT_MS = 60000;

export class ChromeCliError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ChromeCliError';
    this.command = details.command || '';
    this.exitCode = details.exitCode;
    this.stdout = details.stdout || '';
    this.stderr = details.stderr || '';
    this.timeout = Boolean(details.timeout);
  }
}

/**
 * 解析默认的 `chrome-devtools` CLI 入口。
 *
 * Windows 上优先返回 npm 全局安装的 **JS 入口**（用 node 直接执行，彻底绕开 `.cmd` 的 shell
 * 引号问题）；找不到再退回 `.cmd`。其它平台返回 `~/.local/bin/chrome-devtools`。
 */
export function resolveDefaultChromeCliPath(customPath = '') {
  const trimmed = typeof customPath === 'string' ? customPath.trim() : '';
  if (trimmed.length > 0) return trimmed;

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const globalRoot = path.join(appData, 'npm');
    const jsEntry = path.join(
      globalRoot,
      'node_modules',
      'chrome-devtools-mcp',
      'build',
      'src',
      'bin',
      'chrome-devtools.js',
    );
    if (existsSync(jsEntry)) return jsEntry;
    return path.join(globalRoot, 'chrome-devtools.cmd');
  }

  // 非 Windows：npm 全局前缀按包管理器/发行版不同，逐个探（JS 入口优先，避免 shebang 依赖）
  const jsEntrySuffix = path.join(
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools.js',
  );
  const globalRoots = [
    process.env.npm_config_prefix,
    path.join(os.homedir(), '.npm-global'),
    '/usr/local',
    '/opt/homebrew',
    path.join(os.homedir(), '.local', 'share', 'pnpm'),
    '/usr',
  ].filter(Boolean);
  for (const root of globalRoots) {
    const libRoot = String(root).endsWith('lib') ? String(root) : path.join(String(root), 'lib');
    const candidate = path.join(libRoot, jsEntrySuffix);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 目录不可读就跳过
    }
  }

  const unixEntry = path.join(os.homedir(), '.local', 'bin', 'chrome-devtools');
  if (existsSync(unixEntry)) return unixEntry;
  return 'chrome-devtools';
}

/**
 * 找出真正能执行 JS 脚本的 node 解释器。
 *
 * 宿主若跑在 Electron 里，`process.execPath` 指向桌面版可执行文件而不是 node，
 * 直接用它跑 CLI 会把脚本路径当成应用参数（实测报 `Unknown argument: …chrome-devtools.js`）。
 * 因此按序探测：`DSH_NODE_EXEC_PATH` → PATH 里的 node(.exe) → 常见安装位置 → 最后才退回 execPath。
 */
export function resolveNodeExecutable() {
  const explicit = typeof process.env.DSH_NODE_EXEC_PATH === 'string'
    ? process.env.DSH_NODE_EXEC_PATH.trim()
    : '';
  if (explicit && existsSync(explicit)) return explicit;

  const isNodeBinary = (value) => /(?:^|[\\/])node(?:\.exe)?$/i.test(value);
  if (isNodeBinary(process.execPath)) return process.execPath;

  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    if (existsSync(candidate)) return candidate;
  }

  const fallbacks = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'),
        path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node.exe'),
      ]
    : ['/usr/local/bin/node', '/usr/bin/node', '/opt/homebrew/bin/node'];
  for (const candidate of fallbacks) {
    if (existsSync(candidate)) return candidate;
  }

  return process.execPath;
}

/**
 * 把 CLI 路径翻译成可安全 spawn 的 `{ command, prefixArgs }`。
 *
 * `.js` / `.mjs` / `.cjs` 入口用真实 node 解释器执行，避免 Windows 上 `.cmd` 的参数引号歧义。
 */
export function resolveCliInvocation(cliPath) {
  const value = typeof cliPath === 'string' ? cliPath.trim() : '';
  if (!value) {
    throw new ChromeCliError('chrome-devtools CLI 路径为空，请在插件配置里填写 chromeCliPath');
  }
  if (/\.(?:js|mjs|cjs)$/i.test(value)) {
    return { command: resolveNodeExecutable(), prefixArgs: [value], viaNode: true };
  }
  return { command: value, prefixArgs: [], viaNode: false };
}

/**
 * 豆包 Chrome 持久化用户目录（Stage 1 写死）。
 */
export function resolveChromeProfileDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.dsh', CHROME_PROFILE_DIRNAME);
}

/**
 * 执行一次 CLI 调用并返回 { stdout, stderr, code }。
 *
 * @param {string} cliPath
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, signal?: AbortSignal }} [options]
 */
export function runCli(cliPath, args, options = {}) {
  const { timeoutMs = DEFAULT_CLI_TIMEOUT_MS, cwd, signal } = options;
  const invocation = resolveCliInvocation(cliPath);
  const argv = [...invocation.prefixArgs, ...args];
  const printable = [invocation.command, ...argv].join(' ');

  return new Promise((resolve, reject) => {
    const child = execFile(
      invocation.command,
      argv,
      {
        cwd: cwd || process.cwd(),
        env: {
          ...process.env,
          NO_COLOR: '1',
          // 宿主是 Electron 时 process.execPath 指向桌面版可执行文件，
          // 必须让它在 Node 模式下跑，否则会把 CLI 脚本当成应用参数打开。
          ...(invocation.viaNode && process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true || /ETIMEDOUT/.test(String(error.code || ''));
          const detail = timedOut
            ? `chrome-devtools CLI 超时（${timeoutMs}ms）：${printable}`
            : `chrome-devtools CLI 执行失败（${error.code || 'ERROR'}）：${printable}`;
          reject(
            new ChromeCliError(detail, {
              command: printable,
              exitCode: typeof error.code === 'number' ? error.code : undefined,
              stdout: String(stdout || ''),
              stderr: String(stderr || ''),
              timeout: timedOut,
            }),
          );
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), code: 0 });
      },
    );
    child.on('error', (error) => {
      reject(new ChromeCliError(`chrome-devtools CLI 无法启动：${error.message}`, { command: printable }));
    });
  });
}

/**
 * 从 CLI 的 `--output-format=json` 输出里提取业务 JSON。
 *
 * 实测输出形如：
 * - `list_pages` / `new_page`：直接是对象（`{"pages":[...]}`）；
 * - `evaluate_script`：`{"message":"Script ran on page and returned:\n```json\n{...}\n```"}`。
 */
export function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;

  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  const candidates = [firstBrace, firstBracket].filter((i) => i >= 0).sort((a, b) => a - b);
  if (candidates.length === 0) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(candidates[0]));
  } catch {
    return null;
  }

  if (parsed && typeof parsed.message === 'string') {
    const embedded = extractJsonFromText(parsed.message);
    return embedded === undefined ? parsed : embedded;
  }
  return parsed;
}

/**
 * 从自由文本（例如工具结果的 `message`）中抠出第一段 JSON。
 */
export function extractJsonFromText(text) {
  const value = String(text || '');
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/i.exec(value);
  const body = fenced ? fenced[1] : value;
  const start = body.search(/[[{]/);
  if (start < 0) return undefined;
  for (let end = body.length; end > start; end -= 1) {
    const slice = body.slice(start, end);
    if (!/[\]}]$/.test(slice.trim())) continue;
    try {
      return JSON.parse(slice);
    } catch {
      // keep shrinking
    }
  }
  return undefined;
}

/**
 * 调用一个 CLI 工具子命令并以 JSON 解析结果。
 *
 * @param {string} cliPath
 * @param {string} toolName 例如 `list_pages`
 * @param {string[]} [toolArgs]
 * @param {{ timeoutMs?: number, cwd?: string, signal?: AbortSignal }} [options]
 */
export async function callTool(cliPath, toolName, toolArgs = [], options = {}) {
  const { stdout, stderr } = await runCli(
    cliPath,
    [toolName, ...toolArgs, '--output-format=json'],
    options,
  );
  const parsed = parseCliJson(stdout);
  if (parsed === null) {
    const hint = String(stderr || stdout).trim().slice(0, 500);
    throw new ChromeCliError(
      `chrome-devtools CLI 输出无法解析为 JSON（${toolName}）：${hint}`,
      { command: `${toolName} --output-format=json`, stdout, stderr },
    );
  }
  return parsed;
}

/**
 * 从 `status` 文本里抠出 daemon 启动参数（`args=[...]` 那一行是 JSON 数组）。
 */
export function parseDaemonArgs(statusText) {
  const match = /args=(\[[^\]]*\])/.exec(String(statusText || ''));
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/**
 * 判断已运行的 daemon 是否符合本次调用要求的 profile / headless 配置。
 *
 * 本机可能已有别的工具（或本插件的早期版本）起的 daemon；CLI 的 daemon 是进程级单例，
 * 直接复用会让「持久 profile + 有头登录」失效，所以参数不符时先 stop 再按需重启。
 */
export function daemonMatchesOptions(args, options = {}) {
  const { headless = false, profileDir = resolveChromeProfileDir() } = options;
  const list = Array.isArray(args) ? args : [];
  const flag = `--headless=${headless ? 'true' : 'false'}`;
  const headlessOk = list.includes(flag);
  const dirIndex = list.indexOf('--userDataDir');
  const dirOk = dirIndex >= 0 && list[dirIndex + 1] === profileDir;
  return headlessOk && dirOk;
}

/**
 * 确保 daemon 运行中；未运行则按 Stage 1 参数启动（持久 profile + 有头）。
 *
 * @param {{
 *   cliPath: string,
 *   headless?: boolean,
 *   profileDir?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal
 * }} options
 * @returns {Promise<{ started: boolean, statusText: string, profileDir: string, headless: boolean, restarted: boolean }>}
 */
export async function ensureDaemon(options = {}) {
  const {
    cliPath,
    headless = false,
    profileDir = resolveChromeProfileDir(),
    timeoutMs = 90000,
    signal,
  } = options;

  const statusResult = await runCli(cliPath, ['status'], { timeoutMs: 20000, signal });
  const statusText = String(statusResult.stdout || '').trim();
  let restarted = false;
  if (/is running/i.test(statusText)) {
    if (daemonMatchesOptions(parseDaemonArgs(statusText), { headless, profileDir })) {
      return { started: false, statusText, profileDir, headless, restarted };
    }
    // 已有一个参数不符的 daemon（例如别的工具起的隔离实例）：先停掉再来
    await runCli(cliPath, ['stop'], { timeoutMs: 20000, signal });
    restarted = true;
  }

  await mkdir(profileDir, { recursive: true });
  const startArgs = [
    'start',
    `--headless=${headless ? 'true' : 'false'}`,
    '--userDataDir',
    profileDir,
  ];
  const startResult = await runCli(cliPath, startArgs, { timeoutMs, signal });
  const startedText = String(startResult.stdout || '').trim();

  const verify = await runCli(cliPath, ['status'], { timeoutMs: 20000, signal });
  const verifyText = String(verify.stdout || '').trim();
  if (!/is running/i.test(verifyText)) {
    throw new ChromeCliError(
      `chrome-devtools daemon 启动失败：${(startedText || verifyText).slice(0, 500)}`,
      { command: startArgs.join(' '), stdout: startedText },
    );
  }
  return { started: true, statusText: verifyText, profileDir, headless, restarted };
}

/**
 * 停止 daemon（`keepTab=false` 时调用）。
 */
export async function stopDaemon(cliPath, options = {}) {
  const { timeoutMs = 20000, signal } = options;
  const result = await runCli(cliPath, ['stop'], { timeoutMs, signal });
  return String(result.stdout || '').trim();
}

/**
 * 列出所有页面。
 *
 * @returns {Promise<Array<{ id: number, url: string, title: string, selected: boolean }>>}
 */
export async function listPages(cliPath, options = {}) {
  const payload = await callTool(cliPath, 'list_pages', [], options);
  const pages = Array.isArray(payload?.pages) ? payload.pages : [];
  return pages
    .filter((page) => page && Number.isFinite(Number(page.id)))
    .map((page) => ({
      id: Number(page.id),
      url: typeof page.url === 'string' ? page.url : '',
      title: typeof page.title === 'string' ? page.title : '',
      selected: Boolean(page.selected),
    }));
}

/**
 * 找到（或新建）豆包标签页。
 *
 * @param {string} cliPath
 * @param {string} doubaoUrl
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ pageId: number, created: boolean, url: string }>}
 */
export async function ensureDoubaoPage(cliPath, doubaoUrl, options = {}) {
  const pages = await listPages(cliPath, options);
  const existing = pages.find((page) => /doubao\.com/i.test(page.url));
  if (existing) {
    if (/doubao\.com\/chat/i.test(existing.url)) {
      return { pageId: existing.id, created: false, url: existing.url };
    }
    await callTool(cliPath, 'navigate_page', [String(existing.id), '--url', doubaoUrl, '--type', 'url'], options);
    return { pageId: existing.id, created: false, url: doubaoUrl };
  }

  const created = await callTool(cliPath, 'new_page', [doubaoUrl], options);
  const createdPages = Array.isArray(created?.pages) ? created.pages : [];
  const target =
    createdPages.find((page) => page.selected && /doubao\.com/i.test(String(page.url || ''))) ||
    createdPages.find((page) => /doubao\.com/i.test(String(page.url || ''))) ||
    createdPages[createdPages.length - 1];
  if (!target || !Number.isFinite(Number(target.id))) {
    throw new ChromeCliError(`无法创建豆包标签页：${JSON.stringify(created).slice(0, 300)}`);
  }
  return { pageId: Number(target.id), created: true, url: String(target.url || doubaoUrl) };
}

/**
 * 把一个脚本写到 `<runDir>/<name>.js` 并返回绝对路径。
 *
 * `evaluate_script --format=script` 只接受单行函数实参或 `--sourcePath` 文件，长脚本一律走文件，
 * 避免命令行引号/换行问题。
 */
export async function writeScriptFile(runDir, name, source) {
  const filePath = path.join(runDir, `${name}.js`);
  await mkdir(runDir, { recursive: true });
  await writeFile(filePath, source, 'utf8');
  return filePath;
}

/**
 * 在指定页面执行一段脚本（脚本源码为异步 IIFE，返回值即调用结果）。
 *
 * @param {string} cliPath
 * @param {number} pageId
 * @param {string} source 脚本源码（会被写入临时文件）
 * @param {{ runDir: string, name: string, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function evaluateScript(cliPath, pageId, source, options = {}) {
  const { runDir, name = 'step', timeoutMs = 60000, signal } = options;
  const filePath = await writeScriptFile(runDir, name, source);
  return callTool(
    cliPath,
    'evaluate_script',
    [
      '--pageId',
      String(pageId),
      '--sourcePath',
      filePath,
      '--format',
      'script',
      '--waitForStableDom',
      'false',
    ],
    { timeoutMs, signal },
  );
}

/**
 * 截取当前视口到指定文件（调用方负责给出绝对路径）。
 */
export async function takeScreenshot(cliPath, pageId, filePath, options = {}) {
  const { timeoutMs = 60000, signal } = options;
  await mkdir(path.dirname(filePath), { recursive: true });
  const result = await runCli(
    cliPath,
    ['take_screenshot', String(pageId), '--filePath', filePath, '--format', 'png'],
    { timeoutMs, signal },
  );
  return String(result.stdout || '').trim();
}

/**
 * 把上面这些 CLI 原语绑成一个「已锁定页面」的会话对象。
 *
 * 编排器（`orchestrator.js`）只依赖这 5 个方法：`ensureDaemon / ensurePage / evaluate /
 * screenshot / stop`。测试可以整体替换 `deps.chrome` 而不必 mock 子进程与文件系统。
 *
 * @param {{
 *   cliPath: string,
 *   doubaoUrl: string,
 *   headless?: boolean,
 *   profileDir?: string,
 *   runDir: string,
 *   signal?: AbortSignal
 * }} options
 */
export function createChromeSession(options = {}) {
  const {
    cliPath,
    doubaoUrl,
    headless = false,
    profileDir = resolveChromeProfileDir(),
    runDir,
    signal,
  } = options;

  let pageId = 0;

  return {
    backend: 'chrome',
    get pageId() {
      return pageId;
    },
    ensureDaemon() {
      return ensureDaemon({ cliPath, headless, profileDir, signal });
    },
    async ensurePage() {
      const resolved = await ensureDoubaoPage(cliPath, doubaoUrl, { signal });
      pageId = resolved.pageId;
      return resolved;
    },
    evaluate(name, source, extra = {}) {
      if (!pageId) throw new ChromeCliError('evaluate 之前必须先 ensurePage()');
      return evaluateScript(cliPath, pageId, source, { runDir, name, signal, ...extra });
    },
    screenshot(filePath) {
      if (!pageId) throw new ChromeCliError('screenshot 之前必须先 ensurePage()');
      return takeScreenshot(cliPath, pageId, filePath, { signal });
    },
    stop() {
      return stopDaemon(cliPath, { signal });
    },
  };
}
