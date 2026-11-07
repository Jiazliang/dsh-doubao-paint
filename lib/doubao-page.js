/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 页面侧脚本与选图算法
 *
 * 参考实现 `dsh-doubao-image` 把整段自动化写成一个 Tabbit Playwright 脚本；本插件把它拆成
 * 若干个「一次性页面脚本」，由宿主通过 `chrome-devtools` CLI 的 `evaluate_script --format=script`
 * 逐步执行。**选择器、判定规则、轮询跳出条件、选图打分规则全部逐行对齐**，只是分段执行。
 *
 * 所有脚本都是「自执行函数表达式」文本，参数用 JSON.stringify 内联注入，避免 CLI 的 --args
 * （它传的是 snapshot uid，不是业务值）。
 *
 * @module dsh-doubao-paint/doubao-page
 */
import { extractDoubaoImageKey } from './prompt.js';
import { DOUBAO_SELECTORS, COMPOSER_SELECTORS } from './contract.js';

/**
 * 收集当前页面所有 `<img>` 的候选信息（与参考实现 `collectPageImages` 一致）。
 */
const COLLECT_IMAGES_FN = `
const collectPageImages = () => {
  return Array.from(document.querySelectorAll('img')).map((img) => {
    const r = img.getBoundingClientRect();
    return {
      src: img.currentSrc || img.src || '',
      width: img.width || 0,
      height: img.height || 0,
      naturalWidth: img.naturalWidth || 0,
      naturalHeight: img.naturalHeight || 0,
      clientWidth: Math.round(r.width),
      clientHeight: Math.round(r.height),
      alt: img.alt || '',
      complete: Boolean(img.complete),
    };
  });
};

const extractKeyInPage = (src) => {
  const m = new RegExp('/rc_gen_image/([^.~/?#]+)', 'i').exec(String(src || ''));
  return m && m[1] ? 'rc_gen_image:' + m[1] : String(src || '').split('?')[0];
};

// 页面侧初筛：与参考实现脚本内 filterNewImages 一致（垃圾图 / 缩略图 / 尺寸 / complete / wm0 打分 + 哈希去重）
const filterPageImages = (list) => {
  const httpRe = new RegExp('^https?://', 'i');
  const byKey = new Map();
  for (const item of list) {
    const src = String((item && item.src) || '').trim();
    if (!src || !httpRe.test(src)) continue;
    const lower = src.toLowerCase();
    if (
      lower.includes('-cthumb') ||
      lower.includes('/rc/icon/') ||
      lower.includes('/static/image/') ||
      lower.includes('avatar') ||
      lower.includes('qrcode') ||
      lower.includes('favicon') ||
      lower.endsWith('.svg')
    ) {
      continue;
    }
    const isRcGen = lower.includes('/rc_gen_image/');
    if (!isRcGen && ((item.clientWidth || 0) < 120 || (item.clientHeight || 0) < 120)) continue;
    const w = Math.max(item.naturalWidth || 0, item.width || 0);
    const h = Math.max(item.naturalHeight || 0, item.height || 0);
    if (!item.complete || w < 360 || h < 360) continue;

    const key = extractKeyInPage(src);
    const watermarkFree = lower.includes('wm0');
    const qualityScore = lower.includes('wm0.png') ? 3 : watermarkFree ? 2 : 1;
    const rec = { src, width: w, height: h, alt: item.alt || '', watermarkFree, qualityScore };
    const prev = byKey.get(key);
    if (!prev || (prev.qualityScore || 0) < qualityScore) {
      byKey.set(key, rec);
    }
  }
  return Array.from(byKey.values());
};
`;

/**
 * 同步版「清理推广弹窗」：参考实现用 Playwright 的 Escape + 最后一个按钮点击，页面内等价实现。
 */
const DISMISS_PROMO_FN = `
const dismissPromoDialogs = () => {
  let dismissed = 0;
  try {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    for (const dlg of dialogs) {
      const txt = dlg.innerText || '';
      if (txt.includes('下载豆包电脑版') || txt.includes('解锁本地任务能力')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true }));
        const buttons = dlg.querySelectorAll('button');
        const closeBtn = buttons[buttons.length - 1];
        if (closeBtn) {
          closeBtn.click();
        }
        dismissed += 1;
      }
    }
  } catch {}
  return dismissed;
};
`;

function asScript(body) {
  return `(async () => {\n${body}\n})()`;
}

