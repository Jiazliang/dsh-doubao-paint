/**
 * 结果适配器层。
 *
 * 三个入口（Agent 工具 / 人类命令 / HTTP 路由）共用同一个执行入口
 * `submitPaintRequest` 与同一份结果契约 `PaintOutcome`，本文件只负责把
 * 同一份 outcome **翻译**成各入口需要的形状：
 *
 *   renderToolResult(outcome)    → 工具 content 块（text + image 附件块）
 *   renderCommandResult(outcome) → 命令结果（人读摘要 + 机器可读尾行）
 *   （路由侧直接 JSON.stringify outcome，无需适配）
 *
 * 纪律：适配器不得自己判断业务状态、不得自己拼业务文案；文案只来自
 * `outcome.message` 与 `PAINT_ERROR_MESSAGES`，图片列表只来自 `outcome.images`。
 */

import { PAINT_ERROR_MESSAGES } from './errors.js';

/** 命令文本里机器可读尾行的前缀；客户端 commandview 靠它解析图卡。 */
export const COMMAND_PAYLOAD_PREFIX = 'doubao-paint:v1 ';

/** 工具渲染：text 块（脱敏后的 outcome JSON）+ 图片附件块。 */
export function renderToolResult(value) {
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

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function summarizeImages(images) {
  return images.map((img, index) => {
    const dims = img.width && img.height ? `${img.width}×${img.height}` : '尺寸未知';
    const size = humanBytes(img.sizeBytes);
    return `${index + 1}. ${img.filename || '(未命名)'} · ${dims}${size ? ` · ${size}` : ''} · ${img.filePath || img.previewUrl || ''}`;
  });
}

/**
 * 命令渲染：人读摘要 + 机器可读尾行。
 *
 * 尾行只在有图片时附加（客户端 commandview 据此渲染图卡；CLI 里它就是一串
 * 紧凑 JSON，不会破坏可读性）。
 */
export function renderCommandResult(outcome) {
  if (!outcome || typeof outcome !== 'object') {
    return { kind: 'error', text: PAINT_ERROR_MESSAGES.unknown };
  }

  const status = String(outcome.status || 'unknown');
  const code = String(outcome.code || 'unknown');
  const message = outcome.message || PAINT_ERROR_MESSAGES[code] || PAINT_ERROR_MESSAGES.unknown;
  const images = Array.isArray(outcome.images) ? outcome.images : [];

  const lines = [`豆包生图：${status}（${code}）`, message];

  if (outcome.prompt) lines.push(`提示词：${outcome.prompt}`);
  if (outcome.formattedPrompt && outcome.formattedPrompt !== outcome.prompt) {
    lines.push(`实际提交：${outcome.formattedPrompt}`);
  }
  if (outcome.aspectRatio) lines.push(`比例：${outcome.aspectRatio}`);
  if (outcome.style) lines.push(`风格：${outcome.style}`);
  if (outcome.outputDir) lines.push(`输出目录：${outcome.outputDir}`);
  if (images.length > 0) lines.push(`已保存 ${images.length} 张：`, ...summarizeImages(images));
  if (outcome.requestId) lines.push(`请求：${outcome.requestId}`);

  const isOk = status === 'succeeded' || status === 'partial';
  const text = lines.filter(Boolean).join('\n');

  if (images.length === 0) {
    return { kind: isOk ? 'success' : 'error', text };
  }

  return {
    kind: isOk ? 'success' : 'error',
    text: `${text}\n${COMMAND_PAYLOAD_PREFIX}${encodeCommandPayload(outcome)}`,
  };
}

/** 客户端与测试共用的 payload 编码：只搬运展示所需字段。 */
export function encodeCommandPayload(outcome) {
  const images = Array.isArray(outcome?.images) ? outcome.images : [];
  return JSON.stringify({
    v: 1,
    status: String(outcome?.status || 'unknown'),
    outputDir: outcome?.outputDir || '',
    images: images.map((img) => ({
      filename: img.filename || '',
      previewUrl: img.previewUrl || '',
      width: Number(img.width) || 0,
      height: Number(img.height) || 0,
      sizeBytes: Number(img.sizeBytes) || 0,
    })),
  });
}

/** 从命令文本里取出机器可读尾行；没有或不合法都返回 null。 */
export function decodeCommandPayload(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (!line.startsWith(COMMAND_PAYLOAD_PREFIX)) return null;
    const raw = line.slice(COMMAND_PAYLOAD_PREFIX.length).trim();
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.images)) return null;
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}