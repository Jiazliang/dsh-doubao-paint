#!/usr/bin/env node
/**
 * 把工作区里的插件源码同步进「宿主实际加载的那份副本」，并按 SHA256 逐文件核对。
 *
 * 背景：桌面版宿主加载的是 `~/.dsh/profiles/<name>/node_modules/dsh-doubao-paint`
 * 的实拷贝（不是 junction），只改工作区不会让运行中的宿主看到新代码；而 ESM 模块
 * 在进程内只会求值一次，所以同步之后必须重启宿主。
 *
 * 用法：
 *   node scripts/sync-profile.mjs                 # 同步到默认 desktop profile
 *   node scripts/sync-profile.mjs --dry-run       # 只看差异，不写盘
 *   node scripts/sync-profile.mjs --target <dir>   # 指定其它 profile 副本
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIRNAME = 'dsh-doubao-paint';

/** 需要同步的条目（相对 package 根）。 */
const ENTRIES = [
  'lib',
  'locale',
  'cordis.patch.yml',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
];

function defaultTarget() {
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PLUGIN_DIRNAME);
}

function parseArgs(argv) {
  const options = { target: defaultTarget(), dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next) throw new Error('--target 需要一个目录参数');
      options.target = path.resolve(next);
      i += 1;
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 递归展开条目，返回相对路径列表。 */
async function expand(relativeEntry) {
  const absolute = path.join(PACKAGE_ROOT, relativeEntry);
  if (!(await exists(absolute))) return [];
  const info = await stat(absolute);
  if (!info.isDirectory()) return [relativeEntry];
  const children = await readdir(absolute, { withFileTypes: true });
  const out = [];
  for (const child of children) {
    out.push(...(await expand(path.join(relativeEntry, child.name))));
  }
  return out;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('用法: node scripts/sync-profile.mjs [--dry-run] [--target <profile 副本目录>]');
    return 0;
  }

  const files = (await Promise.all(ENTRIES.map(expand))).flat().sort();
  if (files.length === 0) {
    console.error('没有找到可同步的文件，请确认在插件根目录运行');
    return 1;
  }

  const rows = [];
  for (const relative of files) {
    const source = path.join(PACKAGE_ROOT, relative);
    const destination = path.join(options.target, relative);
    const destinationExists = await exists(destination);
    const same = destinationExists && (await sha256(source)) === (await sha256(destination));
    if (!same && !options.dryRun) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    const state = same ? 'same' : destinationExists ? 'updated' : 'created';
    if (!same) {
      const after = await exists(destination) ? await sha256(destination) : '';
      const expected = await sha256(source);
      if (!options.dryRun && after !== expected) {
        rows.push({ relative, state: 'MISMATCH' });
        continue;
      }
    }
    rows.push({ relative, state: options.dryRun && !same ? `diff(${state})` : state });
  }

  const width = Math.max(...rows.map((row) => row.relative.length));
  for (const row of rows) console.log(`${row.relative.padEnd(width)}  ${row.state}`);
  const mismatches = rows.filter((row) => row.state === 'MISMATCH');
  const changed = rows.filter((row) => row.state !== 'same');
  console.log(`\n目标: ${options.target}`);
  console.log(`文件: ${rows.length} 个，变更 ${changed.length} 个${options.dryRun ? '（dry-run，未写盘）' : ''}`);
  if (mismatches.length > 0) {
    console.error(`哈希不一致: ${mismatches.map((row) => row.relative).join(', ')}`);
    return 1;
  }
  if (changed.length > 0 && !options.dryRun) {
    console.log('已同步 —— 宿主进程内的 ESM 模块不会热更新，请重启宿主后生效。');
  }
  return 0;
}

process.exitCode = await main();