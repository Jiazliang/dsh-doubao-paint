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
 * 页面骨架：登录与否、有没有开对话，都应该存在。
 *
 * 注意这里**故意不含登录按钮与输入框**：
 *   - 已登录时 `to_login_button` / `login_content` 本来就不在 DOM 里；
 *   - 豆包首页（引导页）在开新对话之前也没有 `.ProseMirror` 输入框。
 * 把这两类放进「必需」，会把正常页面误判成改版（2026-11-07 真机踩到）。
 */
export const SHELL_SELECTORS = Object.freeze(['workspaceChip', 'newConversation']);

/** 输入区：对话框渲染出来之后必须存在（sendButton 只在有草稿时才渲染，故不算必需）。 */
export const COMPOSER_SELECTORS = Object.freeze(['inputEditor']);

/** 探针阶段（尚未开对话）的必需选择器。 */
export const REQUIRED_SELECTORS = SHELL_SELECTORS;

/**
 * 统计缺失的选择器。
 * @param {Record<string, number>} [report] 探针回传的 `contract` 字段
 * @param {readonly string[]} [required] 该阶段要求命中的键，默认骨架
 * @returns {{ ok: boolean, missing: string[], total: number }}
 */
export function missingSelectors(report = {}, required = REQUIRED_SELECTORS) {
  const counts = report && typeof report === 'object' ? report : {};
  const missing = required.filter((id) => !(Number(counts[id]) > 0));
  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { ok: missing.length === 0, missing, total };
}

/** 给日志/错误详情用的可读契约清单。 */
export function describeContract() {
  return Object.entries(DOUBAO_SELECTORS).map(([id, selector]) => `${id}: ${selector}`);
}