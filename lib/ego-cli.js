/**
 * ego lite 后端适配器 —— 与 `chrome-cli.createChromeSession` 同构的第二后端。
 *
 * 为什么要它：`orchestrator.js` 只依赖 `deps.chrome` 的 5 个方法
 * （`ensureDaemon / ensurePage / evaluate / screenshot / stop`），
 * 所以后端可以整体替换，而业务编排、下载、附件、history、路由、UI 都不用动。
 *
 * 与 chrome 后端的根本差异（本机实测，2026-11-07）：
 * - 没有 daemon：每次调用是 `ego-browser nodejs <script>` 一次性进程，冷启动 105–123ms；
 *   TaskSpace 与 Page 标签跨进程持久，靠名字/标签恢复。
 * - 页面脚本可以直接吃字符串 IIFE（`page.evaluate('(async () => {...})()')` 实测可用），
 *   因此 `doubao-page.js` 产出的脚本原样复用，无需改造成函数。
 * - 后台空间是**隐藏窗口**：DOM/键盘/鼠标/下载都可用，但 `Page.captureScreenshot`
 *   稳定超时（15s），所以截图必须短超时 + 失败降级。
 * - 下载可以走页面上下文：`page.fetch(url, { saveAs })` 自带 cookie，不用手塞 Referer/UA。
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class EgoCliError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'EgoCliError';
    this.code = options.code || 'EGO_CLI_ERROR';
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr || '';
    this.stdout = options.stdout || '';
  }
}

export const DEFAULT_EGO_SPACE_NAME = 'dsh-doubao-paint';
export const DEFAULT_EGO_PAGE_LABEL = 'p1';
export const DEFAULT_EGO_SCREENSHOT_TIMEOUT_MS = 4000;

const EGO_CLI_CANDIDATES = {
  win32: ['C:\\Program Files\\Citro Labs\\ego lite\\Application'],
  darwin: ['/Applications/ego lite.app/Contents/MacOS'],
  linux: ['/opt/ego lite'],
};
const EGO_CLI_BASENAME = {
  win32: 'ego-browser.exe',
  darwin: 'ego-browser',
  linux: 'ego-browser',
};

/** 用户级安装位置（非系统级）。macOS 装进 ~/Applications 很常见，Linux 常见 XDG 目录。 */
const EGO_CLI_EXTRA_ROOTS = {
  darwin: [path.join(os.homedir(), 'Applications', 'ego lite.app', 'Contents', 'MacOS')],
  linux: [
    path.join(os.homedir(), '.local', 'share', 'ego lite', 'Application'),
    '/opt/ego-lite',
    '/usr/lib/ego lite',
  ],
  win32: [path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ego lite', 'Application')],
};

const cliPathCache = new Map();

function compareVersions(a, b) {
  const pa = String(a).split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^\d]+/).filter(Boolean).map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 探测 ego-browser 路径（同步，供配置归一化使用）。
 *
 * 策略：`DSH_EGO_CLI_PATH` 环境变量优先（且必须存在）；否则扫安装根下的版本目录取最高版本；
 * 结果按「根目录」缓存，只有缓存路径消失时才重扫——不需要每次调用都遍历磁盘。
 */
export function resolveDefaultEgoCliPath(options = {}) {
  const {
    env = process.env,
    platform = process.platform,
    existsSync = fs.existsSync,
    readdirSync = fs.readdirSync,
    cache = cliPathCache,
  } = options;

  const override = env && typeof env.DSH_EGO_CLI_PATH === 'string' ? env.DSH_EGO_CLI_PATH.trim() : '';
  if (override && existsSync(override)) return override;

  const roots = [...(EGO_CLI_CANDIDATES[platform] || []), ...(EGO_CLI_EXTRA_ROOTS[platform] || [])];
  const bin = EGO_CLI_BASENAME[platform] || 'ego-browser';

  for (const root of roots) {
    const cached = cache.get(root);
    if (cached && existsSync(cached)) return cached;

    const direct = path.join(root, bin);
    if (existsSync(direct)) {
      cache.set(root, direct);
      return direct;
    }
    if (!existsSync(root)) continue;

    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const versions = entries
      .filter((entry) => entry && entry.isDirectory && /^\d+(?:\.\d+)+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions);
    for (let i = versions.length - 1; i >= 0; i -= 1) {
      const candidate = path.join(root, versions[i], bin);
      if (existsSync(candidate)) {
        cache.set(root, candidate);
        return candidate;
      }
    }
  }

  // 最后兜底：PATH 上的 ego-browser（用户可能把安装目录加进了 PATH，或用了包管理器）
  const pathVar = env && typeof env.PATH === 'string' ? env.PATH : '';
  for (const dir of pathVar.split(path.delimiter)) {
    const trimmed = String(dir || '').trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, bin);
    try {
      if (existsSync(candidate)) {
        cache.set(`PATH:${trimmed}`, candidate);
        return candidate;
      }
    } catch {
      // 目录不可读就跳过
    }
  }

  return '';
}

