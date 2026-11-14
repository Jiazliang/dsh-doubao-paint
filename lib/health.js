/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 环境体检
 *
 * `doubao_image_status` 除了「登录没登录」还要回答「为什么用不了」：
 * 后端 CLI 在哪、输出目录能不能写、页面契约是否还匹配。
 * 这里只做纯计算与轻量 IO，不启动浏览器。
 *
 * @module dsh-doubao-paint/health
 */
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import path from 'node:path';
import { COMPOSER_SELECTORS, DOUBAO_SELECTORS, HARD_SELECTORS, SOFT_SELECTORS } from './contract.js';
import { resolveOutputDirectory } from './prompt.js';

/**
 * 输出目录可写性探针：目录不存在时看父目录能不能建，存在就直接试写权限位。
 *
 * @returns {{path: string, exists: boolean, writable: boolean, reason?: string}}
 */
export function inspectOutputDir(outputDir, cwd = process.cwd()) {
  const target = resolveOutputDirectory(outputDir, cwd);
  const exists = existsSync(target);
  // 目录可能有多层还不存在，往上找到最近的已存在祖先再探权限（它会被 mkdir -p 用上）
  let probe = target;
  while (!existsSync(probe) && path.dirname(probe) !== probe) {
    probe = path.dirname(probe);
  }
  try {
    accessSync(probe, fsConstants.W_OK);
    return { path: target, exists, writable: true };
  } catch (err) {
    return { path: target, exists, writable: false, reason: String(err?.code || err?.message || err) };
  }
}

/**
 * 一次体检报告（不含需要浏览器的字段）。
 *
 * @param {{
 *   config: object,
 *   backend: 'ego'|'chrome',
 *   cwd?: string,
 *   version?: string,
 *   nodeVersion?: string,
 *   ego?: {path: string, exists: boolean},
 *   chrome?: {path: string, exists: boolean},
 * }} input
 */
export function buildHealthReport({ config, backend, cwd = process.cwd(), version, nodeVersion, ego, chrome } = {}) {
  const outputDir = inspectOutputDir(config?.outputDir, cwd);
  const activeCli = backend === 'ego' ? ego : chrome;
  const problems = [];
  if (!activeCli?.exists) {
    problems.push({
      code: 'cli_missing',
      message: `未找到 ${backend} 后端命令行工具，请安装后重试（doubao_image_status 可再次体检）。`,
      detail: activeCli?.path || null,
    });
  }
  if (!outputDir.writable) {
    problems.push({
      code: 'download_failed',
      message: `输出目录不可写：${outputDir.path}。请改配置 outputDir 或修正权限。`,
      detail: outputDir.reason || null,
    });
  }
  return {
    ok: problems.length === 0,
    backend,
    cli: { path: activeCli?.path || null, exists: Boolean(activeCli?.exists) },
    outputDir,
    contract: {
      selectors: Object.keys(DOUBAO_SELECTORS).length,
      required: HARD_SELECTORS.length,
      composer: COMPOSER_SELECTORS.length,
      hard: [...HARD_SELECTORS],
      soft: [...SOFT_SELECTORS],
      // 静态体检没有页面可探，降级清单恒为空；运行时降级见生成结果里的 degraded 字段
      degraded: [],
    },
    versions: { plugin: version || null, node: nodeVersion || process.version },
    problems,
  };
}