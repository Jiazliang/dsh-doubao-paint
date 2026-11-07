/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 插件入口
 *
 * 本插件把「操控豆包网页版生成图片」的完整流程做成本机工具：
 * 由 **chrome-devtools CLI/daemon** 驱动一个持久的独立 Chrome profile（首次人工扫码登录一次），
 * 自动完成「新对话 → 选技能 → 填提示词 → 发送 → 轮询取图 → 下载落盘 → 附件注入」。
 *
 * 设计来源：`dsh-doubao-image`（Tabbit 版）的 1:1 功能复刻，差异见设计方案 B 组 / D 组。
 *
 * @module dsh-doubao-paint
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zhLocale from '../locale/zh.json' with { type: 'json' };
import enLocale from '../locale/en.json' with { type: 'json' };
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_DOUBAO_URL,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_STYLE,
  DEFAULT_SYSTEM_PROMPT_TEXT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BROWSER_BACKEND,
  BROWSER_BACKENDS,
  PLUGIN_VERSION,
  IMAGE_MEDIA_BY_EXT,
  resolveToolTimeoutMs,
  STYLE_PRESETS,
  SUPPORTED_ASPECT_RATIOS,
} from './constants.js';
import { Config, normalizeConfig } from './config.js';
import {
  PAINT_ERROR_CODES,
  PAINT_ERROR_MESSAGES,
  PaintError,
  classifyError,
  failureResult,
  withCode,
} from './errors.js';
import {
  buildDoubaoPrompt,
  extractDoubaoImageKey,
  resolveOutputDirectory,
  resolveStyleHint,
} from './prompt.js';
import {
  buildCollectScript,
  buildInputScript,
  buildNewConversationScript,
  buildProbeScript,
  buildSendScript,
  buildSkillScript,
  buildSwitchWorkModeScript,
  buildTailTextScript,
  filterGeneratedImageCandidates,
  pickImages,
} from './doubao-page.js';
import { createBrowserSession, executeDoubaoAction, readService, resolveBrowserBackend } from './orchestrator.js';
import { loadHistory, mergeHistory, pruneRunDirs, saveHistory } from './history.js';
import { buildHealthReport, inspectOutputDir } from './health.js';

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
export const inject = ['tools', 'attachments'];

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
  PaintError,
  classifyError,
  failureResult,
  withCode,
  DEFAULT_DOUBAO_URL,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_STYLE,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_TIMEOUT_MS,
};

/**
 * 将工具执行结果渲染为 DSH 内容块（文本说明 + 图像附件块）。
 */
export function renderDoubaoToolOutput(value) {
  if (!value || typeof value !== 'object') {
    return [{ type: 'text', text: String(value ?? '') }];
  }

  const cleanImages = Array.isArray(value.images)
    ? value.images.map(({ attachment, ...rest }) => ({
        ...rest,
        attachedToChat: Boolean(attachment),
      }))
    : undefined;

  const cleanScreenshots = Array.isArray(value.screenshots)
    ? value.screenshots.map(({ attachment, ...rest }) => ({
        ...rest,
        attachedToChat: Boolean(attachment),
      }))
    : undefined;

  const summaryObj = {
    ...value,
    ...(cleanImages !== undefined ? { images: cleanImages } : {}),
    ...(cleanScreenshots !== undefined ? { screenshots: cleanScreenshots } : {}),
  };

  const blocks = [{ type: 'text', text: JSON.stringify(summaryObj, null, 2) }];

  if (Array.isArray(value.images)) {
    for (const img of value.images) {
      if (img?.attachment) {
        blocks.push({ type: 'image', attachment: img.attachment });
      }
    }
  }

  if (blocks.length === 1 && Array.isArray(value.screenshots)) {
    for (const shot of value.screenshots) {
      if (shot?.attachment) {
        blocks.push({ type: 'image', attachment: shot.attachment });
      }
    }
  }

  return blocks;
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
  const syncHistory = async (outcome) => {
    if (!outcome || outcome.status !== 'succeeded') return;
    try {
      await saveHistory(normalizeConfig(config).outputDir, history);
    } catch {
      /* 持久化失败不影响本次出图结果 */
    }
  };
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
              'Optional directory path to save downloaded high-res images (defaults to workspace `doubao_images`).',
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
          title: '豆包网页生图 (Doubao Paint)',
          kind: 'other',
          rawInput: `${args.prompt || ''}${args.aspectRatio ? ` [${args.aspectRatio}]` : ''}`,
        }),
        async execute(args, exec) {
          const outcome = await executeDoubaoAction(
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
              config,
            },
            {
              ctx,
              attachments: attachmentsService,
              signal: exec?.signal,
              history,
            },
          );
          await syncHistory(outcome);
          return outcome;
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
          title: '检查豆包网页生图状态',
          kind: 'other',
          rawInput: 'doubao.com login & readiness check',
        }),
        async execute(args, exec) {
          const openLogin = args?.openLoginIfNeeded !== false;
          const outcome = await executeDoubaoAction(
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

  // 3. 注册本机 HTTP 路由供 Web GUI 面板直连调用
  const registerWebRoutes = (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: '/doubao-paint/status',
      handler: async (req, res) => {
        try {
          const resolved = normalizeConfig(config);
          // 后端探测：ego 优先，探测不到才回落 chrome
          const backend = resolveBrowserBackend(resolved);
          const egoExist = Boolean(resolved.egoCliPath) && existsSync(resolved.egoCliPath);
          const chromeExist = Boolean(resolved.chromeCliPath) && existsSync(resolved.chromeCliPath);
          const cliExists = backend === 'ego' ? egoExist : chromeExist;
          const urlObj = new URL(req.url || '/doubao-paint/status', 'http://127.0.0.1');
          const probeBrowser = urlObj.searchParams.get('probe') === '1';
          const anyBackendAvailable = egoExist || chromeExist;
          let browserStatus = null;
          if (probeBrowser && anyBackendAvailable) {
            browserStatus = await executeDoubaoAction({ mode: 'status', config }, { ctx, attachments: attachmentsService, history });
          }
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
            history: history.slice(0, 12),
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
          const outcome = await executeDoubaoAction({ mode: 'open', config }, { ctx, attachments: attachmentsService, history });
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
          const outcome = await executeDoubaoAction(
            {
              mode: 'generate',
              prompt: body.prompt,
              aspectRatio: body.aspectRatio,
              style: body.style,
              negativePrompt: body.negativePrompt,
              maxImages: body.maxImages ?? 4,
              newConversation: body.newConversation === undefined ? true : Boolean(body.newConversation),
              config,
            },
            { ctx, attachments: attachmentsService, history },
          );
          await syncHistory(outcome);
          sendJson(res, 200, {
            ok: outcome.status === 'succeeded',
            outcome,
            history: history.slice(0, 12),
          });
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



