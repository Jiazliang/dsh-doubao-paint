/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 动作编排器
 *
 * 与参考实现 `executeDoubaoAction` 的差异只在「浏览器后端」：参考实现把 E1–E11 压进**一段**
 * Playwright 脚本由 tabbit-cli 一次性执行；本插件拆成 **chrome-devtools CLI 的多次调用**
 * （start/status → list_pages/new_page → evaluate_script × N → take_screenshot），
 * 语义、状态集合、跳出条件、落盘命名规则全部照搬。
 *
 * 浏览器侧只通过 `deps.chrome` 这 5 个方法交互（见 `chrome-cli.createChromeSession`），
 * 因此本模块可以完全脱离真实浏览器做单元测试。
 *
 * @module dsh-doubao-paint/orchestrator
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  MAX_IMAGES_LIMIT,
  POLL_BUDGET_RATIO,
  POLL_INTERVAL_MS,
  SUPPORTED_ASPECT_RATIOS,
} from './constants.js';
import { normalizeConfig } from './config.js';
import { COMPOSER_SELECTORS, describeContract, missingSelectors } from './contract.js';
import { createChromeSession } from './chrome-cli.js';
import { createEgoSession, resolveDefaultEgoCliPath } from './ego-cli.js';
import {
  buildCollectScript,
  buildComposerProbeScript,
  buildInputScript,
  buildNewConversationScript,
  buildProbeScript,
  buildSendScript,
  buildSkillScript,
  buildSwitchWorkModeScript,
  buildTailTextScript,
  buildWaitReadyScript,
  pickImages,
  shouldStopPolling,
} from './doubao-page.js';
import {
  buildDoubaoPrompt,
  resolveOutputDirectory,
  sanitizeFilenamePrefix,
} from './prompt.js';
import { downloadImages } from './download.js';
import {
  PAINT_ERROR_MESSAGES,
  PaintError,
  failureResult,
  withCode,
} from './errors.js';

export const LOGIN_REQUIRED_MESSAGE =
  '豆包网页版尚未登录。已在 Chrome 中打开豆包登录窗口，请在浏览器里完成扫码或手机号登录后重试。';
export const SKILL_LOGIN_REQUIRED_MESSAGE =
  '触发豆包「图像生成」技能时被要求登录。已弹出登录窗口，请在 Chrome 中完成登录后重试。';
export const POLL_LOGIN_REQUIRED_MESSAGE =
  '提交生图指令后豆包要求登录。请在 Chrome 的豆包标签页扫码登录后重试。';
export const TIMEOUT_MESSAGE =
  '等待超时：豆包页面未在限定时间内产出符合条件的高清图。可调大 timeoutMs 或检查豆包页面状态。';
export const OPEN_MESSAGE = '豆包网页版已打开且处于已登录状态。';

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function clampMaxImages(value) {
  const num = Number(value);
  const base = Number.isFinite(num) ? num : 4;
  return Math.max(1, Math.min(MAX_IMAGES_LIMIT, Math.round(base)));
}

function normalizeMode(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return text === 'status' || text === 'open' || text === 'generate' ? text : 'generate';
}

function makeRequestId(mode) {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '-')
    .slice(0, 19);
  return `doubao-${mode}-${stamp}-${randomUUID().slice(0, 6)}`;
}

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function collectBaselineUrls(probeImages) {
  if (!Array.isArray(probeImages)) return [];
  return probeImages
    .map((item) => (item && typeof item.src === 'string' ? item.src : ''))
    .filter((src) => src.length > 0);
}

/**
 * 安全读取服务：Cordis 的 scoped ctx 在未 inject 某服务时，属性访问会抛错，
 * 因此先走 `ctx.get(name)`，再兜底属性访问，两条路径都吞异常。
 */
