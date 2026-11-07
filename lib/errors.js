/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 结构化错误码
 *
 * 目标：任何失败路径都给出**稳定的机器可读 code**，让 Agent / 上层脚本不必解析中文文案。
 * 历史兼容：保留原有 `status`（succeeded / login_required / timeout_or_no_image …），
 * 在结果对象上**追加** `code` 字段；旧的消费方不会因此破坏。
 *
 * @module dsh-doubao-paint/errors
 */

/** 全部对外错误码（顺序即文档顺序）。 */
export const PAINT_ERROR_CODES = Object.freeze([
  'ok',
  'login_required',
  'no_image',
  'partial',
  'download_failed',
  'busy',
  'cancelled',
  'cli_missing',
  'backend_unavailable',
  'contract_changed',
  'rate_limited',
  'unknown',
]);

/** 人类可读文案（工具输出 / README 共用，禁止在业务代码里另写一套）。 */
export const PAINT_ERROR_MESSAGES = Object.freeze({
  ok: '成功。',
  login_required: '豆包网页版尚未登录，请先完成扫码或手机号登录后重试。',
  no_image: '等待超时：豆包页面未在限定时间内产出符合条件的高清图。',
  partial: '部分图片下载失败：成功落盘的文件已保存在输出目录，失败项见 images[].error。',
  download_failed: '全部图片下载失败，未能落盘任何文件。',
  busy: '已有一次生图任务在运行，请等它结束后重试（插件同一时间只跑一个浏览器任务）。',
  cancelled: '任务被取消。',
  cli_missing: '未找到可用的浏览器 CLI（ego-browser 或 chrome-devtools）。',
  backend_unavailable: '所选浏览器后端不可用，且没有可回落的后端。',
  contract_changed: '豆包网页结构疑似改版，关键选择器未命中。',
  rate_limited: '豆包返回了限流或需要人工验证的页面。',
  unknown: '未预期错误。',
});

/** 英文文案（面板 / 英文用户）。与中文表一一对应，缺项回落中文。 */
export const PAINT_ERROR_MESSAGES_EN = Object.freeze({
  ok: 'Success.',
  login_required: 'Doubao Web is not signed in. Scan the QR code or sign in, then retry.',
  no_image: 'Timed out: Doubao did not produce a qualifying high-resolution image in time.',
  partial: 'Some images failed to download. Saved files are in the output directory; failed items are listed in images[].error.',
  download_failed: 'All image downloads failed; nothing was saved.',
  busy: 'Another generation is already running. The plugin runs one browser task at a time.',
  cancelled: 'The task was cancelled.',
  cli_missing: 'No usable browser CLI found (ego-browser or chrome-devtools).',
  backend_unavailable: 'The selected browser backend is unavailable and there is no fallback.',
  contract_changed: 'Doubao page structure looks changed; key selectors were not found.',
  rate_limited: 'Doubao returned a rate-limit or human-verification page.',
  unknown: 'Unexpected error.',
});

/**
 * 取某错误码的文案。
 * @param {string} code
 * @param {'zh'|'en'} [lang] 缺省 zh；未知语言回落 zh。
 */
export function errorMessage(code, lang = 'zh') {
  const safe = PAINT_ERROR_CODES.includes(code) ? code : 'unknown';
  if (lang === 'en') return PAINT_ERROR_MESSAGES_EN[safe] || PAINT_ERROR_MESSAGES[safe];
  return PAINT_ERROR_MESSAGES[safe];
}

/** 带 code 的错误对象，供内部 throw / 上层 catch 使用。 */
export class PaintError extends Error {
  /**
   * @param {string} code 见 PAINT_ERROR_CODES
   * @param {string} [message] 覆盖默认文案
   * @param {object} [details] 附加信息（会原样进结果对象的 details 字段）
   */
  constructor(code, message, details) {
    const safe = PAINT_ERROR_CODES.includes(code) ? code : 'unknown';
    super(message || PAINT_ERROR_MESSAGES[safe] || PAINT_ERROR_MESSAGES.unknown);
    this.name = 'PaintError';
    this.code = safe;
    if (details && typeof details === 'object') this.details = details;
  }
}

/**
 * 把任意异常归类成错误码。
 *
 * 归类只看**可验证的信号**（err.code / err.name / 文案关键字），不做语义猜测：
 * - `AbortError` / `aborted` → cancelled
 * - `ENOENT` 且提到 CLI 路径 → cli_missing
 * - chrome-devtools / ego 的 CLI 执行失败 → 由调用方带 code 抛 PaintError，这里只兜底
 * - 选择器相关文案（无法把提示词写入 / 无法提交生图指令）→ contract_changed
 * - 其余 → unknown
 */
export function classifyError(err) {
  if (err instanceof PaintError) return err.code;
  const code = typeof err?.code === 'string' ? err.code : '';
  const name = typeof err?.name === 'string' ? err.name : '';
  const text = String(err?.message || err || '');
  if (code === 'ABORT_ERR' || name === 'AbortError' || /aborted|cancelled|canceled/i.test(text)) {
    return 'cancelled';
  }
  if (code === 'EGO_CLI_MISSING' || code === 'CHROME_CLI_MISSING') return 'cli_missing';
  if (code === 'EGO_TIMEOUT') return 'unknown';
  if (/无法把提示词写入|无法提交生图指令|hasLoginModal|selector/i.test(text)) {
    return 'contract_changed';
  }
  if (/ENOENT/.test(code) || /not found|不存在|无法定位/i.test(text)) return 'cli_missing';
  if (/429|rate.?limit|验证码|captcha/i.test(text)) return 'rate_limited';
  return 'unknown';
}

/**
 * 统一的结果包装：成功与失败都走这里，保证 `status` / `code` / `message` 三件套齐全。
 *
 * @param {'succeeded'|'login_required'|'timeout_or_no_image'|'partial'|'failed'|'busy'|'cancelled'} status
 * @param {string} code
 * @param {object} payload
 */
export function withCode(status, code, payload = {}) {
  const safeCode = PAINT_ERROR_CODES.includes(code) ? code : 'unknown';
  return {
    ...payload,
    status,
    code: safeCode,
    message:
      typeof payload.message === 'string' && payload.message.length > 0
        ? payload.message
        : PAINT_ERROR_MESSAGES[safeCode],
  };
}

/** 失败结果：`status:'failed'` + 归类后的 code。 */
export function failureResult(err, extra = {}) {
  const code = classifyError(err);
  return withCode('failed', code, {
    message: String(err?.message || PAINT_ERROR_MESSAGES[code]),
    ...(err?.details ? { details: err.details } : {}),
    ...extra,
  });
}