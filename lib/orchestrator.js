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
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  MAX_IMAGES_LIMIT,
  POLL_BUDGET_RATIO,
  POLL_INTERVAL_MS,
  SUPPORTED_ASPECT_RATIOS,
} from './constants.js';
import { normalizeConfig } from './config.js';
import {
  COMPOSER_SELECTORS,
  SHELL_HARD_SELECTORS,
  describeContract,
  describeHardTarget,
  missingSelectors,
  softDegradations,
} from './contract.js';
import { createChromeSession } from './chrome-cli.js';
import { createEgoSession, resolveDefaultEgoCliPath } from './ego-cli.js';
import {
  buildCollectScript,
  buildComposerProbeScript,
  buildDomDumpScript,
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

/** 失败取证的文件名约定（鲁棒性 P2 / Layer 3）。 */
export const FAILURE_EVIDENCE_FILES = Object.freeze({
  dom: 'dom-<step>.html',
  pageUrl: 'page-url.txt',
  contract: 'contract.json',
});

/** 现场 DOM 单文件上限：2 MB（超过截断，避免巨型页面撑爆磁盘）。 */
export const DOM_DUMP_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * 只有这些模式失败时才值得把现场落盘（t8）。
 *
 * - `generate`：用户真正点了「生成」，失败现场是唯一可复现的证据。
 * - `status` / `open`：纯查询 / 导航模式，宿主会周期性轮询（每次轮询都新建 runDir，
 *   若也写三件套，`.runs/` 下会长期堆积 `doubao-status-*` 噪音，把真实失败现场淹没）。
 *   这两种模式失败时只把契约计数回给调用方（见 captureFailure 的 skipped 分支），不落盘。
 */
export const FAILURE_EVIDENCE_MODES = Object.freeze(['generate']);

/**
 * 把失败现场写进 runDir，供事后诊断（鲁棒性 P2 / Layer 3）。
 *
 * 产出三件套：
 *   - `dom-<step>.html`：`document.documentElement.outerHTML`（上限 2 MB）
 *   - `page-url.txt`：出事时所在 URL
 *   - `contract.json`：探针计数 + 步骤/原因，便于判断是改版还是步骤逻辑问题
 *
 * 本函数**永不抛错**：取证失败不能掩盖真正的业务错误。
 *
 * @param {{ chrome?: object, runDir: string, step: string, reason: string, pageUrl?: string, contract?: object }} params
 * @returns {Promise<{ runDir: string, step: string, reason: string, artifacts: Record<string, string|null> }>}
 */
export async function writeFailureEvidence(params = {}) {
  const { chrome, runDir } = params;
  const step = typeof params.step === 'string' && params.step ? params.step : 'unknown';
  const reason = typeof params.reason === 'string' && params.reason ? params.reason : 'unknown';
  const artifacts = { dom: null, pageUrl: null, contract: null };
  const base = { runDir: typeof runDir === 'string' ? runDir : '', step, reason, artifacts };
  if (!base.runDir) return base;

  let dump = null;
  try {
    if (chrome && typeof chrome.evaluate === 'function') {
      dump = await chrome.evaluate(
        `dom-dump-${step}`,
        buildDomDumpScript({ maxBytes: DOM_DUMP_LIMIT_BYTES }),
      );
    }
  } catch {
    dump = null;
  }

  try {
    await mkdir(base.runDir, { recursive: true });
  } catch {
    return base;
  }

  const domPath = path.join(base.runDir, `dom-${step}.html`);
  const html =
    dump && typeof dump.html === 'string'
      ? dump.html
      : '<!-- 取证失败：页面脚本没回传 DOM -->\n';
  try {
    await writeFile(domPath, html, 'utf8');
    artifacts.dom = domPath;
  } catch {
    artifacts.dom = null;
  }

  const pageUrlPath = path.join(base.runDir, 'page-url.txt');
  const pageUrl =
    (dump && typeof dump.pageUrl === 'string' && dump.pageUrl) ||
    (typeof params.pageUrl === 'string' ? params.pageUrl : '');
  try {
    await writeFile(pageUrlPath, pageUrl, 'utf8');
    artifacts.pageUrl = pageUrlPath;
  } catch {
    artifacts.pageUrl = null;
  }

  const contractPath = path.join(base.runDir, 'contract.json');
  const contractPayload = {
    step,
    reason,
    capturedAt: new Date().toISOString(),
    contract: params.contract && typeof params.contract === 'object' ? params.contract : null,
    pageUrl,
    pageTitle: dump && typeof dump.pageTitle === 'string' ? dump.pageTitle : '',
    htmlLength: dump && Number.isFinite(Number(dump.htmlLength)) ? Number(dump.htmlLength) : html.length,
    htmlTruncated: Boolean(dump && dump.truncated),
  };
  try {
    await writeFile(contractPath, `${JSON.stringify(contractPayload, null, 2)}\n`, 'utf8');
    artifacts.contract = contractPath;
  } catch {
    artifacts.contract = null;
  }

  return base;
}

/** 拼一句「第 N 步（动作）失败：原因」，替代过去 4 处笼统的改版文案。 */
function stepFailureMessage(stepLabel, reasonText) {
  return `${stepLabel}失败：${reasonText}`;
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
    const extra = { mode: normalizeMode(request.mode) };
    // 降级清单同时抬到结果顶层：调用方不必翻 details 就能知道「哪块能力退化了」
    if (Array.isArray(err?.details?.degraded)) extra.degraded = err.details.degraded;
    return failureResult(err, extra);
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

  // 步骤追踪：错误文案与失败取证都要知道「哪一步、为什么」
  let currentStep = '00-bootstrap';
  let currentContract = null;
  let page = null;
  let pageUrl = '';
  let pageTitle = '';
  let degraded = [];
  let failureEvidence = null;

  const captureFailure = async (step, reason) => {
    const evidenceStep = typeof step === 'string' && step ? step : currentStep;
    // t8：取证开关 —— 只有真实动作模式（generate）失败才落盘。
    // status / open 是宿主轮询与只读导航，失败只回契约计数，绝不写文件、也不建 runDir。
    if (!FAILURE_EVIDENCE_MODES.includes(mode)) {
      failureEvidence = {
        runDir,
        step: evidenceStep,
        reason,
        artifacts: { dom: null, pageUrl: null, contract: null },
        skipped: `mode:${mode}`,
        contract: currentContract,
      };
      return failureEvidence;
    }
    failureEvidence = await writeFailureEvidence({
      chrome,
      runDir,
      step: evidenceStep,
      reason,
      pageUrl: pageUrl || page?.url || cfg.doubaoUrl,
      contract: currentContract,
    });
    return failureEvidence;
  };

  try {
    await chrome.ensureDaemon();
  page = await chrome.ensurePage();

  // 步骤 0：等 SPA 挂载完，避免「登录按钮还没渲染」被误判成已登录
  await chrome.evaluate('00-wait-ready', buildWaitReadyScript());

  currentStep = '01-probe';
  const probe = await chrome.evaluate('01-probe', buildProbeScript({ openLogin: mode !== 'status' }));
  const probeData = probe && typeof probe === 'object' ? probe : {};
  pageUrl = typeof probeData.pageUrl === 'string' && probeData.pageUrl.length > 0
    ? probeData.pageUrl
    : page?.url || cfg.doubaoUrl;
  pageTitle = typeof probeData.pageTitle === 'string' ? probeData.pageTitle : '';
  const isLoggedIn = Boolean(probeData.isLoggedIn);
  currentContract = probeData.contract && typeof probeData.contract === 'object' ? probeData.contract : null;
  const contractReport = missingSelectors(probeData.contract, SHELL_HARD_SELECTORS);
  // soft 缺失只降级：workspace chip / 新建会话 / 技能按钮不见了，旧对话照样能发图
  degraded = softDegradations(probeData.contract);

  // hard 契约缺失才 fail-fast（当前 hard 集合只有输入框与发送按钮，骨架阶段为空集）
  if (isLoggedIn && probeData.contract && !contractReport.ok) {
    const missingLabels = contractReport.missing.map((id) => describeHardTarget(id)).join('、');
    throw new PaintError(
      'contract_changed',
      stepFailureMessage('第 1 步（页面探测）', `页面骨架缺少必需元素 ${missingLabels}，豆包可能改版`),
      {
        step: currentStep,
        reason: 'hard_missing',
        missingSelectors: contractReport.missing,
        contract: describeContract(),
        degraded,
      },
    );
  }

  if (mode === 'status') {
    return withCode('succeeded', 'ok', {
      mode,
      isLoggedIn,
      pageUrl,
      pageTitle,
      degraded,
      contract: currentContract,
      screenshots: [],
    });
  }

  if (!isLoggedIn) {
    await captureFailure('02-login', 'login_required');
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
      degraded,
      message: LOGIN_REQUIRED_MESSAGE,
      screenshots,
      evidence: failureEvidence,
    });
  }

  if (mode === 'open') {
    return withCode('succeeded', 'ok', {
      mode,
      isLoggedIn: true,
      pageUrl,
      pageTitle,
      degraded,
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
  currentStep = '04-skill';
  const skillResult = await chrome.evaluate('04-skill', buildSkillScript());
  if (skillResult && typeof skillResult === 'object' && skillResult.hasLoginModal) {
    await captureFailure('04-skill', 'login_required');
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
      degraded,
      message: SKILL_LOGIN_REQUIRED_MESSAGE,
      screenshots,
      evidence: failureEvidence,
    });
  }
  // 技能按钮是 soft 契约：点不到就降级（靠普通对话也能生图），并记进 degraded
  if (skillResult && typeof skillResult === 'object' && skillResult.ok === false) {
    degraded = degraded.includes('skillButton') ? degraded : [...degraded, 'skillButton'];
  }

  // E7.5：对话打开后复查输入区——骨架在 ≠ 输入框已渲染（首页引导态没有 .ProseMirror）
  // 点「新对话」可能换执行上下文，所以重试放在这一层，每次都重新 evaluate
  // 步骤名统一记成 05-input：定位输入框与写入提示词是同一步的上下半段，
  // 失败取证因此落在 dom-05-input.html（P2 的可证伪定义）。
  currentStep = '05-input';
  let composerProbe = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const probeStep = await chrome.evaluate('05b-composer', buildComposerProbeScript());
    if (!probeStep || typeof probeStep !== 'object' || !probeStep.contract) {
      composerProbe = null; // 桩未回传统计（测试/旧脚本）——不据此判失败
      break;
    }
    composerProbe = probeStep;
    currentContract = probeStep.contract;
    if (probeStep.ok) break;
    await sleep(400, deps.signal);
  }
  if (composerProbe && !composerProbe.ok) {
    const composerReport = missingSelectors(composerProbe.contract, COMPOSER_SELECTORS);
    const missingLabels = composerReport.missing.map((id) => describeHardTarget(id)).join('、');
    throw new PaintError(
      'contract_changed',
      stepFailureMessage(
        '第 3 步（写入提示词）',
        `${missingLabels || '输入框'}未找到（契约 inputEditor 未命中，豆包可能改版）`,
      ),
      {
        step: currentStep,
        reason: 'hard_missing',
        missingSelectors: composerReport.missing,
        contract: describeContract(),
        degraded,
      },
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
    // 输入框整个找不到 → locate_failed；找到了但读回不一致 → edit_readback_mismatch
    const editorMissing = !inputResult || inputResult.reason === 'editor_not_found';
    const code = editorMissing ? 'locate_failed' : 'edit_readback_mismatch';
    const reasonText = editorMissing
      ? '输入框未找到（页面脚本没定位到可编辑区域）'
      : `提示词写入后回读不一致（写入 ${Number(inputResult.textLength) || 0} 字，期望 ${
          formattedPrompt.length
        } 字）`;
    throw new PaintError(code, stepFailureMessage('第 3 步（写入提示词）', reasonText), {
      step: currentStep,
      reason: code,
      result: inputResult,
      degraded,
    });
  }

  // E9：发送
  currentStep = '06-send';
  const sendResult = await chrome.evaluate('06-send', buildSendScript());
  if (!sendResult || sendResult.ok !== true) {
    const sendReason = sendResult?.reason === 'neither_button_nor_editor'
      ? '发送按钮不可用，回车兜底也未生效'
      : '发送按钮不可用';
    throw new PaintError('send_not_ready', stepFailureMessage('第 4 步（提交指令）', sendReason), {
      step: currentStep,
      reason: 'send_not_ready',
      result: sendResult,
      degraded,
    });
  }

  // E10：轮询取图
  currentStep = '07-collect';
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
    await captureFailure('07-collect', 'login_required');
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
      degraded,
      message: POLL_LOGIN_REQUIRED_MESSAGE,
      screenshots,
      evidence: failureEvidence,
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
    await captureFailure('07-collect', 'no_image');
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
      degraded,
      screenshots,
      message: TIMEOUT_MESSAGE,
      tailText,
      evidence: failureEvidence,
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
    attachImages: cfg.attachImages !== false,
    prompt: request.prompt,
    formattedPrompt,
    aspectRatio,
    style,
    workspace: typeof request.workspace === 'string' && request.workspace ? request.workspace : cwd,
    sessionId: request.sessionId,
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
    degraded,
    screenshots,
    requestId,
  };

  if (savedCount === 0) {
    await captureFailure('08-download', 'download_failed');
    return withCode('failed', 'download_failed', { ...shared, evidence: failureEvidence });
  }
  if (failedCount > 0) {
    await captureFailure('08-download', 'partial');
    return withCode('partial', 'partial', { ...shared, evidence: failureEvidence });
  }
  return withCode('succeeded', 'ok', shared);
  } catch (err) {
    // P2：任何抛出的失败都先把现场写进 runDir，只把 {runDir, step, reason} 带回结果
    const stepId = typeof err?.details?.step === 'string' ? err.details.step : currentStep;
    const reason =
      typeof err?.details?.reason === 'string' && err.details.reason
        ? err.details.reason
        : typeof err?.code === 'string'
          ? err.code
          : 'unknown';
    const captured = await captureFailure(stepId, reason);
    if (err instanceof PaintError) {
      err.details = { ...(err.details || {}), ...captured, degraded };
      throw err;
    }
    // 非 PaintError（浏览器脚本抛错等）：无论查询模式还是动作模式，都把取证句柄与
    // 降级清单挂回错误对象，调用方才能拿到 step / runDir；冻结对象上失败则静默跳过。
    if (captured && err && typeof err === 'object') {
      try {
        err.details = { ...(err.details || {}), ...captured, degraded };
      } catch {
        // 冻结错误对象时忽略：取证信息只是附加诊断
      }
    }
    throw err;
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