/**
 * 步骤 0：等待豆包页面可用（readyState + 关键节点出现）。
 *
 * 参考实现靠 Playwright 的 locator 自动等待；CLI 侧的 `new_page` 一返回就执行脚本，
 * 此时 SPA 往往还没挂载完，探测会把「还没渲染出登录按钮」误判成已登录。
 */
export function buildWaitReadyScript(options = {}) {
  const payload = { timeoutMs: Number(options.timeoutMs) || 20000 };
  return asScript(
    `
const P = ${JSON.stringify(payload)};
const deadline = Date.now() + P.timeoutMs;
let readyState = document.readyState;
let hasAnchor = false;
while (Date.now() < deadline) {
  readyState = document.readyState;
  hasAnchor = Boolean(
    document.querySelector('[data-testid="chat_input_input"], .ProseMirror, [data-testid="to_login_button"], [data-testid="login_content"]'),
  );
  if (readyState === 'complete' && hasAnchor) break;
  await new Promise((r) => setTimeout(r, 300));
}
return {
  status: 'succeeded',
  readyState,
  hasAnchor,
  pageUrl: location.href,
  pageTitle: document.title,
};
`.trim(),
  );
}

/**
 * 步骤 1：探测登录态 / 工作模式 / 技能按钮 / 输入框，并回传基准图片集合。
 *
 * @param {{ openLogin?: boolean }} [options]
 */
export function buildProbeScript(options = {}) {
  const payload = { openLogin: Boolean(options.openLogin), contract: DOUBAO_SELECTORS };
  return asScript(
    `
const P = ${JSON.stringify(payload)};
${DISMISS_PROMO_FN}
${COLLECT_IMAGES_FN}
const dismissedPromoCount = dismissPromoDialogs();

const loginBtn = document.querySelector('[data-testid="to_login_button"]');
const loginModal = document.querySelector('[data-testid="login_content"]');
const isLoggedIn = !loginBtn && !loginModal;

if (!isLoggedIn && !loginModal && loginBtn && P.openLogin) {
  try { loginBtn.click(); } catch {}
  await new Promise((r) => setTimeout(r, 400));
}

const workMode = !!document.querySelector(
  '[data-testid="create_office_task_button"], [data-testid="chat_input_action_mode"]',
);
const skillButton = document.querySelector('[data-testid="skill_bar_button_3"]');
const editor =
  document.querySelector('[data-testid="chat_input_input"] .ProseMirror') ||
  document.querySelector('.ProseMirror[contenteditable="true"]');

return {
  status: 'succeeded',
  isLoggedIn,
  contract: Object.fromEntries(Object.entries(P.contract).map(([k, sel]) => [k, document.querySelectorAll(sel).length])),
  hasLoginButton: Boolean(loginBtn),
  hasLoginModal: Boolean(loginModal),
  pageUrl: location.href,
  pageTitle: document.title,
  workMode,
  skillAvailable: Boolean(skillButton),
  workModeChipCount: document.querySelectorAll('button[data-testid="workspace-switch-chip"]').length,
  inputReady: Boolean(editor),
  dismissedPromoCount,
  images: collectPageImages(),
};
`.trim(),
  );
}

/**
 * 步骤 3.5：对话打开后复查输入区（骨架存在 ≠ 输入框已渲染）。
 *
 * 只做**单次快照**，不在脚本内部轮询：
 * 点「新对话」可能触发整页路由切换，旧执行上下文里的 DOM 会被丢弃，
 * 脚本内的 `while` 会一直读到 0。重试放在编排层（每次 evaluate 都是新上下文）。
 */
export function buildComposerProbeScript(options = {}) {
  const keys = [...COMPOSER_SELECTORS, 'sendButton'];
  const map = Object.fromEntries(keys.filter((key) => DOUBAO_SELECTORS[key]).map((key) => [key, DOUBAO_SELECTORS[key]]));
  const P = { required: COMPOSER_SELECTORS, map, ...options };
  return asScript(
    `
const P = ${JSON.stringify(P)};
const contract = {};
for (const [key, selector] of Object.entries(P.map)) {
  contract[key] = document.querySelectorAll(selector).length;
}
return {
  ok: P.required.every((key) => contract[key] > 0),
  contract,
  pageUrl: location.href,
  readyState: document.readyState,
};
`.trim(),
  );
}

/**
 * 步骤 2：从「豆包工作（云电脑）」慢速模式切回标准生图模式。
 */
