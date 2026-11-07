#!/usr/bin/env node
/**
 * 冒烟检查（不启动浏览器、不读图片内容）。
 *
 *   node scripts/smoke.mjs            # 默认离线
 *   node scripts/smoke.mjs --offline  # 显式离线（CI 用这个）
 *
 * 覆盖：模块可加载、配置归一化、后端探测、错误码表、页面脚本可生成、
 * 选择器契约表可用。任何一项失败 → 退出码 1。
 */
import process from 'node:process';

const mod = await import('../lib/index.js');
const page = await import('../lib/doubao-page.js');
const contract = await import('../lib/contract.js');
const errors = await import('../lib/errors.js');

const checks = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (err) {
    checks.push({ name, ok: false, detail: String(err?.message || err) });
  }
}

await check('module exports', () => {
  if (typeof mod.apply !== 'function') throw new Error('apply missing');
  if (!mod.Config) throw new Error('Config missing');
  if (typeof mod.executeDoubaoAction !== 'function') throw new Error('executeDoubaoAction missing');
  return 'ok';
});

await check('normalizeConfig', () => {
  const cfg = mod.normalizeConfig({});
  if (cfg.timeoutMs < 30000) throw new Error('timeoutMs floor broken');
  if (!['auto', 'ego', 'chrome'].includes(cfg.browserBackend)) throw new Error('backend enum broken');
  return `${cfg.browserBackend} / ${cfg.timeoutMs}ms`;
});

await check('backend resolution', () => {
  const forced = mod.resolveBrowserBackend({ browserBackend: 'chrome' });
  if (forced !== 'chrome') throw new Error('forced chrome broken');
  const fallback = mod.resolveBrowserBackend({ browserBackend: 'ego' }, () => '');
  if (fallback !== 'chrome') throw new Error('fallback broken');
  return `${forced} / fallback ${fallback}`;
});

await check('tool timeout budget', () => {
  const value = mod.resolveToolTimeoutMs(120000);
  if (value !== 150000) throw new Error(`unexpected tool timeout: ${value}`);
  return `${value}ms`;
});

await check('error codes', () => {
  if (errors.PAINT_ERROR_CODES.length < 12) throw new Error('code table too small');
  if (errors.classifyError(new Error('429 rate limit')) !== 'rate_limited') throw new Error('classify broken');
  return `${errors.PAINT_ERROR_CODES.length} codes`;
});

await check('page scripts', () => {
  const scripts = [page.buildProbeScript(), page.buildInputScript({ prompt: 'x' }), page.buildSendScript()];
  for (const script of scripts) {
    const text = typeof script === 'string' ? script : JSON.stringify(script);
    if (!text.includes('document.')) throw new Error('script has no DOM access');
  }
  return `${scripts.length} scripts`;
});

await check('selector contract', () => {
  const ids = Object.keys(contract.DOUBAO_SELECTORS);
  if (ids.length === 0) throw new Error('empty contract');
  if (contract.missingSelectors({}).ok) throw new Error('empty report should be flagged');
  return `${ids.length} selectors`;
});

const failed = checks.filter((item) => !item.ok);
const report = {
  ok: failed.length === 0,
  mode: 'offline',
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);