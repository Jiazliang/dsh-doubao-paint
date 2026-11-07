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
import { readFile } from 'node:fs/promises';

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

await check('error messages i18n', () => {
  const codes = errors.PAINT_ERROR_CODES;
  for (const code of codes) {
    const en = errors.PAINT_ERROR_MESSAGES_EN[code];
    if (typeof en !== 'string' || en.length <= 3) throw new Error(`missing english message: ${code}`);
  }
  const en = errors.errorMessage('busy', 'en');
  const zh = errors.errorMessage('busy', 'zh');
  if (en === zh) throw new Error('english and chinese messages collapsed');
  if (errors.errorMessage('busy', 'fr') !== zh) throw new Error('unknown lang should fall back to chinese');
  if (errors.errorMessage('no-such-code', 'en') !== errors.PAINT_ERROR_MESSAGES_EN.unknown) {
    throw new Error('unknown code should fall back to unknown message');
  }
  return `${codes.length} codes / en + zh`;
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

await check('health report', () => {
  const report = mod.buildHealthReport({
    config: { outputDir: 'doubao_images' },
    backend: 'chrome',
    version: mod.PLUGIN_VERSION,
    chrome: { path: '/fake/chrome-devtools.js', exists: true },
  });
  if (report.ok !== true) throw new Error(`healthy fixture flagged: ${JSON.stringify(report.problems)}`);
  if (report.contract.required !== 2) throw new Error('contract required count broken');
  if (report.contract.composer !== 1) throw new Error('contract composer count broken');
  const missing = mod.buildHealthReport({
    config: { outputDir: 'doubao_images' },
    backend: 'ego',
    ego: { path: '', exists: false },
  });
  if (missing.ok || missing.problems[0]?.code !== 'cli_missing') throw new Error('cli_missing not detected');
  return `${report.outputDir.writable ? 'writable' : 'blocked'} / ${report.versions.plugin}`;
});

await check('history persistence', async () => {
  const history = await import('../lib/history.js');
  if (typeof history.saveHistory !== 'function') throw new Error('saveHistory missing');
  if (history.DEFAULT_KEEP_RUNS < 1) throw new Error('retention window broken');
  const merged = history.mergeHistory([{ filePath: 'a' }], [{ filePath: 'a' }, { filePath: 'b' }]);
  if (merged.length !== 2 || merged[0].filePath !== 'a') throw new Error('merge order broken');
  return `keep ${history.DEFAULT_KEEP_RUNS} runs / merge ${merged.length}`;
});

await check('unified entry', () => {
  const request = mod.normalizePaintRequest({ mode: 'generate', prompt: '猫' });
  if (request.maxImages !== 4) throw new Error('maxImages default broken');
  if (request.newConversation !== true) throw new Error('newConversation default broken');
  if (typeof mod.submitPaintRequest !== 'function') throw new Error('submitPaintRequest missing');
  return `${request.mode} / max ${request.maxImages}`;
});
await check('skill gesture', () => {
  if (mod.PAINT_SKILL?.invocation?.modelInvocable !== true) throw new Error('skill not model-invocable');
  if (mod.PAINT_SKILL?.invocation?.userInvocable !== true) throw new Error('skill not user-invocable');
  if (!mod.PAINT_SKILL.content.includes('doubao_generate_image')) throw new Error('skill content lost tool name');
  if (!mod.PAINT_SKILL.content.includes('/doubao-paint')) throw new Error('skill content lost gesture name');
  if (!mod.PAINT_SKILL.content.includes('不要')) throw new Error('skill content lost prompt discipline');
  return `${mod.PAINT_SKILL.name} / gesture only`;
});
await check('no command surface', async () => {
  for (const name of ['registerPaintCommand', 'parseCommandArgs', 'renderCommandResult']) {
    if (typeof mod[name] !== 'undefined') throw new Error(`command surface still exported: ${name}`);
  }
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  if (source.includes('conversation.chat.commandview')) throw new Error('commandview slot still registered');
  if (!source.includes('tool.call.toolview')) throw new Error('toolview slot missing');
  return 'commands removed / toolview kept';
});

const failed = checks.filter((item) => !item.ok);
const report = {
  ok: failed.length === 0,
  mode: 'offline',
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.ok ? 0 : 1);