/** 每次调用一个全新 Node 进程，脚本必须以 .mjs 文件形式传递（PowerShell 的 `-e` 会吃掉引号）。 */
export function buildEgoInvocation(cliPath, scriptPath) {
  if (!cliPath) throw new EgoCliError('未找到 ego-browser CLI（可用 DSH_EGO_CLI_PATH 指定）', { code: 'EGO_CLI_MISSING' });
  const url = `file:///${String(scriptPath).replace(/\\/g, '/').replace(/^\/+/, '')}`;
  return {
    command: cliPath,
    args: ['nodejs', '-e', `await import(${JSON.stringify(url)})`],
  };
}

export function parseEgoPayload(stdout, stderr) {
  return extractJsonPayload(stdout) || extractJsonPayload(stderr);
}

function extractJsonPayload(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    // 既支持对象也支持数组：脚本既可能打印单个结果，也可能一次打印列表（例如 TaskSpace 清单）。
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      // 继续往前找
    }
  }
  return null;
}

/**
 * 跑一段 ego 脚本并取回它打印的 JSON。
 *
 * @param {string} cliPath
 * @param {string} script 完整 ESM 脚本文本（可用 top-level await）
 * @param {{ timeoutMs?: number, signal?: AbortSignal, runDir?: string }} options
 */
