/**
 * 运行时技能（runtime skill）。
 *
 * 命令与工具解决"怎么执行"，技能解决"模型什么时候该执行、别写错提示词"。
 * 三者最终都落到 `submitPaintRequest`，行为一致。
 */

export const PAINT_SKILL_NAME = 'doubao-paint';

export const PAINT_SKILL_DESCRIPTION =
  '用本机浏览器（优先 ego lite，回落 Chrome）操控豆包网页版生成图片，下载高清原图并注入对话附件。';

export const PAINT_SKILL_WHEN_TO_USE =
  '当用户要求画图、生成插画/海报/封面/头像/场景图，或要求"用豆包生图"、"再出一张"、"换个比例/风格重画"时使用。';

export const PAINT_SKILL_CONTENT = `# 豆包网页生图（doubao-paint）

## 何时用
- 用户要一张图：插画、海报、封面、头像、场景、产品图、梗图。
- 用户说"用豆包生图 / 豆包画一张 / 再出一版 / 换成 16:9 / 换成赛博朋克风"。
- 需要**真实可下载的位图文件**（不是 SVG、不是占位图）。

## 怎么用
1. 首选工具 \`doubao_generate_image\`，参数：
   - \`prompt\`（必填）：把用户的中文描述整理成一段可视化描述（主体、构图、光线、氛围、画风、文字元素）。
   - \`aspectRatio\`：1:1 / 16:9 / 9:16 / 4:3 / 3:4 / 3:2 / 2:3 / 21:9。
   - \`style\`：cinematic-cg / photorealistic / cyberpunk / chinese-ink / anime / 3d-isometric / minimal-editorial，或自定义风格描述。
   - \`negativePrompt\`：不要出现的东西。
   - \`maxImages\`：1–8，默认取插件配置。
2. 不确定浏览器是否已登录时，先调 \`doubao_image_status\`（返回 \`isLoggedIn\` 与 \`health\`）。
3. 用户消息以 \`/doubao-paint <画面描述>\` 开头时（技能手势：宿主会把本说明注入本回合），
   直接按上面的规范**先把描述补全成可用的提示词**，再调用 \`doubao_generate_image\`；不要反问，也不要把斜杠命令本身写进 prompt。

## 提示词纪律（重要）
- **不要**在 \`prompt\` 里再写"生成图片："、"请画一张"这类前缀 —— 插件会自动补一次；重复会被折叠，但会浪费 token。
- 比例/风格写进参数，不要写进 \`prompt\`（写进去会和参数重复）。
- 用户给了具体细节（主体、动作、环境、光线）就原样保留，不要自行删减。

## 结果
- 成功：\`status: "succeeded"\`，\`images[]\` 里每张有 \`filePath\`（绝对路径）、\`previewUrl\`、宽高与字节数；图片已作为附件注入对话。
- 部分成功：\`status: "partial"\`，\`images\` 里含失败项，向用户说明下载了几张、哪张失败。
- 需要登录：\`status: "login_required"\`，把登录方式（扫码或手机号）转告用户，登录后重试即可。
- 失败：看 \`code\`（cli_missing / backend_unavailable / contract_changed / busy / cancelled / rate_limited / no_image / download_failed），按 \`message\` 告诉用户怎么修。

## 纪律
- 不要把图片内容读进上下文做"视觉验收"；用返回的宽高、字节数、状态码说明结果。
- 汇报时给**绝对路径**（\`filePath\`），不要只给文件名。`;

const PAINT_SKILL = {
  name: PAINT_SKILL_NAME,
  description: PAINT_SKILL_DESCRIPTION,
  whenToUse: PAINT_SKILL_WHEN_TO_USE,
  invocation: { modelInvocable: true, userInvocable: true },
  // 宿主 skills 加载器要求 source / provider 都是字符串（缺省会抛
  // `loaded skill "…" source must be a string`，整轮直接失败）。
  source: 'runtime',
  provider: 'doubao-paint',
  content: PAINT_SKILL_CONTENT,
  metadata: { version: '1.3.0' },
};

/**
 * 注册 runtime 技能。
 * @param {object} skills 宿主 skills 服务
 * @returns {() => void} disposer
 */
export function registerPaintSkill(skills) {
  if (!skills || typeof skills.register !== 'function') {
    return () => {};
  }
  const disposer = skills.register(PAINT_SKILL);
  return typeof disposer === 'function' ? disposer : () => {};
}

export { PAINT_SKILL };