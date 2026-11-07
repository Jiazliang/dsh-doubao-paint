#!/usr/bin/env node
/**
 * 静态检查（无外部依赖）。
 *
 * 只做「不跑功能也能判定」的卫生项，与 `smoke.mjs`（行为冒烟）互补：
 *   1. 语法：每个 lib/*.js、scripts/*.mjs、test/*.js 过 `node --check`
 *   2. JSON：locale/*.json 与 package.json 可解析
 *   3. 发布面：package.json 的 main / exports / files 指向的文件真实存在
 *   4. 遗留标记：源码内不得出现 TODO / FIXME / debugger
 *   5. 结构护栏：命令面不得回潮（client.js 不注册 commandview、index.js 不导出命令 API）
 *
 * 用法：node scripts/check.mjs
 * 输出：{ ok, checks: [{ name, ok, detail }] }，任何一项失败退出码 1。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail: detail || 'ok' });
  } catch (err) {
    checks.push({ name, ok: false, detail: err?.message || String(err) });
  }
}

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const listJs = (rel) =>
  readdirSync(path.join(ROOT, rel))
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.posix.join(rel, name));

await check('syntax', () => {
  const files = [...listJs('lib'), ...listJs('scripts'), ...listJs('test')];
  const failed = [];
  for (const rel of files) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)], { stdio: 'pipe' });
    } catch (err) {
      failed.push(`${rel}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
    }
  }
  if (failed.length > 0) throw new Error(failed.join(' | '));
  return `${files.length} files`;
});

await check('json parse', () => {
  const files = ['package.json', ...readdirSync(path.join(ROOT, 'locale')).map((n) => `locale/${n}`)];
  for (const rel of files) JSON.parse(read(rel));
  return `${files.length} files`;
});

await check('package files exist', () => {
  const pkg = JSON.parse(read('package.json'));
  const targets = new Set([
    pkg.main,
    ...Object.values(pkg.exports || {}),
    ...(pkg.files || []),
    pkg.dsh?.bundle?.patch,
    pkg.dsh?.client?.entry,
  ]);
  const missing = [...targets]
    .filter((rel) => typeof rel === 'string' && !rel.includes('*'))
    .filter((rel) => !existsSync(path.join(ROOT, rel)));
  if (missing.length > 0) throw new Error(`missing: ${missing.join(', ')}`);
  return `${targets.size} targets`;
});

await check('no stray markers', () => {
  const files = [...listJs('lib'), ...listJs('scripts'), ...listJs('test')];
  const hits = [];
  for (const rel of files) {
    const text = read(rel);
    const match = text.match(/\b(TODO|FIXME|XXX|debugger)\b/);
    if (match) hits.push(`${rel}: ${match[1]}`);
  }
  if (hits.length > 0) throw new Error(hits.join(' | '));
  return `${files.length} files clean`;
});

await check('command surface stays removed', () => {
  const client = read('lib/client.js');
  const index = read('lib/index.js');
  const banned = [
    ['lib/client.js', client, 'conversation.chat.commandview'],
    ['lib/index.js', index, 'registerPaintCommand'],
    ['lib/index.js', index, 'parseCommandArgs'],
  ];
  const hits = banned.filter(([, text, needle]) => text.includes(needle)).map(([rel, , needle]) => `${rel}: ${needle}`);
  if (hits.length > 0) throw new Error(`command surface came back: ${hits.join(' | ')}`);
  if (!client.includes('tool.call.toolview')) throw new Error('lib/client.js: tool.call.toolview missing');
  if (!client.includes('dsh-doubao-paint:generated')) throw new Error('lib/client.js: generated event missing');
  return 'no commandview / toolview present';
});

await check('status message lifecycle', () => {
  const client = read('lib/client.js');
  const ttl = client.match(/const STATUS_TTL_MS = (\d+);/);
  if (!ttl) throw new Error('STATUS_TTL_MS 缺失');
  if (ttl[1] !== '15000') throw new Error(`STATUS_TTL_MS 应为 15000，实际 ${ttl[1]}`);
  // v1.4.3 的教训：注入 timers 只当覆盖，缺 setTimeout 时必须回落 globalThis，
  // 否则默认参数 `{}` 会挡掉真宿主计时器，提示永不收回。
  if (!/timers && typeof timers\.setTimeout === "function"/.test(client)) {
    throw new Error('定时器回落逻辑缺失（注入对象缺 setTimeout 时必须回落 globalThis）');
  }
  if (!/typeof globalThis !== "undefined"/.test(client)) throw new Error('globalThis 回落缺失');
  const scheduled = (client.match(/scheduleStatusClear\(\)/g) || []).length;
  if (scheduled < 2) throw new Error(`scheduleStatusClear 调用点过少（${scheduled}），状态下沉路径可能绕过自动收回`);
  return `${ttl[1]}ms / ${scheduled} call sites`;
});

await check('locale parity', () => {
  const zh = JSON.parse(read('locale/zh.json'));
  const en = JSON.parse(read('locale/en.json'));
  const pick = (obj) => {
    const keys = new Set();
    const walk = (node, prefix) => {
      for (const [k, v] of Object.entries(node || {})) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object') walk(v, key);
        else keys.add(key);
      }
    };
    walk(obj, '');
    return keys;
  };
  const zhKeys = pick(zh);
  const enKeys = pick(en);
  const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));
  const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
  if (missingInEn.length > 0 || missingInZh.length > 0) {
    throw new Error(
      `zh/en 键不对称 — 仅 zh: ${JSON.stringify(missingInEn)}；仅 en: ${JSON.stringify(missingInZh)}`,
    );
  }
  return `${zhKeys.size} keys, symmetric`;
});

const failed = checks.filter((c) => !c.ok);
console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
if (failed.length > 0) process.exitCode = 1;