/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 提示词与落盘路径工具
 *
 * 纯函数层，全部逐行对齐 `dsh-doubao-image` 的同名实现。
 *
 * @module dsh-doubao-paint/prompt
 */
import path from 'node:path';
import { DEFAULT_OUTPUT_DIR, STYLE_PRESETS } from './constants.js';

/**
 * 解包 Schemastery `.volatile()` 包装的响应式配置值。
 */
export function unwrapVolatile(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value;
}

/**
 * 解析风格预设为提示词增强描述。
 */
export function resolveStyleHint(styleInput) {
  if (typeof styleInput !== 'string') return '';
  const trimmed = styleInput.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto') return '';
  const matched = STYLE_PRESETS.find(
    (p) =>
      p.id.toLowerCase() === trimmed.toLowerCase() ||
      p.labelZh === trimmed ||
      p.labelEn.toLowerCase() === trimmed.toLowerCase(),
  );
  return matched ? matched.promptHint : trimmed;
}

/** 画图指令前缀（用于判重；与参考实现的判据等价）。 */
const DRAW_PREFIX_RE =
  /^(?:请?(?:帮我)?(?:生成|画|绘制|创作|设计)(?:一张|一幅|一组)?(?:图片|图像|插画|海报|封面)?|generate\s+an?\s+image|draw\s+)/iu;

/** 带冒号的画图指令前缀（用于去重嵌套前缀）。 */
const DRAW_PREFIX_COLON_RE =
  /^(?:请)?(?:帮我)?(?:生成|画|绘制|创作|设计)(?:一张|一幅|一组)?(?:图片|图像|插画|海报|封面)?\s*[：:]\s*/iu;

/**
 * 折叠重复的画图前缀：`生成图片：请生成图片：一只猫` → `请生成图片：一只猫`。
 * 只在外层前缀带冒号、且内层仍是画图指令时才折叠，避免误伤「生成器架构」这类正文。
 */
export function collapseDrawPrefix(rawPrompt) {
  if (typeof rawPrompt !== 'string') return '';
  let text = rawPrompt.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  // 循环折叠：`生成图片：生成图片：请生成图片：一只猫` 这类多层嵌套要一次剥净。
  for (let guard = 0; guard < 8; guard += 1) {
    const outer = DRAW_PREFIX_COLON_RE.exec(text);
    if (!outer) break;
    const rest = text.slice(outer[0].length).trim();
    if (!rest) break;
    if (!DRAW_PREFIX_RE.test(rest)) break;
    text = rest;
  }
  return text;
}

/**
 * 构建发送给豆包网页版的完整生图指令文本。
 *
 * @param {string} rawPrompt
 * @param {{
 *   aspectRatio?: string,
 *   style?: string,
 *   negativePrompt?: string,
 *   useSkillPrefix?: boolean
 * }} [options]
 * @returns {string}
 */
export function buildDoubaoPrompt(rawPrompt, options = {}) {
  const collapsed = collapseDrawPrefix(rawPrompt);
  const cleaned = typeof collapsed === 'string' ? collapsed.replace(/\s+/g, ' ').trim() : '';
  if (!cleaned) {
    throw new Error('doubao_generate_image: prompt must be a non-empty string');
  }

  const ratio =
    typeof options.aspectRatio === 'string' && options.aspectRatio.trim().length > 0
      ? options.aspectRatio.trim()
      : '';
  const styleHint = resolveStyleHint(options.style);
  const negative =
    typeof options.negativePrompt === 'string' && options.negativePrompt.trim().length > 0
      ? options.negativePrompt.trim()
      : '';

  const alreadyHasDrawPrefix = DRAW_PREFIX_RE.test(cleaned);
  const head =
    options.useSkillPrefix === false || alreadyHasDrawPrefix
      ? cleaned
      : `请生成图片：${cleaned}`;

  const suffixes = [];
  if (styleHint && !cleaned.includes('画面风格：') && !cleaned.includes(styleHint)) {
    suffixes.push(`画面风格：${styleHint}`);
  }
  if (ratio && !cleaned.includes('画面比例：') && !cleaned.includes(ratio)) {
    suffixes.push(`画面比例：${ratio}`);
  }
  if (negative) {
    suffixes.push(`避免出现：${negative}`);
  }

  if (suffixes.length === 0) {
    return head;
  }
  return `${head}（${suffixes.join('；')}）`;
}

/**
 * 提取豆包生成图 URL 的唯一内容哈希键（例如 `/rc_gen_image/<hash>`），用于对同一张图的
 * 带水印版（`cgen_lwm3`）与无水印画布版（`cgen_wm0`）进行去重并优先选择无水印原图。
 */
export function extractDoubaoImageKey(src) {
  if (typeof src !== 'string') return '';
  const m = /\/rc_gen_image\/([^.~/?#]+)/i.exec(src);
  if (m && m[1]) return `rc_gen_image:${m[1]}`;
  return src.split('?')[0];
}

/**
 * 按域名与绝对路径解析输出目录（相对路径以工作区为基准）。
 */
export function resolveOutputDirectory(outputDir, cwd = process.cwd()) {
  const value = typeof outputDir === 'string' ? outputDir.trim() : '';
  const base = value.length > 0 ? value : DEFAULT_OUTPUT_DIR;
  return path.isAbsolute(base) ? base : path.resolve(cwd, base);
}

/**
 * 清洗文件名前缀（与参考实现逐字符等价：只保留 ASCII 字母、数字、下划线、横线，最长 40）。
 */
export function sanitizeFilenamePrefix(prefix = 'doubao') {
  const cleaned = String(prefix || 'doubao')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return cleaned || 'doubao';
}