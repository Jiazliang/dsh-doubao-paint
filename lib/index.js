/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 插件入口
 *
 * 本插件把「操控豆包网页版生成图片」的完整流程做成本机工具：
 * 由 **chrome-devtools CLI/daemon** 驱动一个持久的独立 Chrome profile（首次人工扫码登录一次），
 * 自动完成「新对话 → 选技能 → 填提示词 → 发送 → 轮询取图 → 下载落盘 → 附件注入」。
 *
 * 设计来源：`dsh-doubao-image`（Tabbit 版）的 1:1 功能复刻，浏览器驱动层换成 ego lite / chrome-devtools。
 *
 * @module dsh-doubao-paint
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zhLocale from '../locale/zh.json' with { type: 'json' };
import enLocale from '../locale/en.json' with { type: 'json' };
import { DEFAULT_ASPECT_RATIO, DEFAULT_DOUBAO_URL, DEFAULT_OUTPUT_DIR, DEFAULT_STYLE, DEFAULT_SYSTEM_PROMPT_TEXT, DEFAULT_TIMEOUT_MS, DEFAULT_BROWSER_BACKEND, BROWSER_BACKENDS, PLUGIN_VERSION, IMAGE_MEDIA_BY_EXT, resolveToolTimeoutMs, STYLE_PRESETS, SUPPORTED_ASPECT_RATIOS } from './constants.js';
import { Config, normalizeConfig } from './config.js';
import { PAINT_ERROR_CODES, PAINT_ERROR_MESSAGES, PAINT_ERROR_MESSAGES_EN, PaintError, classifyError, errorMessage, failureResult, withCode } from './errors.js';
import { buildDoubaoPrompt, extractDoubaoImageKey, resolveOutputDirectory, resolveStyleHint } from './prompt.js';
import { buildCollectScript, buildInputScript, buildNewConversationScript, buildProbeScript, buildSendScript, buildSkillScript, buildSwitchWorkModeScript, buildTailTextScript, filterGeneratedImageCandidates, pickImages } from './doubao-page.js';
import { createBrowserSession, executeDoubaoAction, readService, resolveBrowserBackend } from './orchestrator.js';
import { groupHistoryByWorkspace, loadHistory, mergeHistory, pruneRunDirs, removeHistoryRecords, repairFallbackWorkspace, saveHistory } from './history.js';
import { buildHealthReport, inspectOutputDir } from './health.js';
import { normalizePaintRequest, submitPaintRequest } from './entry.js';
import { renderToolResult } from './render.js';
import { PAINT_SKILL, PAINT_SKILL_CONTENT, registerPaintSkill } from './skill.js';

async function importHostPackage(specifier) {
  try {
    return await import(specifier);
  } catch {
    const anchors = [
      process.argv[1],
      typeof process.resourcesPath === 'string'
        ? path.join(process.resourcesPath, 'app.asar', 'dsh', 'package.json')
        : undefined,
    ].filter((item) => typeof item === 'string' && item.length > 0);

    for (const anchor of anchors) {
      try {
        const req = createRequire(anchor);
        const resolved = req.resolve(specifier);
        return await import(pathToFileURL(resolved).href);
      } catch {
        // try next anchor
      }
    }
    return null;
  }
}

/**
 * 读取会话的工作区（绝对路径）。
 *
 * 宿主里 `workingDirectory` 服务是唯一真源（含 cd 变更后的投影值）；拿不到时
 * 退回 session header 的 `cwd`，再退回 `session.cwd`，都没有就返回空串。
 */
export function resolveSessionWorkspace(ctx, session) {
  if (!session) return '';
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('workingDirectory') : undefined;
    if (service && typeof service.get === 'function') {
      const value = service.get(session);
      if (typeof value === 'string' && value) return value;
    }
  } catch {
    // 服务不可用（离线测试的假 ctx）时走下面的兜底
  }
  const headerCwd = session?.header?.cwd;
  if (typeof headerCwd === 'string' && headerCwd) return headerCwd;
  return typeof session?.cwd === 'string' ? session.cwd : '';
}

