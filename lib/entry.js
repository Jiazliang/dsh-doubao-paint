/**
 * 唯一执行入口。
 *
 * 工具、人类命令、HTTP 路由三处都只调这里，因而"通道不同但行为一致"是
 * 结构保证而不是口头约定：参数归一、执行、history 落盘都在这一层完成。
 */

import { normalizeConfig } from './config.js';
import { saveHistory } from './history.js';
import { executeDoubaoAction } from './orchestrator.js';

/** 把三处入口的入参收敛成同一种 request 形状（缺省值只有一份）。 */
export function normalizePaintRequest(request = {}) {
  const mode = request.mode || 'generate';
  const normalized = {
    mode,
    config: request.config,
    skipLock: Boolean(request.skipLock),
  };

  if (mode === 'generate') {
    normalized.prompt = request.prompt;
    normalized.aspectRatio = request.aspectRatio;
    normalized.style = request.style;
    normalized.negativePrompt = request.negativePrompt;
    normalized.outputDir = request.outputDir;
    normalized.filenamePrefix = request.filenamePrefix;
    normalized.maxImages = request.maxImages ?? 4;
    normalized.newConversation =
      request.newConversation === undefined ? true : Boolean(request.newConversation);
    normalized.keepTab = request.keepTab;
    // 工作区（会话 cwd）：history 按它分组，面板据此只显示本工作区的图
    normalized.workspace = typeof request.workspace === 'string' ? request.workspace.trim() : '';
    normalized.sessionId = typeof request.sessionId === 'string' ? request.sessionId.trim() : '';
  }

  return normalized;
}

/**
 * 执行一次豆包生图动作并持久化 history。
 *
 * @param {object} request 未归一化的请求（工具参数 / 命令参数 / 路由 body）
 * @param {object} deps    { ctx, attachments, signal, history }
 * @returns {Promise<object>} PaintOutcome
 */
export async function submitPaintRequest(request, deps = {}) {
  const normalized = normalizePaintRequest(request);
  const outcome = await executeDoubaoAction(normalized, deps);

  // 只有真正落盘的记录才值得写盘；失败/取消都不改 history 文件。
  if (outcome?.status === 'succeeded' && Array.isArray(deps.history) && deps.history.length > 0) {
    try {
      await saveHistory(normalizeConfig(normalized.config).outputDir, deps.history);
    } catch {
      /* 持久化失败不影响本次结果 */
    }
  }

  return outcome;
}