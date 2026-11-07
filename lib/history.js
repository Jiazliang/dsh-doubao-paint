/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — history 持久化与 .runs 保留策略
 *
 * history 原来只活在模块内存里（进程重启即归零，面板「最近生成」永远是空的）。
 * 这里把它落到 `outputDir/.history.json`：apply 时读回、每次生成后覆盖写，
 * 并顺带清理 `outputDir/.runs/` 下堆积的请求目录与截图。
 *
 * @module dsh-doubao-paint/history
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { MAX_HISTORY } from './constants.js';
import { resolveOutputDirectory } from './prompt.js';

/** history 落盘文件名（放在 outputDir 内，随用户改 outputDir 自然切换）。 */
export const HISTORY_FILENAME = '.history.json';

/** orchestrator 每次请求的截图目录名。 */
export const RUNS_DIRNAME = '.runs';

/** 保留最近多少个请求目录；更早的整目录删除。 */
export const DEFAULT_KEEP_RUNS = 20;

/** 这些请求目录里只保留最近 N 个的截图，其余领域只删 png。 */
export const DEFAULT_KEEP_SCREENSHOTS = 5;

/** `outputDir/.history.json` 的绝对路径。 */
export function historyFilePath(outputDir, cwd = process.cwd()) {
  return path.join(resolveOutputDirectory(outputDir, cwd), HISTORY_FILENAME);
}

/** 原子替换写（同目录临时文件 + rename），避免半截 JSON 把面板读崩。 */
async function writeFileAtomic(filePath, text) {
  const tmpPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, text, 'utf8');
  await rename(tmpPath, filePath);
}

/**
 * 读回 history。任何异常都当作「没有历史」——插件不该因为一个坏 JSON 起不来。
 *
 * @returns {Promise<Array<object>>} 记录数组（最多 MAX_HISTORY 条，新的在前）
 */
export async function loadHistory(outputDir, { cwd = process.cwd(), limit = MAX_HISTORY } = {}) {
  const filePath = historyFilePath(outputDir, cwd);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.images) ? parsed.images : Array.isArray(parsed) ? parsed : [];
    return list.filter((item) => item && typeof item === 'object').slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * 覆盖写 history。
 *
 * @returns {Promise<{filePath: string, count: number}>}
 */
export async function saveHistory(outputDir, history, { cwd = process.cwd(), limit = MAX_HISTORY } = {}) {
  const directory = resolveOutputDirectory(outputDir, cwd);
  const filePath = path.join(directory, HISTORY_FILENAME);
  const images = (Array.isArray(history) ? history : []).slice(0, limit);
  await mkdir(directory, { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify({ version: 1, savedAt: new Date().toISOString(), images }, null, 2)}\n`);
  return { filePath, count: images.length };
}

/** 历史合并：磁盘记录与内存记录按 filePath / filename / previewUrl 去重，新的优先。 */
export function mergeHistory(persisted, live, limit = MAX_HISTORY) {
  const merged = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(live) ? live : []), ...(Array.isArray(persisted) ? persisted : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = item.filePath || item.filename || item.previewUrl || item.sourceUrl;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

/**
 * 清理 `outputDir/.runs/`：
 * - 只保留最近 `keepRuns` 个请求目录，更早的整目录删除；
 * - 在保留窗口内，只有最近 `keepScreenshots` 个目录保留 png 截图，其余目录只删 png（保留脚本便于复现）。
 *
 * @returns {Promise<{scanned: number, removedDirs: string[], removedFiles: string[]}>}
 */
export async function pruneRunDirs(
  outputDir,
  { cwd = process.cwd(), keepRuns = DEFAULT_KEEP_RUNS, keepScreenshots = DEFAULT_KEEP_SCREENSHOTS } = {},
) {
  const root = path.join(resolveOutputDirectory(outputDir, cwd), RUNS_DIRNAME);
  const result = { scanned: 0, removedDirs: [], removedFiles: [] };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return result;
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(root, entry.name);
    try {
      const info = await stat(dirPath);
      dirs.push({ name: entry.name, dirPath, mtimeMs: info.mtimeMs });
    } catch {
      /* 目录在这期间被别处删掉了，跳过 */
    }
  }
  result.scanned = dirs.length;
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (let index = 0; index < dirs.length; index += 1) {
    const item = dirs[index];
    if (index >= keepRuns) {
      try {
        await rm(item.dirPath, { recursive: true, force: true });
        result.removedDirs.push(item.name);
      } catch {
        /* 删不掉就留到下次 */
      }
      continue;
    }
    if (index < keepScreenshots) continue;
    let files;
    try {
      files = await readdir(item.dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
      try {
        await rm(path.join(item.dirPath, file), { force: true });
        result.removedFiles.push(path.join(item.name, file));
      } catch {
        /* 同上 */
      }
    }
  }
  return result;
}