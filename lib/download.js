/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 高清原图下载与落盘
 *
 * 参考实现在 Playwright 脚本里把图拉成 base64 回传；本插件改为宿主侧 `fetch` 直连豆包 CDN
 * （带 Referer / UA，复用同一套 mediaType 推断与扩展名映射），行为与参考实现逐条对齐。
 *
 * @module dsh-doubao-paint/download
 */
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  DOWNLOAD_REFERER,
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_USER_AGENT,
  EXT_BY_MEDIA_TYPE,
  MAX_HISTORY,
} from './constants.js';

/**
 * 原子落盘：先写同目录下的临时文件，再 rename 到目标名。
 * rename 在同一文件系统内是原子操作，因此不会出现「下载中断留下半张图」。
 */
async function writeFileAtomic(filePath, buffer) {
  const tmpPath = `${filePath}.tmp-${randomUUID().slice(0, 8)}`;
  await writeFile(tmpPath, buffer);
  await rename(tmpPath, filePath);
}

/** 目标名已被占用时追加 `-2`、`-3`…，避免同一毫秒内两次生成互相覆盖。 */
async function uniqueFilePath(directory, baseName, ext, reserved) {
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const name = attempt === 1 ? baseName : `${baseName}-${attempt}`;
    const candidate = path.join(directory, `${name}.${ext}`);
    if (reserved?.has(candidate)) continue;
    try {
      await stat(candidate);
    } catch {
      return { filePath: candidate, filename: `${name}.${ext}` };
    }
  }
  const fallback = `${baseName}-${randomUUID().slice(0, 6)}`;
  return { filePath: path.join(directory, `${fallback}.${ext}`), filename: `${fallback}.${ext}` };
}

/**
 * 下载并落盘一批候选图片，同时写入历史与附件。
 *
 * @param {Array<{ src?: string, width?: number, height?: number, watermarkFree?: boolean, base64?: string, mediaType?: string }>} rawImages
 * @param {{
 *   outputDir: string,
 *   prefix: string,
 *   timestamp: string,
 *   history?: Array<any>,
 *   attachmentsService?: { saveImage?: Function },
 *   prompt?: string,
 *   formattedPrompt?: string,
 *   aspectRatio?: string,
 *   style?: string,
 *   workspace?: string,
 *   sessionId?: string,
 *   fetchImage?: Function,
 *   signal?: AbortSignal
 * }} options
 * @returns {Promise<Array<any>>} 逐图记录（成功项含 filePath，失败项含 error）
 */
export async function downloadImages(rawImages, options = {}) {
  const {
    outputDir,
    prefix,
    timestamp,
    history,
    attachmentsService,
    attachImages = true,
    prompt,
    formattedPrompt,
    aspectRatio,
    style,
    workspace,
    sessionId,
    fetchImage,
    signal,
    downloadTimeoutMs,
  } = options;

  const absOutputDir = outputDir;
  await mkdir(absOutputDir, { recursive: true });

  const savedImages = [];
  const taken = new Set();
  const list = Array.isArray(rawImages) ? rawImages : [];
  const fetchFn = typeof fetchImage === 'function' ? fetchImage : globalThis.fetch;
  const timeoutMs = Number(downloadTimeoutMs) > 0 ? Number(downloadTimeoutMs) : DOWNLOAD_TIMEOUT_MS;

  for (let i = 0; i < list.length; i++) {
    const img = list[i];
    if (!img || (!img.base64 && !img.src)) {
      savedImages.push({
        index: i + 1,
        sourceUrl: img?.src || '',
        error: img?.error || 'missing image data',
      });
      continue;
    }

    let buffer;
    let detectedMediaType = img.mediaType || '';

    if (img.base64) {
      buffer = Buffer.from(img.base64, 'base64');
    } else if (typeof fetchFn === 'function' && img.src) {
      try {
        // 单张图有自己的硬上限：界面卡住时不能让整次生成无限等待
        const timeoutSignal = typeof AbortSignal?.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined;
        const requestSignal = signal && timeoutSignal && typeof AbortSignal.any === 'function'
          ? AbortSignal.any([signal, timeoutSignal])
          : (signal || timeoutSignal);
        const resp = await fetchFn(img.src, {
          headers: {
            Referer: DOWNLOAD_REFERER,
            'User-Agent': DOWNLOAD_USER_AGENT,
          },
          signal: requestSignal,
        });
        if (!resp.ok) {
          savedImages.push({
            index: i + 1,
            sourceUrl: img.src,
            error: `HTTP ${resp.status}`,
          });
          continue;
        }
        detectedMediaType = (resp.headers?.get?.('content-type') || '').split(';')[0].trim();
        const arrBuf = await resp.arrayBuffer();
        buffer = Buffer.from(arrBuf);
      } catch (err) {
        savedImages.push({
          index: i + 1,
          sourceUrl: img.src,
          error: String(err?.message || err),
        });
        continue;
      }
    } else {
      savedImages.push({
        index: i + 1,
        sourceUrl: img.src || '',
        error: 'fetch unavailable',
      });
      continue;
    }

    const urlLower = String(img.src || '').toLowerCase();
    const fallbackType = urlLower.includes('.webp')
      ? 'image/webp'
      : urlLower.includes('.jpg') || urlLower.includes('.jpeg')
        ? 'image/jpeg'
        : 'image/png';
    const mediaType =
      detectedMediaType && EXT_BY_MEDIA_TYPE[detectedMediaType] ? detectedMediaType : fallbackType;
    const ext = EXT_BY_MEDIA_TYPE[mediaType] || 'png';
    const baseName = `${prefix}_${timestamp}_${i + 1}`;
    const { filePath, filename } = await uniqueFilePath(absOutputDir, baseName, ext, taken);
    taken.add(filePath);
    try {
      await writeFileAtomic(filePath, buffer);
    } catch (err) {
      savedImages.push({
        index: i + 1,
        sourceUrl: img.src || '',
        error: `write failed: ${String(err?.message || err)}`,
      });
      continue;
    }

    let attachmentRef;
    if (attachImages && attachmentsService && typeof attachmentsService.saveImage === 'function') {
      try {
        attachmentRef = await attachmentsService.saveImage({
          data: new Uint8Array(buffer),
          mediaType,
        });
      } catch {
        attachmentRef = undefined;
      }
    }

    const watermarkFree = Boolean(img.watermarkFree || urlLower.includes('wm0'));
    const record = {
      index: i + 1,
      filePath,
      filename,
      mediaType,
      sizeBytes: buffer.length,
      width: img.width || 0,
      height: img.height || 0,
      watermarkFree,
      sourceUrl: img.src || '',
      previewUrl: `/doubao-paint/file?path=${encodeURIComponent(filePath)}`,
      createdAt: new Date().toISOString(),
      ...(attachmentRef ? { attachment: attachmentRef } : {}),
    };
    savedImages.push(record);

    if (Array.isArray(history)) {
      history.unshift({
        id: `${timestamp}-${i + 1}`,
        prompt,
        formattedPrompt,
        aspectRatio,
        style,
        workspace: typeof workspace === 'string' ? workspace : '',
        sessionId: typeof sessionId === 'string' ? sessionId : '',
        filePath,
        filename,
        mediaType,
        sizeBytes: buffer.length,
        width: img.width || 0,
        height: img.height || 0,
        watermarkFree,
        previewUrl: record.previewUrl,
        createdAt: record.createdAt,
      });
      if (history.length > MAX_HISTORY) {
        history.length = MAX_HISTORY;
      }
    }
  }

  return savedImages;
}