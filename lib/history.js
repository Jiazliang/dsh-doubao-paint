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

/** 默认输出目录的目录名（`<workspace>/doubao_images`），用于推断旧记录的工作区。 */
export const DEFAULT_OUTPUT_DIRNAME = 'doubao_images';

/**
 * 给没有 `workspace` 字段的旧记录推断工作区。
 *
 * 图片落在 `<workspace>/<outputDirName>/xxx.png`，所以取图片所在目录的父目录即可；
 * 只在「图片目录名等于输出目录名」时推断，避免把任意路径的父目录当成工作区。
 */
export function inferWorkspaceFromFilePath(filePath, outputDirName = DEFAULT_OUTPUT_DIRNAME) {
  if (typeof filePath !== 'string' || !filePath.trim()) return '';
  const imageDir = path.dirname(filePath.trim());
  if (!outputDirName || path.basename(imageDir).toLowerCase() !== outputDirName.toLowerCase()) return '';
  const parent = path.dirname(imageDir);
  return parent && parent !== imageDir ? parent : '';
}

/** 批量回填 `workspace`（不修改入参，返回新数组）。 */
export function backfillWorkspace(list, { outputDirName = DEFAULT_OUTPUT_DIRNAME } = {}) {
  return (Array.isArray(list) ? list : []).map((item) => {
    if (!item || typeof item !== 'object') return item;
    const current = typeof item.workspace === 'string' ? item.workspace.trim() : '';
    if (current) return item.workspace === current ? item : { ...item, workspace: current };
    const inferred = inferWorkspaceFromFilePath(item.filePath, outputDirName);
    return inferred ? { ...item, workspace: inferred } : item;
  });
}

/**
 * 读回 history。任何异常都当作「没有历史」——插件不该因为一个坏 JSON 起不来。
 *
 * 读回时顺手给 v1.3.x 及更早落盘的记录回填 `workspace`，否则面板会把所有旧图
 * 都塞进「未标记工作区」，按工作区分组的修复对存量数据等于没生效。
 *
 * @returns {Promise<Array<object>>} 记录数组（最多 MAX_HISTORY 条，新的在前）
 */
export async function loadHistory(outputDir, { cwd = process.cwd(), limit = MAX_HISTORY } = {}) {
  const filePath = historyFilePath(outputDir, cwd);
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed?.images) ? parsed.images : Array.isArray(parsed) ? parsed : [];
    const outputDirName = path.basename(resolveOutputDirectory(outputDir, cwd));
    return backfillWorkspace(list, { outputDirName })
      .filter((item) => item && typeof item === 'object')
      .slice(0, limit);
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

/** 旧记录没有工作区字段时的分组标签。 */
export const UNLABELED_WORKSPACE_LABEL = '未标记工作区';

/**
 * 工作区标签：取目录名（`D:\\a\\b` → `b`），根路径回落完整路径。
 * 记录里没有 `workspace` 时（v1.3.x 及更早落盘的记录）归入「未标记工作区」。
 */
export function workspaceLabel(workspace) {
  const raw = typeof workspace === 'string' ? workspace.trim() : '';
  if (!raw) return UNLABELED_WORKSPACE_LABEL;
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) return raw;
  return path.basename(trimmed) || trimmed;
}

/**
 * 按工作区把 history 分组，供面板分区域展示。
 *
 * 排序：当前工作区永远置顶，其余按最近生成时间倒序（无时间戳时按条数、标签兜底）。
 * `count` 是该工作区的真实图片总数，`images` 只为传输截断到 `perGroupLimit` 张。
 *
 * @param {Array<object>} list history 记录（新的在前）
 * @param {{ currentWorkspace?: string, perGroupLimit?: number }} [options]
 * @returns {Array<{key: string, label: string, count: number, latestAt: string, current: boolean, images: Array<object>}>}
 */
export function groupHistoryByWorkspace(list, { currentWorkspace = '', perGroupLimit = 24 } = {}) {
  const groups = new Map();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const key = typeof item.workspace === 'string' ? item.workspace.trim() : '';
    let group = groups.get(key);
    if (!group) {
      group = { key, label: workspaceLabel(key), count: 0, latestAt: '', current: false, images: [] };
      groups.set(key, group);
    }
    group.count += 1;
    if (!group.latestAt && typeof item.createdAt === 'string') group.latestAt = item.createdAt;
    if (group.images.length < perGroupLimit) group.images.push(item);
  }

  const currentKey = typeof currentWorkspace === 'string' ? currentWorkspace.trim() : '';
  const ordered = [...groups.values()].sort((a, b) => {
    if (currentKey) {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
    }
    if (a.latestAt !== b.latestAt) return a.latestAt < b.latestAt ? 1 : -1;
    if (a.count !== b.count) return b.count - a.count;
    return a.label.localeCompare(b.label, 'zh-Hans-CN');
  });
  for (const group of ordered) group.current = Boolean(currentKey) && group.key === currentKey;
  return ordered;
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