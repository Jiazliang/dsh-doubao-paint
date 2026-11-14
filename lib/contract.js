/**
 * 豆包网页的「契约面」——页面脚本依赖的全部选择器与图片标记。
 *
 * 为什么单独抽出来：豆包改版时最先变的就是 `data-testid` 与 CDN 路径。
 * 把这份表做成单一真源后，
 *   1. 脚本里的字符串全部从这里取（`test/index.test.js` G16 会比对，漏改即红）；
 *   2. 探针把每个选择器的命中数量一起回传，运行时可判定「页面结构变了」。
 *
 * 契约分级（鲁棒性 P1 / docs/robustness-plan.md Layer 0）：
 *   - `required: 'hard'`：缺了就真的生不了图，编排层据此 `contract_changed` fail-fast；
 *   - `required: 'soft'`：缺了只降级——记进结果字段 `degraded:[]`，链路继续。
 * 只有「能写进输入框」和「能按发送」是生图必需；工作区 chip、新建会话、技能按钮、
 * 登录入口缺失时，旧会话照样能把图发出去。
 *
 * @module dsh-doubao-paint/contract
 */

/**
 * 语义目标表：键名即探针回传的字段名，也是 `degraded` 里的条目名。
 *
 * `semantic` 是给后续「语义定位」用的弱特征（role / aria-label / 文本 / 相对位置），
 * 当前版本只登记不消费。
 */
export const CONTRACT_TARGETS = Object.freeze({
  loginButton: {
    selectors: Object.freeze(['[data-testid="to_login_button"]']),
    semantic: Object.freeze({ role: 'button', text: ['登录', 'Log in', 'Sign in'] }),
    required: 'soft',
  },
  loginModal: {
    selectors: Object.freeze(['[data-testid="login_content"]']),
    semantic: Object.freeze({ role: 'dialog', text: ['登录', '扫码'] }),
    required: 'soft',
  },
  workMode: {
    selectors: Object.freeze([
      '[data-testid="create_office_task_button"]',
      '[data-testid="chat_input_action_mode"]',
    ]),
    semantic: Object.freeze({ role: 'button', text: ['工作模式', '豆包'] }),
    required: 'soft',
  },
  workspaceChip: {
    selectors: Object.freeze(['button[data-testid="workspace-switch-chip"]']),
    semantic: Object.freeze({ role: 'button', text: ['豆包'] }),
    required: 'soft',
  },
  newConversation: {
    selectors: Object.freeze(['[data-testid="create_conversation_button"]']),
    semantic: Object.freeze({ role: 'button', ariaLabel: ['新建对话', 'New chat'] }),
    required: 'soft',
  },
  skillButton: {
    selectors: Object.freeze(['[data-testid="skill_bar_button_3"]']),
    semantic: Object.freeze({ role: 'button', text: ['图像生成', '图片生成'] }),
    required: 'soft',
  },
  inputEditor: {
    selectors: Object.freeze([
      'textarea[data-testid="chat_input_input"]',
      '[data-testid="chat_input_input"] .ProseMirror',
      '.ProseMirror[contenteditable="true"]',
    ]),
    semantic: Object.freeze({ editable: true, ariaLabel: ['输入', '描述你想要的图片'] }),
    required: 'hard',
  },
  sendButton: {
    selectors: Object.freeze(['[data-testid="chat_input_send_button"]', '[data-testid="send_button"]']),
    semantic: Object.freeze({ role: 'button', ariaLabel: ['发送', 'Send'], text: ['发送'] }),
    required: 'hard',
  },
});

/** 页面脚本依赖的选择器（键名即探针返回的字段名，值为逗号分隔的多候选选择器）。 */
export const DOUBAO_SELECTORS = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTRACT_TARGETS).map(([id, target]) => [id, target.selectors.join(', ')]),
  ),
);

/** `required: 'hard'` 的语义目标名：缺了整条链路就真的跑不动。 */
export const HARD_SELECTORS = Object.freeze(
  Object.entries(CONTRACT_TARGETS)
    .filter(([, target]) => target.required === 'hard')
    .map(([id]) => id),
);

/** `required: 'soft'` 的语义目标名：缺了只记降级。 */
export const SOFT_SELECTORS = Object.freeze(
  Object.entries(CONTRACT_TARGETS)
    .filter(([, target]) => target.required === 'soft')
    .map(([id]) => id),
);

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

/**
 * 骨架阶段的 hard 契约：**空集**。
 *
 * 骨架里的两个目标（workspaceChip / newConversation）都只是「开新会话更方便」，
 * 旧的对话窗口照样能发图，所以它们一律 soft；骨架阶段没有 hard 目标可判失败。
 */
export const SHELL_HARD_SELECTORS = Object.freeze([]);

/** 骨架阶段的 soft 契约：缺失只记 degraded，不中断链路。 */
export const SHELL_SOFT_SELECTORS = SHELL_SELECTORS;

/** 输入区：对话框渲染出来之后必须存在（sendButton 只在有草稿时才渲染，故不算本阶段必需）。 */
export const COMPOSER_SELECTORS = Object.freeze(['inputEditor']);

/** 探针阶段的必需选择器（向后兼容的默认值：hard 集合）。 */
export const REQUIRED_SELECTORS = HARD_SELECTORS;

/**
 * 统计缺失的选择器。
 * @param {Record<string, number>} [report] 探针回传的 `contract` 字段
 * @param {readonly string[]} [required] 该阶段要求命中的键，默认 hard 集合
 * @returns {{ ok: boolean, missing: string[], total: number }}
 */
export function missingSelectors(report = {}, required = REQUIRED_SELECTORS) {
  const counts = report && typeof report === 'object' ? report : {};
  const list = Array.isArray(required) ? required : [];
  const missing = list.filter((id) => !(Number(counts[id]) > 0));
  const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0);
  return { ok: missing.length === 0, missing, total };
}

/**
 * soft 目标缺失清单——即结果里 `degraded` 字段的内容。
 *
 * 探针没回传统计时（旧版脚本 / 测试桩）返回空数组：不据此判降级。
 *
 * @param {Record<string, number>} [report] 探针回传的 `contract` 字段
 * @param {readonly string[]} [names] 要检查的 soft 目标名，默认全部 soft
 * @returns {string[]}
 */
export function softDegradations(report = {}, names = SOFT_SELECTORS) {
  const counts = report && typeof report === 'object' ? report : {};
  if (!report || typeof report !== 'object') return [];
  const list = Array.isArray(names) ? names : [];
  return list.filter((id) => !(Number(counts[id]) > 0));
}

/** hard 目标名 → 人类可读的「这一步要干什么」。 */
const HARD_TARGET_LABELS = Object.freeze({
  inputEditor: '输入框',
  sendButton: '发送按钮',
});

/** 给日志/错误详情用的可读契约清单。 */
export function describeContract() {
  return Object.entries(DOUBAO_SELECTORS).map(([id, selector]) => {
    const required = CONTRACT_TARGETS[id]?.required || 'soft';
    return `${id}[${required}]: ${selector}`;
  });
}

/** hard 目标名的中文标签（错误文案用）。 */
export function describeHardTarget(id) {
  return HARD_TARGET_LABELS[id] || id;
}