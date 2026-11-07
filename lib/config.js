/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 配置归一化与 Schemastery 双轨 schema
 *
 * 与参考实现 `dsh-doubao-image` 的 `normalizeConfig` / `createFallbackSchema` / `createPluginSchema`
 * 逐项对齐，差异只有两处：
 * 1. `tabbitCliPath` → `chromeCliPath`（语义从 tabbit-cli 换成 chrome-devtools CLI）；
 * 2. 删除 `taskName`（Tabbit 任务组概念不存在，Chrome 侧改为固定持久 profile）。
 *
 * @module dsh-doubao-paint/config
 */
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zhLocale from '../locale/zh.json' with { type: 'json' };
import enLocale from '../locale/en.json' with { type: 'json' };
import {
  DEFAULT_ASPECT_RATIO,
  DEFAULT_DOUBAO_URL,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_STYLE,
  DEFAULT_TIMEOUT_MS,
  SUPPORTED_ASPECT_RATIOS,
  DEFAULT_BROWSER_BACKEND,
  BROWSER_BACKENDS,
} from './constants.js';
import { resolveDefaultChromeCliPath } from './chrome-cli.js';
import { resolveDefaultEgoCliPath } from './ego-cli.js';
import { unwrapVolatile } from './prompt.js';

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

const schemasteryMod = await importHostPackage('@deepseek-ai/schemastery');
const schemastery = schemasteryMod ? (schemasteryMod.default ?? schemasteryMod) : null;

/**
 * 归一化插件配置。
 */
export function normalizeConfig(raw = {}) {
  const root = unwrapVolatile(raw);
  const input = root && typeof root === 'object' ? root : {};

  const enabledVal = unwrapVolatile(input.enabled);
  const browserBackendVal = unwrapVolatile(input.browserBackend);
  const egoCliPathVal = unwrapVolatile(input.egoCliPath);
  const chromeCliPathVal = unwrapVolatile(input.chromeCliPath);
  const doubaoUrlVal = unwrapVolatile(input.doubaoUrl);
  const defaultAspectRatioVal = unwrapVolatile(input.defaultAspectRatio);
  const defaultStyleVal = unwrapVolatile(input.defaultStyle);
  const outputDirVal = unwrapVolatile(input.outputDir);
  const timeoutMsVal = unwrapVolatile(input.timeoutMs);
  const keepTabVal = unwrapVolatile(input.keepTab);
  const injectSystemPromptVal = unwrapVolatile(input.injectSystemPrompt);

  const enabled = typeof enabledVal === 'boolean' ? enabledVal : true;
  const requestedBackend =
    typeof browserBackendVal === 'string' ? browserBackendVal.trim().toLowerCase() : '';
  const browserBackend = BROWSER_BACKENDS.includes(requestedBackend)
    ? requestedBackend
    : DEFAULT_BROWSER_BACKEND;
  const egoCliPath = resolveDefaultEgoCliPath(
    typeof egoCliPathVal === 'string' ? egoCliPathVal : '',
  );
  const chromeCliPath = resolveDefaultChromeCliPath(
    typeof chromeCliPathVal === 'string' ? chromeCliPathVal : '',
  );
  const doubaoUrl =
    typeof doubaoUrlVal === 'string' && /^https?:\/\//i.test(doubaoUrlVal.trim())
      ? doubaoUrlVal.trim()
      : DEFAULT_DOUBAO_URL;
  const defaultAspectRatio =
    typeof defaultAspectRatioVal === 'string' &&
    SUPPORTED_ASPECT_RATIOS.includes(defaultAspectRatioVal.trim())
      ? defaultAspectRatioVal.trim()
      : DEFAULT_ASPECT_RATIO;
  const defaultStyle =
    typeof defaultStyleVal === 'string' && defaultStyleVal.trim().length > 0
      ? defaultStyleVal.trim()
      : DEFAULT_STYLE;
  const outputDir =
    typeof outputDirVal === 'string' && outputDirVal.trim().length > 0
      ? outputDirVal.trim()
      : DEFAULT_OUTPUT_DIR;
  const rawTimeout = Number(timeoutMsVal);
  const timeoutMs = Number.isFinite(rawTimeout)
    ? Math.max(30000, Math.min(180000, Math.round(rawTimeout)))
    : DEFAULT_TIMEOUT_MS;
  const keepTab = typeof keepTabVal === 'boolean' ? keepTabVal : true;
  const injectSystemPrompt =
    typeof injectSystemPromptVal === 'boolean' ? injectSystemPromptVal : true;

  return {
    enabled,
    browserBackend,
    egoCliPath,
    chromeCliPath,
    doubaoUrl,
    defaultAspectRatio,
    defaultStyle,
    outputDir,
    timeoutMs,
    keepTab,
    injectSystemPrompt,
  };
}

