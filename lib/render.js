/**
 * 结果适配器层。
 *
 * 各入口（Agent 工具 / HTTP 路由 / 面板）共用同一个执行入口
 * `submitPaintRequest` 与同一份结果契约 `PaintOutcome`，本文件只负责把
 * 同一份 outcome **翻译**成工具需要的形状：
 *
 *   renderToolResult(outcome) → 工具 content 块（只回文字详情，图片由会话图卡呈现）
 *
 * 路由侧直接 `JSON.stringify(outcome)`，无需适配；前端走 `previewUrl` 自取。
 *
 * 纪律：适配器不得自己判断业务状态、不得自己拼业务文案；文案只来自
 * `outcome.message`，图片列表只来自 `outcome.images`。
 */

/**
 * 工具渲染：只回**文字详情**。
 *
 * 图片由客户端 `tool.call.toolview` 图卡（网格 + 折叠详情）呈现——工具结果里
 * 塞缩略图既占上下文，又和会话里的图卡重复。
 */
export function renderToolResult(value) {
  if (!value || typeof value !== 'object') {
    return [{ type: 'text', text: String(value ?? '') }];
  }

  const stripAttachment = (list) =>
    Array.isArray(list)
      ? list.map(({ attachment, ...rest }) => ({ ...rest, attachedToChat: Boolean(attachment) }))
      : undefined;

  const cleanImages = stripAttachment(value.images);
  const cleanScreenshots = stripAttachment(value.screenshots);

  const summaryObj = {
    ...value,
    ...(cleanImages !== undefined ? { images: cleanImages } : {}),
    ...(cleanScreenshots !== undefined ? { screenshots: cleanScreenshots } : {}),
  };

  return [{ type: 'text', text: JSON.stringify(summaryObj, null, 2) }];
}