/**
 * 按 sessionId 反查会话的工作区（绝对路径）。
 *
 * 面板通道只能拿到 sessionId：宿主下发给 `conversation.input.dock` 的 session 是
 * SessionSnapshot（只含 sessionId/pending 等，没有 cwd），客户端算不出工作区。
 * 会话 header 里记录的 cwd 是宿主权威值（见 SessionHeader.cwd），因此服务端用
 * `sessionPersistence.stat(id)` 反查。会话已删除 / 服务不可用时返回空串。
 */
export async function resolveWorkspaceBySessionId(ctx, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return '';
  try {
    const service = readService(ctx, 'sessionPersistence');
    if (service && typeof service.stat === 'function') {
      const snapshot = await service.stat(id);
      const cwd = snapshot?.header?.cwd;
      if (typeof cwd === 'string' && cwd.trim()) return cwd.trim();
    }
  } catch {
    // 会话已删除 / 持久化服务未挂载（离线测试的假 ctx）时回落请求自带的值
  }
  return '';
}

/**
 * 决定一次面板/工具请求的工作区归属。
 *
 * 顺序：请求显式给出的 workspace（会话内 cd 后前端能拿到新路径时以它为准）→
 * 按 sessionId 反查的会话 header.cwd（面板通道的权威来源）→ 空串。
 *
 * @param {object} ctx 插件上下文
 * @param {{workspace?: string, sessionId?: string}} [input]
 * @returns {Promise<{workspace: string, source: 'request'|'session'|'none'}>}
 */
export async function resolveRequestWorkspace(ctx, input = {}) {
  const claimed = typeof input.workspace === 'string' ? input.workspace.trim() : '';
  if (claimed) return { workspace: claimed, source: 'request' };
  const fromSession = await resolveWorkspaceBySessionId(ctx, input.sessionId);
  if (fromSession) return { workspace: fromSession, source: 'session' };
  return { workspace: '', source: 'none' };
}

function fallbackDefineTool(options) {
  const rawParams = options?.parameters || {};
  const properties = {};
  const required = [];
  for (const [key, spec] of Object.entries(rawParams)) {
    if (!spec || typeof spec !== 'object') continue;
    const { required: isReq, ...rest } = spec;
    properties[key] = { ...rest };
    if (isReq === true) required.push(key);
  }
  const parameters = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
  const outSchema =
    options?.output?.schema?.type === 'json'
      ? { type: 'object', additionalProperties: true }
      : options?.output?.schema || { type: 'object', additionalProperties: true };
  return {
    ...options,
    parameters,
    output: {
      ...options?.output,
      schema: outSchema,
    },
  };
}

const dshToolsMod = await importHostPackage('@deepseek-ai/dsh-tools');
const defineTool =
  typeof dshToolsMod?.defineTool === 'function' ? dshToolsMod.defineTool : fallbackDefineTool;

export const name = 'doubao-paint';
export const inject = ['tools', 'attachments', 'skills'];

// 生成历史在模块层共享：宿主在依赖服务变化时可能重复调用 apply，
// 若历史挂在 apply 闭包里，/status 与 /generate 会各自持有不同数组。
const sharedHistory = [];

