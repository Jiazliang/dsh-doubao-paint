/**
 * DeepSeek Harness 豆包网页生图操控插件 (dsh-doubao-paint) — 常量与预设
 *
 * 与 `dsh-doubao-image` 的常量逐项对齐，仅把「浏览器后端」相关文案从 Tabbit 换成本机 Chrome
 * （chrome-devtools-mcp CLI），其余取值、顺序、语义完全保持不变。
 *
 * @module dsh-doubao-paint/constants
 */

// 浏览器后端：`auto` 是**面向他人的公共默认**（ego 探测到就用 ego，否则回落 chrome）；
// 本机用户想固定 ego 就显式写 `browserBackend: 'ego'`。
export const DEFAULT_BROWSER_BACKEND = 'auto';
export const BROWSER_BACKENDS = Object.freeze(['auto', 'ego', 'chrome']);

export const DEFAULT_DOUBAO_URL = 'https://www.doubao.com/chat/';
export const DEFAULT_ASPECT_RATIO = '16:9';
export const DEFAULT_STYLE = 'auto';
export const DEFAULT_OUTPUT_DIR = 'doubao_images';
export const DEFAULT_TIMEOUT_MS = 120000;

/** 轮询豆包生成结果的间隔（毫秒），与参考实现一致。 */
export const POLL_INTERVAL_MS = 2500;

/**
 * 超时预算（单一真源）：`timeoutMs` 是「等豆包出图」的预算，
 * 轮询只允许吃掉其中 `POLL_BUDGET_RATIO`，其余留给截图、下载与附件注入，
 * 避免「轮询把预算吃光 → 明明有图却报超时」。
 */
export const POLL_BUDGET_RATIO = 0.85;

/** 单张图下载的硬上限（毫秒），与用户配置的 timeoutMs 无关。 */
export const DOWNLOAD_TIMEOUT_MS = 45000;

/** 工具调用的超时时间 = 配置预算 + 固定的收尾开销，并夹在上下界之间。 */
export const TOOL_TIMEOUT_OVERHEAD_MS = 30000;
export const TOOL_TIMEOUT_FLOOR_MS = 60000;
export const TOOL_TIMEOUT_CEILING_MS = 300000;

/** 把配置里的 `timeoutMs` 换算成宿主工具层 timeout（毫秒）。 */
export function resolveToolTimeoutMs(timeoutMs) {
  const base = Number(timeoutMs);
  const budget = Number.isFinite(base) && base > 0 ? base : DEFAULT_TIMEOUT_MS;
  const raw = Math.round(budget + TOOL_TIMEOUT_OVERHEAD_MS);
  return Math.min(TOOL_TIMEOUT_CEILING_MS, Math.max(TOOL_TIMEOUT_FLOOR_MS, raw));
}

/** 会话历史最多保留条数。 */
export const MAX_HISTORY = 30;

/** 单次生图最多等待的图片张数上限（与参考实现一致：1..8）。 */
export const MAX_IMAGES_LIMIT = 8;

/** 下载豆包原图时携带的 Referer 与 User-Agent（参考实现沿用值，禁改）。 */
export const DOWNLOAD_REFERER = 'https://www.doubao.com/';
export const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';

/** Chrome 持久化用户目录（Stage 1 写死；Stage 2 才暴露成配置项）。 */
export const CHROME_PROFILE_DIRNAME = 'doubao-chrome-profile';

export const SUPPORTED_ASPECT_RATIOS = Object.freeze([
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '21:9',
]);

export const STYLE_PRESETS = Object.freeze([
  Object.freeze({ id: 'auto', labelZh: '智能匹配', labelEn: 'Auto', promptHint: '' }),
  Object.freeze({
    id: 'cinematic-cg',
    labelZh: '电影级 CG',
    labelEn: 'Cinematic CG',
    promptHint: '电影级 CG 渲染，极致光影质感，8K 超高清细节，Octane Render',
  }),
  Object.freeze({
    id: 'photorealistic',
    labelZh: '写实摄影',
    labelEn: 'Photorealistic',
    promptHint: '大师级写实摄影，自然景深，真实皮肤与材质纹理，徕卡镜头光学质感',
  }),
  Object.freeze({
    id: 'cyberpunk',
    labelZh: '赛博朋克',
    labelEn: 'Cyberpunk',
    promptHint: '赛博朋克霓虹未来主义，冷暖高对比光效，雨夜反射，未来科技感',
  }),
  Object.freeze({
    id: 'chinese-ink',
    labelZh: '国风水墨',
    labelEn: 'Chinese Ink',
    promptHint: '东方美学新国风水墨意境，留白构图，宣纸纹理，淡雅晕染',
  }),
  Object.freeze({
    id: 'anime',
    labelZh: '动漫二次元',
    labelEn: 'Anime Illustration',
    promptHint: '高品质新海诚/吉卜力动画电影风格，通透光感，细腻色彩与云层光影',
  }),
  Object.freeze({
    id: '3d-isometric',
    labelZh: '3D 微缩盲盒',
    labelEn: '3D Isometric C4D',
    promptHint: 'C4D + Blender 3D 盲盒潮玩渲染，柔和全局光照，磨砂亚克力与细腻粘土材质',
  }),
  Object.freeze({
    id: 'minimal-editorial',
    labelZh: '极简矢量插画',
    labelEn: 'Minimalist Editorial',
    promptHint: '现代极简扁平矢量插画，高级配色，几何构图，干净利落的设计感',
  }),
]);

export const DEFAULT_SYSTEM_PROMPT_TEXT = [
  '## 豆包网页版 AI 生图能力 (Doubao Paint Studio)',
  '- 当前环境已启用 `dsh-doubao-paint` 插件，提供原生工具 `doubao_generate_image` 与 `doubao_image_status`。',
  '- 当用户要求使用豆包生图、操控豆包网页画图、生成封面图/配图/插画或检查豆包状态时，请直接调用 `doubao_generate_image`（或 `doubao_image_status`）。',
  '- 若工具返回 `status: "login_required"`，说明 Chrome 中的豆包网页版尚未登录（插件已自动打开豆包登录框并截取二维码/飞书登录画面），请引导用户在 Chrome 的豆包标签页中完成扫码或一键登录后重试。',
].join('\n');

export const IMAGE_MEDIA_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export const EXT_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** `/doubao-paint/file` 路由允许回流的扩展名白名单。 */
export const SERVABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