export function readService(ctx, name) {
  if (!ctx) return undefined;
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(name);
      if (value) return value;
    }
  } catch {
    // 未 inject 该服务时 ctx.get 同样可能拒绝
  }
  try {
    return ctx[name] ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 附加截图到当前工具调用（失败时降级为纯路径对象，与参考实现一致）。
 */
async function attachScreenshots(paths, ctx) {
  const attachmentsService = readService(ctx, 'attachments');
  const out = [];
  for (const filePath of paths) {
    let attached;
    if (attachmentsService && typeof attachmentsService.saveImage === 'function') {
      try {
        const { readFile } = await import('node:fs/promises');
        const buffer = await readFile(filePath);
        attached = await attachmentsService.saveImage({
          data: new Uint8Array(buffer),
          mediaType: 'image/png',
        });
      } catch {
        attached = undefined;
      }
    }
    out.push(attached ? { path: filePath, attachment: attached } : { path: filePath });
  }
  return out;
}

/**
 * 执行一次豆包网页生图动作。
 *
 * @param {{
 *   mode?: 'generate'|'status'|'open',
 *   prompt?: string,
 *   aspectRatio?: string,
 *   style?: string,
 *   negativePrompt?: string,
 *   outputDir?: string,
 *   filenamePrefix?: string,
 *   maxImages?: number,
 *   newConversation?: boolean,
 *   keepTab?: boolean,
 *   config?: object
 * }} request
 * @param {{
 *   ctx?: any,
 *   signal?: AbortSignal,
 *   history?: Array<any>,
 *   chrome?: object,
 *   fetchImage?: Function,
 *   cwd?: string
 * }} [deps]
 * @returns {Promise<object>}
 */
/**
 * 后端选择：`ego` 优先（用户 2026-11-07 决策），探测不到 ego 就回落 chrome。
 *
 * - `browserBackend: 'ego'`（默认）：用 ego lite 的 `Profile 1`（已登录态复用、免扫码）；
 *   CLI 探测不到时**静默回落** chrome，避免「装了插件却什么都跑不起来」。
 * - `browserBackend: 'chrome'`：强制走 chrome-devtools daemon。
 * - `browserBackend: 'auto'`：与 'ego' 同义（探测 + 回落）。
 */
export function resolveBrowserBackend(config = {}, resolveEgo = resolveDefaultEgoCliPath) {
  const requested = String(config.browserBackend || 'ego').toLowerCase();
  if (requested === 'chrome') return 'chrome';
  const egoCliPath = config.egoCliPath || (typeof resolveEgo === 'function' ? resolveEgo() : '');
  return egoCliPath ? 'ego' : 'chrome';
}

/** 按配置创建浏览器会话；两个后端的方法面同构（多一个 ego 独有的 `finish`）。 */
export function createBrowserSession(config = {}, options = {}) {
  const backend = resolveBrowserBackend(config);
  if (backend === 'ego') {
    return createEgoSession({
      cliPath: config.egoCliPath || resolveDefaultEgoCliPath(),
      doubaoUrl: config.doubaoUrl,
      runDir: options.runDir ? path.join(options.runDir, 'ego') : undefined,
      signal: options.signal,
    });
  }
  return createChromeSession({
    cliPath: config.chromeCliPath,
    doubaoUrl: config.doubaoUrl,
    headless: false,
    runDir: options.runDir,
    signal: options.signal,
  });
}
/**
 * 单飞锁：同一进程内只允许一个浏览器动作在跑。
 *
 * 浏览器侧是**进程级单例**（chrome daemon）/ **任务空间单例**（ego TaskSpace），
 * 两次 generate 并发会互相抢标签页、把 baseline 弄脏。并发调用直接返回 `busy`，
 * 不做排队（排队会让排队者默默等几十秒，体验更差）。
 */
let activeRun = null;

export async function executeDoubaoAction(request = {}, deps = {}) {
  if (activeRun && !request.skipLock) {
    return withCode('busy', 'busy', {
      pageUrl: '',
      pageTitle: '',
      screenshots: [],
      activeRequestId: activeRun.requestId,
      activeMode: activeRun.mode,
      activeSince: activeRun.startedAt,
    });
  }
  const previous = activeRun;
  activeRun = {
    requestId: typeof request.requestId === 'string' ? request.requestId : '',
    mode: normalizeMode(request.mode),
    startedAt: new Date().toISOString(),
  };
  try {
    return await runDoubaoAction(request, deps);
  } catch (err) {
    return failureResult(err, { mode: normalizeMode(request.mode) });
  } finally {
    activeRun = previous;
  }
}

async function runDoubaoAction(request = {}, deps = {}) {
  const cfg = normalizeConfig(request.config && typeof request.config === 'object' ? request.config : {});
  const mode = normalizeMode(request.mode);
  const cwd = typeof deps.cwd === 'string' && deps.cwd.length > 0 ? deps.cwd : process.cwd();

  const aspectRatio =
    typeof request.aspectRatio === 'string' &&
    SUPPORTED_ASPECT_RATIOS.includes(request.aspectRatio.trim())
      ? request.aspectRatio.trim()
      : cfg.defaultAspectRatio;
  const style =
    typeof request.style === 'string' && request.style.trim().length > 0
      ? request.style.trim()
      : cfg.defaultStyle;
  const negativePrompt =
    typeof request.negativePrompt === 'string' ? request.negativePrompt.trim() : '';
  const maxImages = clampMaxImages(request.maxImages);
  const newConversation =
    request.newConversation === undefined ? true : Boolean(request.newConversation);
  const keepTab = request.keepTab === undefined ? cfg.keepTab : Boolean(request.keepTab);
  const outputDir = resolveOutputDirectory(request.outputDir || cfg.outputDir, cwd);
  const prefix = sanitizeFilenamePrefix(request.filenamePrefix || 'doubao');

  const formattedPrompt =
    mode === 'generate'
      ? buildDoubaoPrompt(String(request.prompt || ''), { aspectRatio, style, negativePrompt })
      : '';

  const requestId = makeRequestId(mode);
  const runDir = path.join(outputDir, '.runs', requestId);

  const chrome =
    deps.chrome ||
    createBrowserSession(cfg, { runDir, signal: deps.signal });

  try {
    await chrome.ensureDaemon();
  const page = await chrome.ensurePage();

  // 步骤 0：等 SPA 挂载完，避免「登录按钮还没渲染」被误判成已登录
  await chrome.evaluate('00-wait-ready', buildWaitReadyScript());

  const probe = await chrome.evaluate('01-probe', buildProbeScript({ openLogin: mode !== 'status' }));
  const probeData = probe && typeof probe === 'object' ? probe : {};
  let pageUrl = typeof probeData.pageUrl === 'string' && probeData.pageUrl.length > 0
    ? probeData.pageUrl
    : page?.url || cfg.doubaoUrl;
  let pageTitle = typeof probeData.pageTitle === 'string' ? probeData.pageTitle : '';
  const isLoggedIn = Boolean(probeData.isLoggedIn);
  const contractReport = missingSelectors(probeData.contract);

  // 已登录却认不出页面骨架：说明豆包改版了，报 contract_changed 而不是等超时
  // （探针没回传统计——例如旧版脚本或测试桩——时不据此判失败）
  if (isLoggedIn && probeData.contract && !contractReport.ok) {
    throw new PaintError('contract_changed', '豆包页面结构与插件契约不一致，请升级插件或到 issue 反馈', {
      missingSelectors: contractReport.missing,
      contract: describeContract(),
    });
  }

  if (mode === 'status') {
    return withCode('succeeded', 'ok', {
      mode,
      isLoggedIn,
      pageUrl,
      pageTitle,
      screenshots: [],
    });
  }

  if (!isLoggedIn) {
    const loginShot = path.join(runDir, 'login.png');
    try {
      await chrome.screenshot(loginShot);
    } catch {
      // 截图失败不影响登录态判定
    }
    const screenshots = await attachScreenshots([loginShot], deps.ctx);
    return withCode('login_required', 'login_required', {
      mode,
      isLoggedIn: false,
      requiresLogin: true,
      pageUrl,
      pageTitle,
      message: LOGIN_REQUIRED_MESSAGE,
      screenshots,
    });
  }

  if (mode === 'open') {
    return withCode('succeeded', 'ok', {
      mode,
      isLoggedIn: true,
      pageUrl,
      pageTitle,
      message: OPEN_MESSAGE,
      screenshots: [],
    });
  }

  // E5：从「豆包工作」慢速模式切回标准模式
  if (probeData.workMode) {
    await chrome.evaluate('02-switch-work-mode', buildSwitchWorkModeScript());
  }

  // E6：开新对话，避免历史图片污染 baseline
  if (newConversation) {
    await chrome.evaluate('03-new-conversation', buildNewConversationScript());
  }

  // E7：点开「图像生成」技能
  const skillResult = await chrome.evaluate('04-skill', buildSkillScript());
  if (skillResult && typeof skillResult === 'object' && skillResult.hasLoginModal) {
    const loginShot = path.join(runDir, 'login.png');
    try {
      await chrome.screenshot(loginShot);
    } catch {
      // ignore
    }
    const screenshots = await attachScreenshots([loginShot], deps.ctx);
    return withCode('login_required', 'login_required', {
      mode,
      isLoggedIn: false,
      requiresLogin: true,
      pageUrl,
      pageTitle,
      message: SKILL_LOGIN_REQUIRED_MESSAGE,
      screenshots,
    });
  }

  // E7.5：对话打开后复查输入区——骨架在 ≠ 输入框已渲染（首页引导态没有 .ProseMirror）
  // 点「新对话」可能换执行上下文，所以重试放在这一层，每次都重新 evaluate
  let composerProbe = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const probeStep = await chrome.evaluate('05b-composer', buildComposerProbeScript());
    if (!probeStep || typeof probeStep !== 'object' || !probeStep.contract) {
      composerProbe = null; // 桩未回传统计（测试/旧脚本）——不据此判失败
      break;
    }
    composerProbe = probeStep;
    if (probeStep.ok) break;
    await sleep(400, deps.signal);
  }
  if (composerProbe && !composerProbe.ok) {
    const composerReport = missingSelectors(composerProbe.contract, COMPOSER_SELECTORS);
    throw new PaintError(
      'contract_changed',
      '豆包对话输入区结构与插件契约不一致，请升级插件或到 issue 反馈',
      { missingSelectors: composerReport.missing, contract: describeContract() },
    );
  }

  // E8：把格式化后的指令写进 ProseMirror 编辑器
  // 豆包会在路由切换后重建编辑器节点；上一次 evaluate 若落在被丢弃的上下文里，
  // insertText 会「成功」但读回是空。这里重跑（每次 evaluate 都是新上下文）直到文本对上。
  let inputResult = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    inputResult = await chrome.evaluate('05-input', buildInputScript({ prompt: formattedPrompt }));
    if (inputResult && inputResult.ok === true) break;
    await sleep(600, deps.signal);
  }
  if (!inputResult || inputResult.ok !== true) {
    throw new PaintError(
      'contract_changed',
      `无法把提示词写入豆包输入框（${JSON.stringify(inputResult).slice(0, 300)}）`,
      { step: '05-input', result: inputResult },
    );
  }

  // E9：发送
  const sendResult = await chrome.evaluate('06-send', buildSendScript());
  if (!sendResult || sendResult.ok !== true) {
    throw new PaintError(
      'contract_changed',
      `无法提交生图指令（${JSON.stringify(sendResult).slice(0, 300)}）`,
      { step: '06-send', result: sendResult },
    );
  }

  // E10：轮询取图
  const baselineUrls = collectBaselineUrls(probeData.images);
  // 轮询只吃预算的 POLL_BUDGET_RATIO，剩余预算留给截图/下载/附件注入
  const deadline = Date.now() + Math.floor(cfg.timeoutMs * POLL_BUDGET_RATIO);
  let candidates = [];
  let stableRounds = 0;
  let lastCount = -1;
  let round = 0;
  let pollLoginModal = false;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, deps.signal);
    round += 1;
    const collected = await chrome.evaluate(
      `07-collect-${String(round).padStart(2, '0')}`,
      buildCollectScript(),
    );
    if (collected && typeof collected === 'object') {
      if (collected.hasLoginModal) {
        pollLoginModal = true;
        break;
      }
      if (typeof collected.pageUrl === 'string' && collected.pageUrl.length > 0) {
        pageUrl = collected.pageUrl;
      }
    }
    candidates = pickImages(collected?.images, baselineUrls, maxImages);
    if (candidates.length === lastCount) stableRounds += 1;
    else stableRounds = 0;
    lastCount = candidates.length;
    if (shouldStopPolling(candidates, { stableRounds, maxImages })) break;
  }

  if (pollLoginModal) {
    const loginShot = path.join(runDir, 'login.png');
    try {
      await chrome.screenshot(loginShot);
    } catch {
      // ignore
    }
    const screenshots = await attachScreenshots([loginShot], deps.ctx);
    return withCode('login_required', 'login_required', {
      mode,
      isLoggedIn: false,
      requiresLogin: true,
      pageUrl,
      pageTitle,
      message: POLL_LOGIN_REQUIRED_MESSAGE,
      screenshots,
    });
  }

  const generationShot = path.join(runDir, 'generation.png');
  try {
    await chrome.screenshot(generationShot);
  } catch {
    // 截图失败不阻断落盘
  }

  // keepTab=false：成功后收掉 daemon（Chrome 进程随之退出）
  if (!keepTab) {
    try {
      await chrome.stop();
    } catch {
      // 收尾失败不影响主流程
    }
  }

  if (candidates.length === 0) {
    let tailText = '';
    try {
      const tail = await chrome.evaluate('08-tail-text', buildTailTextScript());
      tailText = typeof tail?.tailText === 'string' ? tail.tailText : '';
    } catch {
      tailText = '';
    }
    const screenshots = await attachScreenshots([generationShot], deps.ctx);
    return withCode('timeout_or_no_image', 'no_image', {
      mode,
      isLoggedIn: true,
      pageUrl,
      pageTitle,
      prompt: request.prompt,
      formattedPrompt,
      aspectRatio,
      style,
      outputDir,
      imageCount: 0,
      images: [],
      screenshots,
      message: TIMEOUT_MESSAGE,
      tailText,
    });
  }

  const screenshots = await attachScreenshots([generationShot], deps.ctx);
  const timestamp = buildTimestamp();
  const images = await downloadImages(candidates, {
    outputDir,
    prefix,
    timestamp,
    history: deps.history,
    attachmentsService: deps.attachments ?? readService(deps.ctx, 'attachments'),
    prompt: request.prompt,
    formattedPrompt,
    aspectRatio,
    style,
    fetchImage: deps.fetchImage,
    signal: deps.signal,
  });

  const savedCount = images.filter((item) => item && item.filePath).length;
  const failedCount = images.length - savedCount;
  const shared = {
    mode,
    isLoggedIn: true,
    pageUrl,
    pageTitle,
    prompt: request.prompt,
    formattedPrompt,
    aspectRatio,
    style,
    outputDir,
    imageCount: savedCount,
    images,
    screenshots,
    requestId,
  };

  if (savedCount === 0) {
    return withCode('failed', 'download_failed', shared);
  }
  if (failedCount > 0) {
    return withCode('partial', 'partial', shared);
  }
  return withCode('succeeded', 'ok', shared);
  } finally {
    // ego 后端：空间是本插件专用的临时工作区，操作结束就释放（用户级规则：finish({ keep: [] })）
    if (typeof chrome.finish === 'function') {
      try {
        await chrome.finish({ keep: [] });
      } catch {
        // 释放失败不影响本轮结果
      }
    }
  }
}