export {
  resolveToolTimeoutMs,
  buildHealthReport,
  inspectOutputDir,
  Config,
  normalizeConfig,
  resolveStyleHint,
  buildDoubaoPrompt,
  extractDoubaoImageKey,
  filterGeneratedImageCandidates,
  pickImages,
  buildProbeScript,
  buildSwitchWorkModeScript,
  buildNewConversationScript,
  buildSkillScript,
  buildInputScript,
  buildSendScript,
  buildCollectScript,
  buildTailTextScript,
  resolveOutputDirectory,
  executeDoubaoAction,
  createBrowserSession,
  resolveBrowserBackend,
  SUPPORTED_ASPECT_RATIOS,
  STYLE_PRESETS,
  DEFAULT_BROWSER_BACKEND,
  BROWSER_BACKENDS,
  PLUGIN_VERSION,
  PAINT_ERROR_CODES,
  PAINT_ERROR_MESSAGES,
  PAINT_ERROR_MESSAGES_EN,
  PaintError,
  classifyError,
  errorMessage,
  failureResult,
  withCode,
  DEFAULT_DOUBAO_URL,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_STYLE,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_TIMEOUT_MS,
  // v1.1.0：统一入口 / 三适配器 / 命令 / 技能
  normalizePaintRequest,
  submitPaintRequest,
  renderToolResult,
  PAINT_SKILL,
  PAINT_SKILL_CONTENT,
  registerPaintSkill,
  // v1.2.0：命令转交模型（relay）与工具图卡所需的载荷
};

/**
 * 将工具执行结果渲染为 DSH 内容块（文本说明 + 图像附件块）。
 */
/**
 * 工具渲染器：委托给 lib/render.js（同一份适配器实现，见 v1.1.0 统一入口）。
 * 保留这个导出名是为了不破坏既有调用点与测试。
 */