function makeFallbackFieldNode(uid, type, meta) {
  return {
    uid,
    type,
    meta,
    toJSON() {
      return {
        uid,
        refs: {
          [uid]: { type, meta: { ...meta } },
        },
      };
    },
  };
}

function createFallbackSchema() {
  const schema = (value) => normalizeConfig(value);
  const dict = {
    enabled: makeFallbackFieldNode(1, 'boolean', { default: true, volatile: true }),
    browserBackend: makeFallbackFieldNode(11, 'string', { default: DEFAULT_BROWSER_BACKEND, volatile: true }),
    egoCliPath: makeFallbackFieldNode(12, 'string', { default: '', volatile: true }),
    chromeCliPath: makeFallbackFieldNode(2, 'string', { default: '', volatile: true }),
    doubaoUrl: makeFallbackFieldNode(3, 'string', { default: DEFAULT_DOUBAO_URL, volatile: true }),
    defaultAspectRatio: makeFallbackFieldNode(5, 'string', {
      default: DEFAULT_ASPECT_RATIO,
      volatile: true,
    }),
    defaultStyle: makeFallbackFieldNode(6, 'string', { default: DEFAULT_STYLE, volatile: true }),
    outputDir: makeFallbackFieldNode(7, 'string', { default: DEFAULT_OUTPUT_DIR, volatile: true }),
    timeoutMs: makeFallbackFieldNode(8, 'number', { default: DEFAULT_TIMEOUT_MS, volatile: true }),
    keepTab: makeFallbackFieldNode(9, 'boolean', { default: true, volatile: true }),
    injectSystemPrompt: makeFallbackFieldNode(10, 'boolean', { default: true, volatile: true }),
  };

  schema.uid = 0;
  schema.type = 'object';
  schema.meta = {};
  schema.dict = dict;
  schema.toJSON = () => ({
    uid: 0,
    refs: {
      0: {
        type: 'object',
        meta: {},
        dict: {
          enabled: 1,
          chromeCliPath: 2,
          doubaoUrl: 3,
          defaultAspectRatio: 5,
          defaultStyle: 6,
          outputDir: 7,
          timeoutMs: 8,
          keepTab: 9,
          injectSystemPrompt: 10,
        },
      },
      1: { type: 'boolean', meta: { default: true, volatile: true } },
      2: { type: 'string', meta: { default: '', volatile: true } },
      3: { type: 'string', meta: { default: DEFAULT_DOUBAO_URL, volatile: true } },
      5: { type: 'string', meta: { default: DEFAULT_ASPECT_RATIO, volatile: true } },
      6: { type: 'string', meta: { default: DEFAULT_STYLE, volatile: true } },
      7: { type: 'string', meta: { default: DEFAULT_OUTPUT_DIR, volatile: true } },
      8: { type: 'number', meta: { default: DEFAULT_TIMEOUT_MS, volatile: true } },
      9: { type: 'boolean', meta: { default: true, volatile: true } },
      10: { type: 'boolean', meta: { default: true, volatile: true } },
    },
  });

  Object.defineProperty(schema, '~standard', {
    value: {
      version: 1,
      vendor: 'dsh-doubao-paint',
      validate(value) {
        return { value: normalizeConfig(value) };
      },
    },
    enumerable: false,
    configurable: true,
  });

  return schema;
}

function withVolatile(fieldSchema) {
  return typeof fieldSchema?.volatile === 'function' ? fieldSchema.volatile() : fieldSchema;
}

function createPluginSchema() {
  if (!schemastery) return createFallbackSchema();
  try {
    const base = schemastery.object({
      enabled: withVolatile(schemastery.boolean().default(true)),
      chromeCliPath: withVolatile(schemastery.string().default('')),
      doubaoUrl: withVolatile(schemastery.string().default(DEFAULT_DOUBAO_URL)),
      defaultAspectRatio: withVolatile(
        typeof schemastery.union === 'function' && typeof schemastery.const === 'function'
          ? schemastery
              .union(SUPPORTED_ASPECT_RATIOS.map((r) => schemastery.const(r)))
              .default(DEFAULT_ASPECT_RATIO)
          : schemastery.string().default(DEFAULT_ASPECT_RATIO),
      ),
      defaultStyle: withVolatile(schemastery.string().default(DEFAULT_STYLE)),
      outputDir: withVolatile(schemastery.string().default(DEFAULT_OUTPUT_DIR)),
      timeoutMs: withVolatile(
        schemastery.number().min(30000).max(180000).step(5000).default(DEFAULT_TIMEOUT_MS),
      ),
      keepTab: withVolatile(schemastery.boolean().default(true)),
      injectSystemPrompt: withVolatile(schemastery.boolean().default(true)),
    });
    if (typeof base.i18n === 'function') {
      return base.i18n({
        zh: zhLocale,
        'zh-CN': zhLocale,
        en: enLocale,
        'en-US': enLocale,
      });
    }
    return base;
  } catch {
    return createFallbackSchema();
  }
}

export const Config = createPluginSchema();