export function buildSwitchWorkModeScript() {
  return asScript(
    `
${DISMISS_PROMO_FN}
const chips = Array.from(document.querySelectorAll('button[data-testid="workspace-switch-chip"]'));
const stdChip = chips.find((el) => (el.innerText || '').includes('豆包')) || chips[0];
if (!stdChip) return { ok: false, reason: 'chip_not_found' };
stdChip.click();
await new Promise((r) => setTimeout(r, 1200));
return { ok: true, chipText: (stdChip.innerText || '').trim() };
`.trim(),
  );
}

/**
 * 步骤 3：开启新对话。
 */
export function buildNewConversationScript() {
  return asScript(
    `
const btn = document.querySelector('[data-testid="create_conversation_button"]');
if (!btn) return { ok: false, reason: 'new_conversation_button_not_found' };
btn.click();
await new Promise((r) => setTimeout(r, 1000));
return { ok: true };
`.trim(),
  );
}

/**
 * 步骤 4：点击「图像生成」技能快捷按钮（`skill_bar_button_3`），并二次检查登录框。
 */
export function buildSkillScript() {
  return asScript(
    `
const btn = document.querySelector('[data-testid="skill_bar_button_3"]');
let clicked = false;
if (btn) {
  const visible = !!(btn.offsetWidth || btn.offsetHeight || btn.getClientRects().length);
  if (visible) {
    btn.click();
    clicked = true;
    await new Promise((r) => setTimeout(r, 600));
  }
}
const hasLoginModal = !!document.querySelector('[data-testid="login_content"]');
return { ok: clicked, clicked, hasLoginModal };
`.trim(),
  );
}

/**
 * 步骤 5：定位 `.ProseMirror` 编辑器并写入生图提示词。
 *
 * @param {{ prompt: string }} params
 */
export function buildInputScript(params = {}) {
  const payload = { prompt: String(params.prompt || '') };
  return asScript(
    `
const P = ${JSON.stringify(payload)};
const editor =
  document.querySelector('[data-testid="chat_input_input"] .ProseMirror') ||
  document.querySelector('.ProseMirror[contenteditable="true"]');
if (!editor) return { ok: false, reason: 'editor_not_found' };

editor.focus();

const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
const expected = norm(P.prompt);
const readText = () => norm(editor.innerText);

const placeCaretAtEnd = () => {
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {}
};

// 先清空编辑器里残留的草稿：浏览器标签页里的输入框可能留着上一轮或用户手动输入的
// 文本，直接插到光标处会拼成「生成图片：请生成图片：…」这样的重复前缀。
const preexisting = readText();
let cleared = false;
if (preexisting.length > 0) {
  try {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    sel.removeAllRanges();
    sel.addRange(range);
    cleared = document.execCommand('delete');
  } catch {}
  if (!cleared) {
    try {
      editor.innerHTML = '<p></p>';
      editor.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
      cleared = true;
    } catch {}
  }
}

placeCaretAtEnd();
try {
  editor.dispatchEvent(
    new InputEvent('beforeinput', { inputType: 'insertText', data: P.prompt, bubbles: true, cancelable: true }),
  );
} catch {}

let inserted = false;
try {
  inserted = document.execCommand('insertText', false, P.prompt);
} catch {}

// 自愈：只要写进去的文本与期望不一致（残留、重复、被截断），直接整体替换再核一遍。
if (readText() !== expected) {
  try {
    editor.innerHTML = '<p>' + P.prompt.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>';
    editor.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: P.prompt, bubbles: true }));
    inserted = true;
    placeCaretAtEnd();
  } catch {}
  await new Promise((r) => setTimeout(r, 200));
}

await new Promise((r) => setTimeout(r, 400));
const finalText = readText();
return {
  ok: finalText.length > 0 && finalText === expected,
  inserted,
  cleared,
  preexistingLength: preexisting.length,
  textLength: finalText.length,
  textHead: finalText.slice(0, 120),
  matches: finalText === expected,
};
`.trim(),
  );
}

/**
 * 步骤 6：点击发送按钮；不可用时回退为 Enter 提交。
 */
export function buildSendScript() {
  return asScript(
    `
const editor =
  document.querySelector('[data-testid="chat_input_input"] .ProseMirror') ||
  document.querySelector('.ProseMirror[contenteditable="true"]');
const btn =
  document.querySelector('[data-testid="chat_input_send_button"]') ||
  document.querySelector('[data-testid="send_button"]');
if (btn && !btn.disabled && !btn.getAttribute('aria-disabled')) {
  btn.click();
  return { ok: true, via: 'button' };
}
if (editor) {
  for (const type of ['keydown', 'keypress', 'keyup']) {
    editor.dispatchEvent(
      new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }),
    );
  }
  return { ok: true, via: 'enter' };
}
return { ok: false, reason: 'neither_button_nor_editor' };
`.trim(),
  );
}