export function renderDoubaoToolOutput(value) {
  return renderToolResult(value);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** 判断 `filePath` 是否确实位于 `directory` 之内（含同路径）；符号链接不走这里。 */
export function isInsideDirectory(filePath, directory) {
  const resolvedFile = path.resolve(filePath);
  const resolvedDir = path.resolve(directory);
  const relative = path.relative(resolvedDir, resolvedFile);
  if (!relative) return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * 把 `/doubao-paint/file` 的查询参数解析成一个**可服务**的绝对路径。
 *
 * 只接受两种来源：
 * - `id=<attachmentId|filename>`：必须命中本次进程内 history 里的记录；
 * - `path=<绝对路径>`：必须命中 history 记录，或位于配置的 outputDir 之内。
 *
 * 任何其它路径一律 403 —— 该路由不能用来读取机器上的任意图片文件。
 */
export function resolveImageRequest(params, { history = [], outputDir } = {}) {
  const id = (params.get('id') || '').trim();
  const rawPath = (params.get('path') || '').trim();

  if (!id && !rawPath) {
    return { status: 400, error: 'Missing id or path' };
  }

  if (id) {
    const record = history.find(
      (item) => item?.attachment?.attachmentId === id || item?.filename === id,
    );
    if (!record || typeof record.filePath !== 'string' || !record.filePath) {
      return { status: 404, error: 'Unknown image id' };
    }
    return { filePath: path.resolve(record.filePath) };
  }

  if (!path.isAbsolute(rawPath)) {
    return { status: 400, error: 'Invalid file path' };
  }

  const resolved = path.resolve(rawPath);
  const recorded = history.some(
    (item) => typeof item?.filePath === 'string' && path.resolve(item.filePath) === resolved,
  );
  if (!recorded && !(outputDir && isInsideDirectory(resolved, outputDir))) {
    return { status: 403, error: 'Path is outside the configured output directory' };
  }
  return { filePath: resolved };
}

/**
 * 挂载 `dsh-doubao-paint` 插件。
 */
export function apply(ctx, config) {
  const initialConfig = normalizeConfig(config);
  // 工具层超时统一由配置预算换算（单一真源：lib/constants.js）
  const toolTimeoutMs = resolveToolTimeoutMs(initialConfig.timeoutMs);
  const statusTimeoutMs = Math.max(60000, Math.round(initialConfig.timeoutMs / 2) + 20000);
  const attachmentsService = readService(ctx, 'attachments');
  const localeService = typeof ctx?.get === 'function' ? ctx.get('locale') : ctx?.locale;
  if (localeService && typeof localeService.register === 'function') {
    const registerLocale = () =>
      localeService.register('plugin-config.doubao-paint', {
        zh: zhLocale,
        en: enLocale,
      });
    if (typeof ctx.effect === 'function') {
      ctx.effect(registerLocale, 'dsh-doubao-paint: host locale');
    } else {
      registerLocale();
    }
  }
  if (!initialConfig.enabled) return;

  const history = sharedHistory;

  // history 落盘：apply 时读回既有记录并清理 .runs，生成成功后覆盖写。
  // 失败不阻断插件（坏 JSON / 只读目录都只影响"记住历史"这一项能力）。
  // 写入时机统一收敛在 lib/entry.js 的 submitPaintRequest 内。
  const hydrateHistory = async () => {
    try {
      const persisted = await loadHistory(normalizeConfig(config).outputDir);
      if (persisted.length === 0) return;
      const merged = mergeHistory(persisted, history);
      history.splice(0, history.length, ...merged);
    } catch {
      /* 读不回来就当作空历史 */
    }
  };
  void hydrateHistory();
  void pruneRunDirs(normalizeConfig(config).outputDir).catch(() => {});

  // 面板通道工作区归属（v1.4.5 修复）：dock slot 下发的 session 只是 SessionSnapshot，
  // 没有 cwd/header/workingDirectory，客户端取不到工作区，于是 /generate 的 workspace 为空，
  // orchestrator 回落到宿主进程 cwd（profile 目录，面板显示成 desktop）。服务端必须按
  // sessionId 反查会话 header.cwd；存量里已经被误标的记录也按同一来源矫正（内存副本，不删记录）。
  // 兜底 cwd 候选：orchestrator 拿不到工作区时用的是宿主进程 cwd；Desktop 版宿主进程
// cwd 就是 profile 目录（所以面板上显示成 desktop）。DSH_HOME/DSH_PROFILE 存在时把
// profile 目录也纳入候选，保证换用别的启动方式时存量记录仍能被归位。
  const PROFILE_DIR_CANDIDATE =
    process.env.DSH_HOME && process.env.DSH_PROFILE
      ? path.join(process.env.DSH_HOME, 'profiles', process.env.DSH_PROFILE)
      : '';
  const FALLBACK_WORKSPACE_CANDIDATES = [process.cwd(), process.env.DSH_PROFILE_DIR || '', PROFILE_DIR_CANDIDATE];
  const SESSION_WORKSPACE_LOOKUP_LIMIT = 24;

  const sessionCwdIndex = async (records) => {
    const index = new Map();
    const ids = [];
    for (const record of Array.isArray(records) ? records : []) {
      const id = record && typeof record.sessionId === 'string' ? record.sessionId.trim() : '';
      if (!id || ids.includes(id)) continue;
      ids.push(id);
      if (ids.length >= SESSION_WORKSPACE_LOOKUP_LIMIT) break;
    }
    for (const id of ids) {
      const cwd = await resolveWorkspaceBySessionId(ctx, id);
      if (cwd) index.set(id, cwd);
    }
    return index;
  };

  /* 面板/路由渲染用的历史视图：先归位被误标的记录（幂等，第二次起是空操作），再交给分组逻辑。 */
  const historyView = async () => {
    await repairHistoryAttribution();
    return history;
  };

  /**
   * 把「被进程 cwd 兜底误标」的存量记录一次性归位（只改 workspace 字段，不增删记录）。
   * 归位后写回 `.history.json`，保证面板分组、分组清除、后续 hydrate 看到同一份归属。
   */
  const repairHistoryAttribution = async () => {
    const index = await sessionCwdIndex(history);
    const repaired = repairFallbackWorkspace(history, index, FALLBACK_WORKSPACE_CANDIDATES);
    if (repaired === history) return history;
    history.splice(0, history.length, ...repaired);
    try {
      await saveHistory(normalizeConfig(config).outputDir, history);
    } catch {
      /* 写盘失败只影响持久化，本次渲染仍用已归位的副本 */
    }
    return history;
  };

  // 1. 注册 System Prompt 指引
  const registerPrompt = (promptCtx) => {
    if (!normalizeConfig(config).injectSystemPrompt) return;
    promptCtx.systemPrompt.section({
      name: 'doubao-paint-studio',
      order: 220,
      text: DEFAULT_SYSTEM_PROMPT_TEXT,
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], registerPrompt);
  } else if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    registerPrompt(ctx);
  }

  // 2. 注册 AI 工具：`doubao_generate_image` 与 `doubao_image_status`
  const registerTools = (toolCtx) => {
    toolCtx.tools.register(
      defineTool({
        name: 'doubao_generate_image',
        description:
          'Generate AI images by automating Doubao Web (doubao.com) inside the local Google Chrome ' +
          '(driven by the official chrome-devtools CLI). ' +
          'Automatically handles Doubao skill selection, aspect ratio ("1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9"), ' +
          'visual style presets, high-resolution image extraction, local file saving, and multimodal chat attachment rendering. ' +
          'If Doubao Web is not logged in, it opens the Doubao login modal in Chrome and returns a screenshot so the user can scan the QR code or log in with phone/Feishu.',
        parameters: {
          prompt: {
            type: 'string',
            required: true,
            description:
              'Detailed visual description of the image to generate (subject, composition, lighting, mood, text elements).',
          },
          aspectRatio: {
            type: 'string',
            enum: [...SUPPORTED_ASPECT_RATIOS],
            description:
              'Target image aspect ratio (e.g. "16:9" for covers/landscapes, "1:1" for avatars/icons, "9:16" for mobile posters, "3:4" or "4:3"). Defaults to plugin config.',
          },
          style: {
            type: 'string',
            description:
              'Optional visual style preset or custom style description (e.g. "cinematic-cg", "photorealistic", "cyberpunk", "chinese-ink", "anime", "3d-isometric", "minimal-editorial").',
          },
          negativePrompt: {
            type: 'string',
            description: 'Optional elements to avoid in the generated image.',
          },
          outputDir: {
            type: 'string',
            description:
              'Optional directory path to save downloaded high-res images (defaults to `~/.dsh/dsh-doubao-paint/images`).',
          },
          filenamePrefix: {
            type: 'string',
            description: 'Optional filename prefix for saved images (default: "doubao").',
          },
          maxImages: {
            type: 'integer',
            description: 'Maximum number of generated images to download from this prompt (1 to 8, default 4).',
          },
          newConversation: {
            type: 'boolean',
            description:
              'Whether to click "New Conversation" in Doubao before sending the prompt (default true; set false to reuse the current chat for iterative edits).',
          },
          keepTab: {
            type: 'boolean',
            description:
              'Whether to keep Chrome and the Doubao tab running after generation completes (default true; false stops the chrome-devtools daemon when the run succeeds).',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => renderDoubaoToolOutput(value),
        },
        timeoutMs: toolTimeoutMs,
        presentCall: (args) => ({
          card: 'generic',
          title: '豆包生图 (Doubao Paint)',
          kind: 'other',
          rawInput: `${args.prompt || ''}${args.aspectRatio ? ` [${args.aspectRatio}]` : ''}`,
        }),
        async execute(args, exec) {
          return submitPaintRequest(
            {
              mode: 'generate',
              prompt: args.prompt,
              aspectRatio: args.aspectRatio,
              style: args.style,
              negativePrompt: args.negativePrompt,
              outputDir: args.outputDir,
              filenamePrefix: args.filenamePrefix,
              maxImages: args.maxImages,
              newConversation: args.newConversation,
              keepTab: args.keepTab,
              workspace: resolveSessionWorkspace(ctx, exec?.agent?.session),
              sessionId: exec?.agent?.session?.id,
              config,
            },
            {
              ctx,
              attachments: attachmentsService,
              signal: exec?.signal,
              history,
            },
          );
        },
      }),
    );

    toolCtx.tools.register(
      defineTool({
        name: 'doubao_image_status',
        description:
          'Check whether Doubao Web (doubao.com) is open and logged in inside the local Google Chrome, or open the Doubao login modal for the user.',
        parameters: {
          openLoginIfNeeded: {
            type: 'boolean',
            description:
              'When true, automatically opens the Doubao login dialog in Chrome if the user is not logged in (default true).',
          },
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render: (_args, value) => renderDoubaoToolOutput(value),
        },
        timeoutMs: statusTimeoutMs,
        presentCall: () => ({
          card: 'generic',
          title: '检查豆包生图状态',
          kind: 'other',
          rawInput: 'doubao.com login & readiness check',
        }),
        async execute(args, exec) {
          const openLogin = args?.openLoginIfNeeded !== false;
          // 状态查询顺带把 `.history.json` 合并进来，避免多 apply 实例下
          // 面板/工具读到过期的内存数组。
          await hydrateHistory();
          const outcome = await submitPaintRequest(
            {
              mode: openLogin ? 'open' : 'status',
              config,
            },
            {
              ctx,
              attachments: attachmentsService,
              signal: exec?.signal,
              history,
            },
          );
          const resolvedForHealth = normalizeConfig(config);
          const healthBackend = resolveBrowserBackend(resolvedForHealth);
          return {
            ...outcome,
            health: buildHealthReport({
              config: resolvedForHealth,
              backend: healthBackend,
              version: PLUGIN_VERSION,
              ego: { path: resolvedForHealth.egoCliPath, exists: Boolean(resolvedForHealth.egoCliPath) },
              chrome: { path: resolvedForHealth.chromeCliPath, exists: Boolean(resolvedForHealth.chromeCliPath) },
            }),
          };
        },
      }),
    );
  };

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    registerTools(ctx);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], registerTools);
  }

  // 3. 注册 runtime 技能（/doubao-paint 手势由宿主注入 skill_content，不再注册同名命令）
  const skillsService = readService(ctx, 'skills');
  if (skillsService) {
    registerPaintSkill(skillsService);
  }

  // 4. 注册本机 HTTP 路由供 Web GUI 面板直连调用
  const registerWebRoutes = (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/status',
      handler: async (req, res) => {
        try {
          // 每次读状态都重新合并 `.history.json`：宿主内可能同时存在多个
          // apply 实例，各自持一份内存数组；只靠 apply 时 hydrate 会让面板
          // 看到的是旧快照（真机：刚出的图不在面板里）。
          await hydrateHistory();
          const resolved = normalizeConfig(config);
          // 后端探测：ego 优先，探测不到才回落 chrome
          const backend = resolveBrowserBackend(resolved);
          const egoExist = Boolean(resolved.egoCliPath) && existsSync(resolved.egoCliPath);
          const chromeExist = Boolean(resolved.chromeCliPath) && existsSync(resolved.chromeCliPath);
          const cliExists = backend === 'ego' ? egoExist : chromeExist;
          const urlObj = new URL(req.url || '/doubao-paint/status', 'http://127.0.0.1');
          const probeBrowser = urlObj.searchParams.get('probe') === '1';
          // 面板通道（dock/chip）只拿得到 sessionId：工作区由服务端反查会话 header.cwd 决定。
          // 显式 ?workspace 仍然优先（会话内 cd 之后前端能给出更精确的路径）。
          const resolvedWorkspace = await resolveRequestWorkspace(ctx, {
            workspace: urlObj.searchParams.get('workspace') || '',
            sessionId: urlObj.searchParams.get('sessionId') || '',
          });
          const currentWorkspace = resolvedWorkspace.workspace;
          const anyBackendAvailable = egoExist || chromeExist;
          let browserStatus = null;
          if (probeBrowser && anyBackendAvailable) {
            browserStatus = await submitPaintRequest(
              { mode: 'status', config },
              { ctx, attachments: attachmentsService, history },
            );
          }
          const displayHistory = await historyView();
          sendJson(res, anyBackendAvailable ? 200 : 503, {
            ok: anyBackendAvailable,
            code: anyBackendAvailable ? 'ok' : 'backend_unavailable',
            cliExists,
            backend,
            requestedBackend: resolved.browserBackend,
            backends: {
              ego: { path: resolved.egoCliPath, exists: egoExist },
              chrome: { path: resolved.chromeCliPath, exists: chromeExist },
            },
            config: {
              browserBackend: resolved.browserBackend,
              egoCliPath: resolved.egoCliPath,
              doubaoUrl: resolved.doubaoUrl,
              chromeCliPath: resolved.chromeCliPath,
              defaultAspectRatio: resolved.defaultAspectRatio,
              defaultStyle: resolved.defaultStyle,
              outputDir: resolveOutputDirectory(resolved.outputDir),
              attachImages: resolved.attachImages,
            },
            browserStatus,
            health: buildHealthReport({
              config: resolved,
              backend,
              version: PLUGIN_VERSION,
              ego: { path: resolved.egoCliPath, exists: egoExist },
              chrome: { path: resolved.chromeCliPath, exists: chromeExist },
            }),
            presets: STYLE_PRESETS,
            aspectRatios: SUPPORTED_ASPECT_RATIOS,
            // 面板按工作区分区域：groups 已按「当前工作区置顶」排好，history 保留给旧客户端
            workspace: currentWorkspace,
            workspaceSource: resolvedWorkspace.source,
            groups: groupHistoryByWorkspace(displayHistory, { currentWorkspace }),
            history: displayHistory.slice(0, 12),
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    });

    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/open',
      handler: async (_req, res) => {
        try {
          const outcome = await submitPaintRequest(
            { mode: 'open', config },
            { ctx, attachments: attachmentsService, history },
          );
          sendJson(res, 200, { ok: true, outcome });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    });

    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/generate',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const requestSessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
          // 面板通道拿不到工作区（dock slot 只下发 SessionSnapshot，无 cwd），必须按 sessionId
          // 反查会话 header.cwd 后再落库；否则记录会退化成宿主进程 cwd（profile 目录 desktop）。
          const resolvedWorkspace = await resolveRequestWorkspace(ctx, {
            workspace: body.workspace,
            sessionId: requestSessionId,
          });
          const outcome = await submitPaintRequest(
            {
              mode: 'generate',
              prompt: body.prompt,
              aspectRatio: body.aspectRatio,
              style: body.style,
              negativePrompt: body.negativePrompt,
              maxImages: body.maxImages ?? 4,
              newConversation: body.newConversation === undefined ? true : Boolean(body.newConversation),
              workspace: resolvedWorkspace.workspace,
              sessionId: requestSessionId,
              config,
            },
            { ctx, attachments: attachmentsService, history },
          );
          const displayHistory = await historyView();
          sendJson(res, 200, {
            ok: outcome.status === 'succeeded',
            outcome,
            workspace: resolvedWorkspace.workspace,
            workspaceSource: resolvedWorkspace.source,
            groups: groupHistoryByWorkspace(displayHistory, { currentWorkspace: resolvedWorkspace.workspace }),
            history: displayHistory.slice(0, 12),
          });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    });

    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/clear',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          // 同一条路由承载两种「删除历史 + 删本地文件」语义，只换筛选目标：
          // - `workspace`：清除整个工作区分组（面板分组的「清除」按钮）；
          // - `filePath` / `id`：只删单张（缩略图悬浮关闭按钮）。
          // 面板分组「清除」按钮带的 workspace 可能为空（面板通道拿不到工作区），此时按
          // sessionId 反查会话 header.cwd 兜底，避免清错组或清不到。
          const targetWorkspace = (await resolveRequestWorkspace(ctx, {
            workspace: body.workspace,
            sessionId: body.sessionId,
          })).workspace;
          const targetFilePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
          const targetId = typeof body.id === 'string' ? body.id.trim() : '';
          const single = Boolean(targetFilePath || targetId);
          await hydrateHistory();
          const removed = [];
          if (single) {
            const picked = removeHistoryRecords(history, { filePath: targetFilePath, id: targetId });
            removed.push(...picked.removed);
            history.splice(0, history.length, ...picked.kept);
          } else {
            const kept = [];
            for (const record of history) {
              const recordWorkspace = typeof record?.workspace === 'string' ? record.workspace.trim() : '';
              if (recordWorkspace === targetWorkspace) {
                removed.push(record);
              } else {
                kept.push(record);
              }
            }
            history.splice(0, history.length, ...kept);
          }
          await saveHistory(normalizeConfig(config).outputDir, history);
          let filesRemoved = 0;
          for (const record of removed) {
            const filePath = typeof record?.filePath === 'string' ? record.filePath : '';
            if (!filePath) continue;
            try {
              await unlink(filePath);
              filesRemoved += 1;
            } catch {
              /* 文件已被手动删掉/占用：记录清掉即可 */
            }
          }
          // 单张删除时用 `currentWorkspace`（前端所在分组）算返回分组；
          // 传 `workspace` 在单张语义下会被忽略，避免把整组当成删除目标。
          const currentWorkspace = single
            ? typeof body.currentWorkspace === 'string' && body.currentWorkspace.trim()
              ? body.currentWorkspace.trim()
              : typeof removed[0]?.workspace === 'string'
                ? removed[0].workspace.trim()
                : targetWorkspace
            : targetWorkspace;
          const clearView = await historyView();
          const payload = {
            ok: true,
            workspace: currentWorkspace,
            removed: removed.length,
            filesRemoved,
            groups: groupHistoryByWorkspace(clearView, { currentWorkspace }),
            history: clearView.slice(0, 12),
          };
          if (single && removed.length === 0) {
            // 记录已经不在（例如另一个面板先删了）：不是错误状态机，但必须让调用方知道没删到东西。
            sendJson(res, 404, { ...payload, ok: false, error: 'Unknown image record' });
            return;
          }
          sendJson(res, 200, payload);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    });

    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/file',
      handler: async (req, res) => {
        try {
          const urlObj = new URL(req.url || '/doubao-paint/file', 'http://127.0.0.1');
          const target = resolveImageRequest(urlObj.searchParams, {
            history,
            outputDir: resolveOutputDirectory(config.outputDir),
          });
          if (!target.filePath) {
            sendJson(res, target.status, { ok: false, error: target.error });
            return;
          }
          const filePath = target.filePath;
          const ext = path.extname(filePath).slice(1).toLowerCase();
          const mediaType = IMAGE_MEDIA_BY_EXT[ext];
          if (!mediaType) {
            sendJson(res, 400, { ok: false, error: 'Unsupported image extension' });
            return;
          }
          const info = await stat(filePath).catch(() => null);
          if (!info || !info.isFile()) {
            sendJson(res, 404, { ok: false, error: 'Image file not found' });
            return;
          }
          const buf = await readFile(filePath);
          res.writeHead(200, {
            'content-type': mediaType,
            'content-length': String(buf.length),
            'cache-control': 'private, max-age=3600',
          });
          res.end(buf);
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
      },
    });
  };

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], registerWebRoutes);
  } else if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    registerWebRoutes(ctx);
  }
}

export default {
  name,
  inject,
  Config,
  normalizeConfig,
  resolveStyleHint,
  buildDoubaoPrompt,
  extractDoubaoImageKey,
  filterGeneratedImageCandidates,
  pickImages,
  buildProbeScript,
  executeDoubaoAction,
  renderDoubaoToolOutput,
  apply,
};



