/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 高清原图下载与落盘
 *
 * 参考实现在 Playwright 脚本里把图拉成 base64 回传；本插件改为宿主侧 `fetch` 直连豆包 CDN
 * （带 Referer / UA，复用同一套 mediaType 推断与扩展名映射），行为与参考实现逐条对齐。
 *
 * @module dsh-doubao-paint/download
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  DOWNLOAD_REFERER,
  DOWNLOAD_USER_AGENT,
  EXT_BY_MEDIA_TYPE,
  MAX_HISTORY,
} from './constants.js';

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
    prompt,
    formattedPrompt,
    aspectRatio,
    style,
    fetchImage,
    signal,
  } = options;

  const absOutputDir = outputDir;
  await mkdir(absOutputDir, { recursive: true });

  const savedImages = [];
  const list = Array.isArray(rawImages) ? rawImages : [];
  const fetchFn = typeof fetchImage === 'function' ? fetchImage : globalThis.fetch;

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
        const resp = await fetchFn(img.src, {
          headers: {
            Referer: DOWNLOAD_REFERER,
            'User-Agent': DOWNLOAD_USER_AGENT,
          },
          signal,
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
    const filename = `${prefix}_${timestamp}_${i + 1}.${ext}`;
    const filePath = path.join(absOutputDir, filename);
    await writeFile(filePath, buffer);

    let attachmentRef;
    if (attachmentsService && typeof attachmentsService.saveImage === 'function') {
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