export async function runEgoScript(cliPath, script, options = {}) {
  const { timeoutMs = 90000, signal, runDir = path.join(os.tmpdir(), 'dsh-ego-scripts') } = options;
  await fsp.mkdir(runDir, { recursive: true });
  const scriptPath = path.join(runDir, `ego-${Date.now()}-${randomUUID().slice(0, 8)}.mjs`);
  await fsp.writeFile(scriptPath, script, 'utf8');
  const invocation = buildEgoInvocation(cliPath, scriptPath);

  try {
    const result = await new Promise((resolve, reject) => {
      execFile(
        invocation.command,
        invocation.args,
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal },
        (error, stdout, stderr) => {
          if (error) {
            reject(new EgoCliError(`ego-browser 执行失败：${error.message}`, {
              code: error.killed ? 'EGO_TIMEOUT' : 'EGO_EXEC_FAILED',
              exitCode: typeof error.code === 'number' ? error.code : null,
              stdout,
              stderr,
            }));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });

    // 坑：ego-browser 会把脚本自身的 console.log 输出写到 **stderr**（stdout 只留 CLI 自己的横幅/提示），
    // 所以两边都要试；同一 stream 内取最后一条可解析 JSON（前面的可能是我方诊断输出）。
    const payload = parseEgoPayload(result.stdout, result.stderr);
    if (!payload) {
      throw new EgoCliError('ego-browser 未返回可解析的 JSON', {
        code: 'EGO_BAD_OUTPUT',
        stdout: result.stdout,
        stderr: result.stderr,
      });
    }
    return payload;
  } finally {
    fsp.unlink(scriptPath).catch(() => {});
  }
}

/** 每个操作脚本都要的开场：按名字恢复 TaskSpace、按标签取 Page（必要时建 Page）。 */
function bootstrapSource(spaceName, pageLabel) {
  return `
const __SPACE = ${JSON.stringify(spaceName)};
const __LABEL = ${JSON.stringify(pageLabel)};

async function __attach() {
  let task;
  try {
    task = await taskSpace(__SPACE);
  } catch (error) {
    const spaces = await listTaskSpaces();
    const hit = spaces.find((space) => space.name === __SPACE);
    if (!hit) throw error;
    task = hit.ownership === 'user' ? await claimTaskSpace(hit.id) : await takeOverTaskSpace(hit.id);
  }
  const pages = await task.pages();
  const labels = pages.map((page) => page.label);
  const page = labels.includes(__LABEL) ? task.page(__LABEL) : await task.newPage();
  return { task, page };
}
`;
}

/**
 * 把五方法契约绑到 ego 后端。签名与 `createChromeSession` 对齐，可直接塞进 `deps.chrome`。
 */
export function createEgoSession(options = {}) {
  const {
    cliPath = resolveDefaultEgoCliPath(),
    doubaoUrl,
    spaceName = DEFAULT_EGO_SPACE_NAME,
    pageLabel = DEFAULT_EGO_PAGE_LABEL,
    runDir = path.join(os.tmpdir(), 'dsh-ego-scripts'),
    screenshotTimeoutMs = DEFAULT_EGO_SCREENSHOT_TIMEOUT_MS,
    evaluateTimeoutMs = 90000,
    runScript = runEgoScript,
    signal,
  } = options;

  let pageId = 0;
  let spaceId = 0;
  let pageUrl = '';

  const call = (body, extra = {}) => runScript(cliPath, body, { signal, runDir, ...extra });

  return {
    backend: 'ego',
    get pageId() {
      return pageId;
    },
    get spaceId() {
      return spaceId;
    },

    /** ego 没有 daemon：这里只做存在性 + 端到端探活（一次 nodejs 起停 ≈ 150ms）。 */
    async ensureDaemon() {
      if (!cliPath) {
        throw new EgoCliError('未找到 ego-browser CLI（可用 DSH_EGO_CLI_PATH 指定）', { code: 'EGO_CLI_MISSING' });
      }
      const payload = await call(`${bootstrapSource(spaceName, pageLabel)}
const { task } = await __attach();
console.log(JSON.stringify({ ok: true, spaceId: task.spaceId, spaceName: task.name }));
`, { timeoutMs: 30000 });
      spaceId = payload.spaceId || 0;
      return { running: true, service: 'ego', cliPath, spaceId, restarted: false };
    },

    async ensurePage() {
      const payload = await call(`${bootstrapSource(spaceName, pageLabel)}
const url = ${JSON.stringify(doubaoUrl || '')};
const { task, page } = await __attach();
let current = await page.url();
if (url && !current.startsWith(url)) {
  await page.goto(url);
  current = await page.url();
}
console.log(JSON.stringify({ ok: true, spaceId: task.spaceId, label: page.label, url: current, title: await page.title() }));
`, { timeoutMs: 60000 });
      pageId = payload.label || pageLabel;
      spaceId = payload.spaceId || spaceId;
      pageUrl = payload.url || '';
      return { pageId, spaceId, url: pageUrl, title: payload.title || '', label: pageId };
    },

    async evaluate(name, source, extra = {}) {
      if (!pageId) throw new EgoCliError('evaluate 之前必须先 ensurePage()', { code: 'EGO_NO_PAGE' });
      const payload = await call(`${bootstrapSource(spaceName, pageLabel)}
const { page } = await __attach();
const result = await page.evaluate(${JSON.stringify(String(source))});
console.log(JSON.stringify({ ok: true, result }));
`, { timeoutMs: extra.timeoutMs || evaluateTimeoutMs });
      return payload.result;
    },

    /**
     * 截图：后台空间没有合成帧，`Page.captureScreenshot` 会一直挂到 15s。
     * 这里用「子进程短超时」提前止损，失败返回 `{ skipped: true }` 而不是抛错。
     */
    async screenshot(filePath, extra = {}) {
      if (!pageId) throw new EgoCliError('screenshot 之前必须先 ensurePage()', { code: 'EGO_NO_PAGE' });
      try {
        return await call(`${bootstrapSource(spaceName, pageLabel)}
const { page } = await __attach();
const result = await page.screenshot({ path: ${JSON.stringify(String(filePath).replace(/\\/g, '/'))} });
console.log(JSON.stringify({ ok: true, path: result }));
`, { timeoutMs: extra.timeoutMs || screenshotTimeoutMs });
      } catch (error) {
        if (error?.code === 'EGO_TIMEOUT') {
          return { skipped: true, reason: 'ego-background-space-has-no-compositor', path: filePath };
        }
        throw error;
      }
    },

    /** 页面上下文的 fetch：自带 cookie，图片可直接 `saveAs` 落盘（不需要 Referer/UA 伪装）。 */
    async fetchImage(src, extra = {}) {
      const tmp = path.join(runDir, 'downloads', `ego-${Date.now()}-${randomUUID().slice(0, 8)}.bin`);
      const payload = await call(`${bootstrapSource(spaceName, pageLabel)}
const { page } = await __attach();
const response = await page.fetch(${JSON.stringify(String(src))}, { saveAs: ${JSON.stringify(tmp.replace(/\\/g, '/'))}, timeout: ${Number(extra.timeoutMs || 30000)} });
console.log(JSON.stringify({ ok: response.ok, status: response.status, url: response.url, headers: response.headers }));
`, { timeoutMs: (extra.timeoutMs || 30000) + 15000 });
      const bytes = await fsp.readFile(tmp);
      await fsp.unlink(tmp).catch(() => {});
      const headers = payload.headers || {};
      return {
        ok: Boolean(payload.ok),
        status: payload.status,
        url: payload.url,
        headers: { get: (name) => (headers ? headers[String(name).toLowerCase()] ?? headers[name] ?? null : null) },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        bytes,
      };
    },

    /**
     * 释放 TaskSpace（用户级规则：任务收尾必须 `finish({ keep: [] })`）。
     * 空间是本插件专用的一次性工作区，重建成本约 0.6s，留着只会让 ego 的空间列表越堆越长。
     */
    async finish(options = {}) {
      const keep = Array.isArray(options.keep) ? options.keep : [];
      const payload = await call(`${bootstrapSource(spaceName, pageLabel)}
const { task } = await __attach();
await task.finish({ keep: ${JSON.stringify(keep)} });
console.log(JSON.stringify({ ok: true, finished: true, spaceId: task.spaceId }));
`, { timeoutMs: 30000 });
      pageId = 0;
      return payload;
    },

    /** ego 的浏览器是用户自己的日常浏览器：没有 daemon 可停，`keepTab` 在这里是无操作。 */
    async stop() {
      return { stopped: false, reason: 'ego-space-persists' };
    },
  };
}

