/**
 * 豆包网页的「契约面」——页面脚本依赖的全部选择器与图片标记。
 *
 * 为什么单独抽出来：豆包改版时最先变的就是 `data-testid` 与 CDN 路径。
 * 把这份表做成单一真源后，
 *   1. 脚本里的字符串全部从这里取（`test/index.test.js` G16 会比对，漏改即红）；
 *   2. 探针把每个选择器的命中数量一起回传，运行时可判定「页面结构变了」，
 *      从而返回 `contract_changed`，而不是报一个含糊的超时。
 *
 * @module dsh-doubao-paint/contract
 */

/** 页面脚本依赖的选择器（键名即探针返回的字段名）。 */
export const DOUBAO_SELECTORS = Object.freeze({
  loginButton: '[data-testid="to_login_button"]',
  loginModal: '[data-testid="login_content"]',
  workMode: '[data-testid="create_office_task_button"], [data-testid="chat_input_action_mode"]',
  workspaceChip: 'button[data-testid="workspace-switch-chip"]',
  newConversation: '[data-testid="create_conversation_button"]',
  skillButton: '[data-testid="skill_bar_button_3"]',
  inputEditor: '[data-testid="chat_input_input"] .ProseMirror, .ProseMirror[contenteditable="true"]',
  sendButton: '[data-testid="chat_input_send_button"], [data-testid="send_button"]',
});

/** 生成结果图片在 DOM / URL 上的标记。 */
export const DOUBAO_MARKERS = Object.freeze({
  generatedImage: '/rc_gen_image/',
  watermarkFree: 'wm0.png',
});

/**
 * 判定「页面还在预期形态上」所必需的选择器。
 * 只要全部为 0，就说明不是「未登录」而是页面结构变了。
 */
export const REQUIRED_SELECTORS = Object.freeze([
  'loginButton',
  'loginModal',
  'inputEditor',
  'sendButton',
]);

/**
 * 统计缺失的必需选择器。
 * @param {Record<string, number>} [report] 探针回传的 `contract` 字段
 * @returns {{ ok: boolean, missing: string[], total: number }}
 */
export function missingSelectors(report = {}) {
  const counts = report && typeof report === 'object' ? report : {};
  const missing = REQUIRED_SELECTORS.filter((id) => !(Number(counts[id]) > 0));
  // 一个必需选择器都没命中时，说明是整页结构/路由变了（登录页除外）
  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { ok: missing.length === 0, missing, total };
}

/** 给日志/错误详情用的可读契约清单。 */
export function describeContract() {
  return Object.entries(DOUBAO_SELECTORS).map(([id, selector]) => `${id}: ${selector}`);
}