/**
 * 步骤 7：轮询取图（每轮返回当前页面全部 img 候选 + 登录框状态）。
 */
export function buildCollectScript() {
  return asScript(
    `
${COLLECT_IMAGES_FN}
return {
  status: 'succeeded',
  hasLoginModal: !!document.querySelector('[data-testid="login_content"]'),
  pageUrl: location.href,
  images: filterPageImages(collectPageImages()),
};
`.trim(),
  );
}

/**
 * 步骤 8：超时兜底，回传页面正文末尾 800 字用于诊断。
 */
export function buildTailTextScript() {
  return asScript(`return { tailText: (document.body.innerText || '').slice(-800) };`);
}

/**
 * 从候选 `<img>` 列表中筛出「本轮新生成的 AI 高清大图」，按图像哈希去重并优先 `wm0`。
 *
 * 与参考实现 `filterGeneratedImageCandidates` 完全一致（含故意的缺陷：不判 `item.complete`）。
 *
 * @param {Array<object>} candidates
 * @param {Iterable<string>} [baselineUrls]
 * @returns {Array<{ src: string, width: number, height: number, alt: string, watermarkFree: boolean }>}
 */
export function filterGeneratedImageCandidates(candidates, baselineUrls = []) {
  if (!Array.isArray(candidates)) return [];
  const baseline = new Set(Array.from(baselineUrls || []).filter(Boolean));
  const baselineKeys = new Set(Array.from(baseline).map((u) => extractDoubaoImageKey(u)));
  const byKey = new Map();

  for (const item of candidates) {
    if (!item || typeof item.src !== 'string') continue;
    const src = item.src.trim();
    if (!src || !/^https?:\/\//i.test(src)) continue;
    if (baseline.has(src)) continue;

    const lower = src.toLowerCase();
    if (
      lower.includes('-cthumb') ||
      lower.includes('/rc/icon/') ||
      lower.includes('/static/image/') ||
      lower.includes('avatar') ||
      lower.includes('qrcode') ||
      lower.includes('favicon') ||
      lower.endsWith('.svg')
    ) {
      continue;
    }

    const isRcGenImage = lower.includes('/rc_gen_image/');
    if (
      !isRcGenImage &&
      typeof item.clientWidth === 'number' &&
      typeof item.clientHeight === 'number' &&
      (item.clientWidth < 120 || item.clientHeight < 120)
    ) {
      continue;
    }

    const w = Math.max(Number(item.naturalWidth) || 0, Number(item.width) || 0);
    const h = Math.max(Number(item.naturalHeight) || 0, Number(item.height) || 0);
    if (w < 360 || h < 360) {
      continue;
    }

    const key = extractDoubaoImageKey(src);
    if (baselineKeys.has(key)) continue;

    const watermarkFree = lower.includes('wm0');
    const qualityScore = lower.includes('wm0.png') ? 3 : watermarkFree ? 2 : 1;
    const candidateRecord = {
      src,
      width: w,
      height: h,
      alt: typeof item.alt === 'string' ? item.alt : '',
      watermarkFree,
      qualityScore,
    };

    const existing = byKey.get(key);
    if (!existing || (existing.qualityScore || 0) < qualityScore) {
      byKey.set(key, candidateRecord);
    }
  }

  return Array.from(byKey.values()).map(({ qualityScore: _q, ...rest }) => rest);
}

/**
 * 选图入口：过滤 + 截断到 maxImages。
 *
 * @param {Array<object>} candidates
 * @param {Iterable<string>} baselineUrls
 * @param {number} maxImages
 */
export function pickImages(candidates, baselineUrls = [], maxImages = 4) {
  const limit = Math.max(1, Math.min(Number(maxImages) || 4, 8));
  return filterGeneratedImageCandidates(candidates, baselineUrls).slice(0, limit);
}

/**
 * 判断本轮候选是否满足「可以认为生成结束」的跳出条件（与参考实现的 while 循环一致）。
 *
 * @param {Array<{ watermarkFree: boolean }>} candidates
 * @param {{ stableRounds: number, maxImages: number }} state
 */
export function shouldStopPolling(candidates, state) {
  if (!Array.isArray(candidates) || candidates.length === 0) return false;
  const allWatermarkFree = candidates.every((c) => c && c.watermarkFree);
  if (allWatermarkFree && state.stableRounds >= 1) return true;
  if (state.stableRounds >= 3) return true;
  return candidates.length >= Math.max(1, Math.min(Number(state.maxImages) || 4, 8));
}