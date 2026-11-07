/**
 * dsh-doubao-paint 离线验收测试
 *
 * 运行：`node --test test/index.test.js`（不要传目录，Windows 下目录形式会 MODULE_NOT_FOUND）
 *
 * 全部断言都是 headless 数值/结构断言：不起浏览器、不读图片内容（用户级硬规则 2026-10-29）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import {
  apply,
  normalizeConfig,
  Config,
  renderDoubaoToolOutput,
  executeDoubaoAction,
  buildDoubaoPrompt,
  resolveStyleHint,
  resolveOutputDirectory,
  extractDoubaoImageKey,
  filterGeneratedImageCandidates,
  pickImages,
  isInsideDirectory,
  resolveImageRequest,
  resolveToolTimeoutMs,
  buildHealthReport,
  inspectOutputDir,
  PLUGIN_VERSION,
  DEFAULT_BROWSER_BACKEND,
  PAINT_ERROR_CODES,
  PAINT_ERROR_MESSAGES_EN,
  PaintError,
  classifyError,
  errorMessage,
  // v1.1.0：统一入口 / 适配器 / 命令 / 技能
  normalizePaintRequest,
  submitPaintRequest,
  renderToolResult,
  PAINT_SKILL,
  registerPaintSkill,
} from '../lib/index.js';
import { sanitizeFilenamePrefix } from '../lib/prompt.js';
import {
  buildProbeScript,
  buildInputScript,
  buildSendScript,
  buildSkillScript,
  buildNewConversationScript,
  buildCollectScript,
  buildSwitchWorkModeScript,
  buildWaitReadyScript,
  shouldStopPolling,
} from '../lib/doubao-page.js';
import {
  daemonMatchesOptions,
  parseDaemonArgs,
  resolveDefaultChromeCliPath,
} from '../lib/chrome-cli.js';
import {
  EgoCliError,
  buildEgoInvocation,
  createEgoSession,
  parseEgoPayload,
  resolveDefaultEgoCliPath,
} from '../lib/ego-cli.js';
import {
  HISTORY_FILENAME,
  historyFilePath,
  loadHistory,
  mergeHistory,
  pruneRunDirs,
  saveHistory,
} from '../lib/history.js';

const noopCtx = { attachments: undefined };

// ── G1 配置归一化 ────────────────────────────────────────────────────────────
test('G1: normalizeConfig 归一化 + volatile 解包 + 超时夹取', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.doubaoUrl, 'https://www.doubao.com/chat/');
  assert.equal(defaults.defaultAspectRatio, '16:9');
  assert.equal(defaults.defaultStyle, 'auto');
  assert.equal(defaults.outputDir, 'doubao_images');
  assert.equal(defaults.timeoutMs, 120000);
  assert.equal(defaults.keepTab, true);
  assert.equal(defaults.injectSystemPrompt, true);
  assert.ok(defaults.chromeCliPath.length > 0, 'chromeCliPath 必须有默认解析结果');
  assert.equal('taskName' in defaults, false, 'taskName 必须已被删除');

  const wrapped = normalizeConfig({
    enabled: { get: () => false },
    defaultAspectRatio: { get: () => '21:9' },
    timeoutMs: { get: () => 5 },
    defaultStyle: { get: () => 'cyberpunk' },
  });
  assert.equal(wrapped.enabled, false);
  assert.equal(wrapped.defaultAspectRatio, '21:9');
  assert.equal(wrapped.timeoutMs, 30000);
  assert.equal(wrapped.defaultStyle, 'cyberpunk');

  assert.equal(normalizeConfig({ timeoutMs: 999999 }).timeoutMs, 180000);
  assert.equal(normalizeConfig({ defaultAspectRatio: '7:5' }).defaultAspectRatio, '16:9');
});

// ── G2 提示词组装 ───────────────────────────────────────────────────────────
test('G2: buildDoubaoPrompt 前缀/比例/风格/负面词', () => {
  const plain = buildDoubaoPrompt('  一只  橘猫  ', {
    aspectRatio: '4:3',
    style: 'cinematic-cg',
    negativePrompt: '模糊、多手指',
  });
  assert.match(plain, /^请生成图片：一只 橘猫/);
  assert.match(plain, /画面比例：4:3/);
  assert.match(plain, /画面风格：电影级 CG 渲染/);
  assert.match(plain, /避免出现：模糊、多手指/);

  const already = buildDoubaoPrompt('生成一张赛博朋克城市夜景');
  assert.equal(already.startsWith('请生成图片：'), false);

  const english = buildDoubaoPrompt('draw a cat');
  assert.equal(english.startsWith('请生成图片：'), false);

  // 重复前缀折叠 + 幂等：同一提示词重复格式化不得叠加「生成图片：」与画面风格块
  const doubled = buildDoubaoPrompt('生成图片：请生成图片：一只猫', {
    aspectRatio: '16:9',
    style: 'cinematic-cg',
  });
  assert.equal(doubled.match(/生成图片：/g).length, 1, '重复前缀必须折叠为一次');
  const once = buildDoubaoPrompt('一只猫', { aspectRatio: '16:9', style: 'cinematic-cg' });
  assert.equal(buildDoubaoPrompt(once, { aspectRatio: '16:9', style: 'cinematic-cg' }), once);
  assert.equal(once.match(/画面风格：/g).length, 1, '风格块不得重复追加');

  // 多层嵌套也必须一次剥净（页面输入框残留会叠出 2 层以上）
  const triple = buildDoubaoPrompt('生成图片：生成图片：请生成图片：一只猫', { aspectRatio: '16:9' });
  assert.equal(triple.match(/生成图片：/g).length, 1, '多层嵌套前缀必须折叠为一次');
  assert.equal(triple, buildDoubaoPrompt('一只猫', { aspectRatio: '16:9' }));

  assert.throws(() => buildDoubaoPrompt('   '), /non-empty/);
  assert.equal(resolveStyleHint('auto'), '');
  assert.match(resolveStyleHint('cinematic-cg'), /电影级 CG/);
  assert.equal(resolveStyleHint('自定义水彩'), '自定义水彩');
});

// ── G3 选图过滤 ─────────────────────────────────────────────────────────────
test('G3: filterGeneratedImageCandidates / pickImages 去重与 wm0 优先', () => {
  const baseline = ['https://p3.doubao.com/rc_gen_image/oldhash.png'];
  const raw = [
    { src: baseline[0], naturalWidth: 1080, naturalHeight: 1080 },
    { src: 'https://p3.doubao.com/rc_gen_image/newhash.png', naturalWidth: 1024, naturalHeight: 1024 },
    {
      src: 'https://p3.doubao.com/rc_gen_image/newhash.png~wm0.png',
      naturalWidth: 2048,
      naturalHeight: 2048,
    },
    {
      src: 'https://p3.doubao.com/rc_gen_image/small.png',
      naturalWidth: 200,
      naturalHeight: 200,
    },
    { src: 'https://p3.doubao.com/static/image/logo.png', naturalWidth: 900, naturalHeight: 900 },
    { src: 'https://p3.doubao.com/avatar/x.png', naturalWidth: 900, naturalHeight: 900 },
    { src: 'data:image/png;base64,AAA', naturalWidth: 900, naturalHeight: 900 },
  ];

  const out = filterGeneratedImageCandidates(raw, baseline);
  assert.equal(out.length, 1, '同一图像哈希只保留评分最高的一张');
  assert.match(out[0].src, /~wm0\.png$/);
  assert.equal(out[0].watermarkFree, true);
  assert.equal(out[0].width, 2048);
  assert.equal('qualityScore' in out[0], false);

  assert.equal(pickImages(raw, baseline, 1).length, 1);
  assert.equal(pickImages([], baseline, 4).length, 0);
  assert.equal(extractDoubaoImageKey('https://p3.doubao.com/rc_gen_image/abc.png~wm0.png'), 'rc_gen_image:abc');
});

test('G3b: shouldStopPolling 跳出条件', () => {
  const wm0 = [{ watermarkFree: true }, { watermarkFree: true }];
  assert.equal(shouldStopPolling(wm0, { stableRounds: 0, maxImages: 4 }), false);
  assert.equal(shouldStopPolling(wm0, { stableRounds: 1, maxImages: 4 }), true);
  assert.equal(shouldStopPolling([{ watermarkFree: false }], { stableRounds: 2, maxImages: 4 }), false);
  assert.equal(shouldStopPolling([{ watermarkFree: false }], { stableRounds: 3, maxImages: 4 }), true);
  assert.equal(shouldStopPolling(wm0, { stableRounds: 0, maxImages: 2 }), true);
  assert.equal(shouldStopPolling([], { stableRounds: 3, maxImages: 4 }), false);
});

// ── G4 页面脚本内容 ─────────────────────────────────────────────────────────
test('G4: 页面脚本包含关键选择器且为异步 IIFE', () => {
  const scripts = {
    ready: buildWaitReadyScript({ timeoutMs: 5000 }),
    probe: buildProbeScript({ openLogin: true }),
    input: buildInputScript({ prompt: '一只猫' }),
    send: buildSendScript(),
    skill: buildSkillScript(),
    conversation: buildNewConversationScript(),
    collect: buildCollectScript(),
  };

  for (const [key, source] of Object.entries(scripts)) {
    assert.match(source, /^\(async \(\) => \{/, `${key} 必须是异步 IIFE`);
  }

  assert.match(scripts.probe, /to_login_button/);
  assert.match(scripts.probe, /login_content/);
  assert.match(scripts.probe, /dismissPromoDialogs|dismiss/i);
  assert.match(scripts.probe, /"openLogin":true/);
  assert.doesNotMatch(buildProbeScript({ openLogin: false }), /"openLogin":true/);
  assert.match(scripts.skill, /skill_bar_button_3/);
  assert.match(scripts.conversation, /create_conversation_button/);
  assert.match(scripts.send, /chat_input_send_button/);
  assert.match(scripts.input, /chat_input_input/);
  // 输入脚本必须先清空残留草稿、并校验最终文本与期望完全一致，否则旧草稿会被拼在前面
  // （线上表现：「生成图片：请生成图片：…」这种重复前缀）。
  assert.match(scripts.input, /execCommand\('delete'\)/);
  assert.match(scripts.input, /preexistingLength/);
  assert.match(scripts.input, /matches/);
  assert.match(scripts.input, /ok: finalText\.length > 0 && finalText === expected/);
  assert.match(scripts.collect, /rc_gen_image/);
  assert.match(scripts.ready, /readyState/);
  assert.match(scripts.ready, /to_login_button/);
  assert.match(scripts.ready, /"timeoutMs":5000/);
});

// ── G5 编排器：成功路径（mock 浏览器） ──────────────────────────────────────
async function makeTempDir() {
  return await mkdtemp(path.join(tmpdir(), 'dsh-doubao-paint-'));
}

function makeFakeChrome(overrides = {}) {
  const calls = [];
  const shots = [];
  const baselineSrc = 'https://p3.doubao.com/rc_gen_image/baselinehash.png';
  const fetchCalls = [];

  const chrome = {
    calls,
    shots,
    fetchCalls,
    async ensureDaemon() {
      calls.push('ensureDaemon');
      return { started: true };
    },
    async ensurePage() {
      calls.push('ensurePage');
      return { pageId: 7, created: false, url: 'https://www.doubao.com/chat/' };
    },
    async evaluate(name, source) {
      calls.push(name);
      if (name === '01-probe') {
        return {
          status: 'succeeded',
          isLoggedIn: overrides.isLoggedIn ?? true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          workMode: overrides.workMode ?? false,
          images: [{ src: baselineSrc, naturalWidth: 1080, naturalHeight: 1080 }],
        };
      }
      if (name === '04-skill') return { hasLoginModal: overrides.skillLoginModal ?? false };
      if (name === '05-input') return { ok: true, inserted: true, textLength: 20 };
      if (name === '06-send') return { ok: true, via: 'button' };
      if (name.startsWith('07-collect')) {
        return {
          status: 'succeeded',
          hasLoginModal: overrides.collectLoginModal ?? false,
          pageUrl: 'https://www.doubao.com/chat/abc',
          images: overrides.collectImages ?? [
            {
              src: 'https://p3.doubao.com/rc_gen_image/freshhash.png~wm0.png',
              naturalWidth: 2048,
              naturalHeight: 2048,
            },
          ],
        };
      }
      if (name === '08-tail-text') return { tailText: '豆包页面正在生成…' };
      assert.match(source, /\(async/, `${name} 脚本必须可执行`);
      return { ok: true };
    },
    async screenshot(filePath) {
      calls.push('screenshot');
      shots.push(filePath);
      await (await import('node:fs/promises')).mkdir(path.dirname(filePath), { recursive: true });
      await (await import('node:fs/promises')).writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return 'ok';
    },
    async stop() {
      calls.push('stop');
      return 'stopped';
    },
  };

  const fetchImage = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      headers: { get: () => 'image/webp' },
      arrayBuffer: async () => Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer,
    };
  };

  return { chrome, fetchImage };
}

test('G5: executeDoubaoAction 成功路径落盘/附件/历史/render', async () => {
  const dir = await makeTempDir();
  const { chrome, fetchImage } = makeFakeChrome();
  const history = [];
  const savedAttachments = [];

  const outcome = await executeDoubaoAction(
    {
      mode: 'generate',
      prompt: '一只赛博橘猫',
      aspectRatio: '1:1',
      style: 'cyberpunk',
      config: { outputDir: dir, timeoutMs: 30000, keepTab: true },
    },
    {
      ctx: {
        attachments: {
          saveImage: async (payload) => {
            savedAttachments.push(payload);
            return { id: `att-${savedAttachments.length}` };
          },
        },
      },
      history,
      chrome,
      fetchImage,
      cwd: dir,
    },
  );

  assert.equal(outcome.status, 'succeeded');
  assert.equal(outcome.isLoggedIn, true);
  assert.equal(outcome.imageCount, 1);
  assert.equal(outcome.outputDir, dir);
  assert.match(outcome.formattedPrompt, /赛博朋克/);

  // E5/E6 未被触发（workMode=false、newConversation 默认 true）
  assert.equal(chrome.calls.includes('02-switch-work-mode'), false);
  assert.equal(chrome.calls.includes('03-new-conversation'), true);
  assert.equal(chrome.calls.includes('stop'), false, 'keepTab=true 不得 stop daemon');

  const saved = outcome.images[0];
  // 参考实现的 timestamp = toISOString().replace(/[:.]/g,'-').slice(0,19)，保留字母 T
  assert.match(saved.filename, /^doubao_\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_1\.webp$/);
  assert.equal(saved.mediaType, 'image/webp');
  assert.equal(saved.watermarkFree, true);
  assert.equal(saved.previewUrl, `/doubao-paint/file?path=${encodeURIComponent(saved.filePath)}`);
  assert.ok(saved.attachment.id);
  assert.equal((await stat(saved.filePath)).size, 4);

  assert.equal(fetchImage.callCount, undefined);
  assert.equal(chrome.fetchCalls.length, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].filePath, saved.filePath);
  assert.equal(history[0].prompt, '一只赛博橘猫');

  const shots = outcome.screenshots;
  assert.equal(shots.length, 1);
  assert.match(shots[0].path, /generation\.png$/);
  assert.ok(shots[0].attachment, '截图也应注入附件');

  const blocks = renderDoubaoToolOutput(outcome);
  assert.equal(blocks[0].type, 'text');
  // v1.2.0：工具结果只给文字摘要，图片改由 tool.call.toolview 图卡呈现
  assert.equal(blocks.length, 1, '只保留正文块');
  assert.equal(JSON.parse(blocks[0].text).images[0].attachedToChat, true);

  await rm(dir, { recursive: true, force: true });
});

// ── G5b 编排器：scoped ctx 未 inject attachments 时的服务读取 ────────────────
test('G5b: ctx 未 inject 服务时属性访问抛错，readService 仍能取到 attachments', async () => {
  const dir = await makeTempDir();
  const { chrome, fetchImage } = makeFakeChrome();
  const history = [];
  const saved = [];
  const service = {
    saveImage: async (payload) => {
      saved.push(payload);
      return { id: `att-${saved.length}` };
    },
  };

  // 模拟 Cordis scoped ctx：属性访问一律抛 "cannot get property ... without inject"
  const strictCtx = new Proxy(
    {
      get(name) {
        if (name === 'attachments') return service;
        throw new Error(`unexpected service: ${name}`);
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        throw new Error(`cannot get property "${String(prop)}" without inject`);
      },
    },
  );

  const outcome = await executeDoubaoAction(
    {
      mode: 'generate',
      prompt: '一只猫',
      aspectRatio: '1:1',
      config: { outputDir: dir, timeoutMs: 30000, keepTab: true },
    },
    { ctx: strictCtx, history, chrome, fetchImage, cwd: dir },
  );

  assert.equal(outcome.status, 'succeeded');
  assert.ok(saved.length >= 1, 'images 与截图都应经 ctx.get("attachments") 注入');
  assert.ok(outcome.images[0].attachment, '图片记录应带附件');
  assert.ok(outcome.screenshots[0].attachment, '截图记录应带附件');

  // 服务缺失时不得抛错，降级为纯路径对象
  const bareCtx = new Proxy(
    {},
    { get() { throw new Error('cannot get property "attachments" without inject'); } },
  );
  const bare = await executeDoubaoAction(
    {
      mode: 'generate',
      prompt: '一只猫',
      aspectRatio: '1:1',
      config: { outputDir: dir, timeoutMs: 30000, keepTab: true },
    },
    { ctx: bareCtx, history: [], chrome: makeFakeChrome().chrome, fetchImage, cwd: dir },
  );
  assert.equal(bare.status, 'succeeded');
  assert.equal(bare.images[0].attachment, undefined);
  assert.match(bare.screenshots[0].path, /generation\.png$/);

  await rm(dir, { recursive: true, force: true });
});

// ── G6 编排器：未登录 / 状态模式 / 超时 / keepTab ──────────────────────────
test('G6: 未登录返回 login_required 且不再继续点击流程', async () => {
  const dir = await makeTempDir();
  const { chrome, fetchImage } = makeFakeChrome({ isLoggedIn: false });

  const outcome = await executeDoubaoAction(
    { mode: 'generate', prompt: '一只猫', config: { outputDir: dir, timeoutMs: 30000 } },
    { ctx: noopCtx, history: [], chrome, fetchImage, cwd: dir },
  );

  assert.equal(outcome.status, 'login_required');
  assert.equal(outcome.isLoggedIn, false);
  assert.equal(outcome.requiresLogin, true);
  assert.equal(chrome.calls.includes('03-new-conversation'), false);
  assert.equal(outcome.screenshots.length, 1);
  assert.match(outcome.screenshots[0].path, /login\.png$/);

  await rm(dir, { recursive: true, force: true });
});

test('G6b: status 模式只做探测，open 模式返回已登录', async () => {
  const dir = await makeTempDir();
  const statusChrome = makeFakeChrome({ isLoggedIn: false }).chrome;
  const statusOutcome = await executeDoubaoAction(
    { mode: 'status', config: { outputDir: dir } },
    { ctx: noopCtx, chrome: statusChrome, cwd: dir },
  );
  assert.equal(statusOutcome.status, 'succeeded');
  assert.equal(statusOutcome.isLoggedIn, false);
  assert.deepEqual(statusChrome.calls, ['ensureDaemon', 'ensurePage', '00-wait-ready', '01-probe']);

  const openChrome = makeFakeChrome({ isLoggedIn: true }).chrome;
  const openOutcome = await executeDoubaoAction(
    { mode: 'open', config: { outputDir: dir } },
    { ctx: noopCtx, chrome: openChrome, cwd: dir },
  );
  assert.equal(openOutcome.status, 'succeeded');
  assert.equal(openOutcome.isLoggedIn, true);
  assert.match(openOutcome.message, /已登录/);

  await rm(dir, { recursive: true, force: true });
});

test('G6c: 轮询无图返回 timeout_or_no_image 并透出页面尾部文本', async () => {
  const dir = await makeTempDir();
  const { chrome, fetchImage } = makeFakeChrome({ collectImages: [] });

  const outcome = await executeDoubaoAction(
    {
      mode: 'generate',
      prompt: '一只猫',
      keepTab: false,
      config: { outputDir: dir, timeoutMs: 30000, keepTab: false },
    },
    { ctx: noopCtx, history: [], chrome, fetchImage, cwd: dir },
  );

  assert.equal(outcome.status, 'timeout_or_no_image');
  assert.equal(outcome.imageCount, 0);
  assert.equal(outcome.tailText, '豆包页面正在生成…');
  assert.equal(chrome.calls.includes('stop'), true, 'keepTab=false 必须 stop daemon');

  await rm(dir, { recursive: true, force: true });
});

// ── G7 apply 注册面 ─────────────────────────────────────────────────────────
function makeFakeHostCtx() {
  const registered = { tools: [], sections: [], routes: [], locale: [] };
  const ctx = {
    get: (key) =>
      key === 'locale'
        ? {
            register: (ns, strings) => {
              registered.locale.push({ ns, strings });
            },
          }
        : undefined,
    tools: {
      register: (tool) => {
        registered.tools.push(tool);
      },
    },
    systemPrompt: {
      section: (section) => {
        registered.sections.push(section);
      },
    },
    webServer: {
      register: (route) => {
        registered.routes.push(route);
      },
    },
  };
  return { ctx, registered };
}

test('G7: apply 注册 2 个工具 / 1 条 systemPrompt / 4 条路由 / locale', async () => {
  const { ctx, registered } = makeFakeHostCtx();
  apply(ctx, { enabled: true });

  assert.equal(registered.locale.length, 1);
  assert.equal(registered.locale[0].ns, 'plugin-config.doubao-paint');

  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].name, 'doubao-paint-studio');
  assert.equal(registered.sections[0].order, 220);
  assert.match(registered.sections[0].text, /doubao_generate_image/);

  assert.equal(registered.tools.length, 2);
  const generate = registered.tools.find((tool) => tool.name === 'doubao_generate_image');
  const status = registered.tools.find((tool) => tool.name === 'doubao_image_status');
  assert.ok(generate && status);
  assert.deepEqual(generate.parameters.required, ['prompt']);
  assert.equal(generate.timeoutMs, resolveToolTimeoutMs(normalizeConfig({}).timeoutMs));
  assert.equal(status.timeoutMs, Math.max(60000, Math.round(normalizeConfig({}).timeoutMs / 2) + 20000));
  assert.deepEqual(
    registered.routes.map((route) => route.path).sort(),
    ['/doubao-paint/file', '/doubao-paint/generate', '/doubao-paint/open', '/doubao-paint/status'],
  );
  for (const route of registered.routes) {
    assert.equal(route.kind, 'exact');
    assert.equal(typeof route.handler, 'function');
  }

  // status 路由（不探测浏览器）返回配置与常量面板数据
  const statusRoute = registered.routes.find((route) => route.path.endsWith('/status'));
  let payload;
  await statusRoute.handler(
    {
      url: '/doubao-paint/status',
      on: () => {},
    },
    {
      writeHead: (code, headers) => {
        payload = { code, headers };
      },
      end: (body) => {
        payload.body = JSON.parse(body);
      },
    },
  );
  assert.equal(payload.code, 200);
  assert.equal(payload.body.ok, true);
  assert.equal(payload.body.config.defaultAspectRatio, '16:9');
  assert.equal('taskName' in payload.body.config, false);
  assert.ok(payload.body.config.chromeCliPath.length > 0);
  assert.equal(payload.body.aspectRatios.length, 8);
  assert.equal(payload.body.presets.length, 8);
  assert.deepEqual(payload.body.history, []);
  assert.equal(payload.body.browserStatus, null);

  // generate 路由拒绝非 POST
  const generateRoute = registered.routes.find((route) => route.path.endsWith('/generate'));
  let errorPayload;
  await generateRoute.handler(
    { method: 'GET', url: '/doubao-paint/generate', on: () => {} },
    {
      writeHead: (code) => {
        errorPayload = { code };
      },
      end: (body) => {
        errorPayload.body = JSON.parse(body);
      },
    },
  );
  assert.equal(errorPayload.code, 405);

  // enabled=false 时不注册任何东西
  const disabled = makeFakeHostCtx();
  apply(disabled.ctx, { enabled: false });
  assert.equal(disabled.registered.tools.length, 0);
  assert.equal(disabled.registered.routes.length, 0);
});

// ── G8 client 面板模块结构性验收（假 require，不起浏览器） ─────────────────
test('G8: client buildModule 导出与格式/注册结构正确', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  const buildModule = sandbox.__DSH_DOUBAO_PAINT_BUILD__;
  assert.equal(typeof buildModule, 'function', '必须挂载 __DSH_DOUBAO_PAINT_BUILD__');

  const makeStub = () => new Proxy(function () {}, {
    get: (target, key) => {
      if (key === 'then' || key === Symbol.toPrimitive) return undefined;
      return makeStub();
    },
    apply: () => makeStub(),
  });

  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
    createContext: () => ({ Provider: () => null, Consumer: () => null }),
    Fragment: 'Fragment',
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'Fragment',
  };

  const moduleApi = buildModule((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-store') {
      return { useStore: (store, selector) => (selector ? selector(store.getSnapshot()) : store.getSnapshot()) };
    }
    return makeStub();
  });

  assert.equal(moduleApi.name, 'doubao-paint');
  // vm 跨 realm 的数组原型与本 realm 不同，deepStrictEqual 会因原型不等而失败
  assert.deepEqual(Array.from(moduleApi.inject), ['locale']);
  assert.equal(moduleApi.ASPECT_RATIOS.length, 7);
  assert.equal(
    moduleApi.ASPECT_RATIOS.some((item) => item.id === '21:9'),
    false,
    'client 侧 21:9 缺失是已知 Stage 2 项',
  );
  assert.equal(moduleApi.STYLE_PRESETS.length, 8);

  assert.equal(
    moduleApi.formatAgentCommandPrompt('  一只  猫  ', { aspectRatio: '4:3', style: 'cinematic-cg' }),
    '请调用 `doubao_generate_image` 工具操控豆包网页版生图：一只 猫（比例：4:3，风格：电影级 CG）',
  );
  assert.equal(moduleApi.formatAgentCommandPrompt(''), '');

  // 插入走 slot 下发的 inputActions（宿主 uiSession.provide 的 props.inputActions）
  const insertCalls = [];
  const fakeInputActions = {
    captureInsertion: () => ({ draftRev: 7, offset: 3, length: 0 }),
    insertText: (text, span) => {
      insertCalls.push(['insertText', text, span]);
      return true;
    },
    persistDraft: () => insertCalls.push(['persistDraft']),
  };
  assert.equal(moduleApi.insertIntoComposerDraft({}, 'session-1', '  一只猫  ', fakeInputActions), true);
  assert.equal(insertCalls[0][0], 'insertText');
  assert.equal(insertCalls[0][1], '一只猫\n');
  assert.deepEqual(insertCalls[0][2], { draftRev: 7, offset: 3, length: 0 });
  assert.equal(insertCalls[1][0], 'persistDraft');

  // 只有 setDraft 时的兜底，且同样落持久化
  const draftCalls = [];
  const draftOnly = {
    setDraft: (text) => draftCalls.push(['setDraft', text]),
    persistDraft: () => draftCalls.push(['persistDraft']),
  };
  assert.equal(moduleApi.insertIntoComposerDraft({}, 'session-1', 'hi', draftOnly), true);
  assert.deepEqual(draftCalls[0], ['setDraft', 'hi\n']);
  assert.equal(draftCalls[1][0], 'persistDraft');

  // 既无 inputActions 也无 shell 时必须如实返回 false（不再静默“成功”）
  assert.equal(moduleApi.insertIntoComposerDraft({}, 'session-1', 'x', undefined), false);

  const store = moduleApi.createDoubaoStudioStore();
  assert.equal(typeof store.toggleExpanded, 'function');

  const slots = [];
  const registeredComponents = [];
  const locales = [];
  const effects = [];
  const clientCtx = {
    locale: { register: (ns, strings) => locales.push({ ns, strings }) },
    effect: (fn, label) => {
      effects.push(label);
      fn();
    },
    enableInputDock: true,
    slots: {
      inject: (name, fn) => {
        slots.push(name);
        fn();
      },
      register: (meta, component) => {
        slots.push(meta);
        registeredComponents.push(component);
      },
    },
  };
  moduleApi.apply(clientCtx);

  // 触发条挂在工具行左侧槽（渲染在「工作区内修改」右侧同一行），展开面板挂在 dock 槽（对话框上方）
  assert.deepEqual(slots[0], 'conversation.input.left');
  assert.equal(slots[1].id, 'doubao-paint-studio-chip');
  assert.equal(slots[1].order, 20);
  assert.deepEqual(slots[2], 'conversation.input.dock');
  assert.equal(slots[3].id, 'doubao-paint-studio-dock');
  assert.equal(slots[3].order, -5);
  assert.ok(locales.some((entry) => entry.ns === 'plugin-config.doubao-paint'));
  assert.ok(effects.length >= 2);

  // 触发条：收起态渲染紧凑 pill（与「工作区内修改」同一行），展开态高亮且面板才挂到 dock
  const [chipFactory, dockFactory] = registeredComponents;
  const chipCollapsed = chipFactory({ sessionId: 'session-1' });
  assert.equal(chipCollapsed.type, 'button');
  assert.equal(chipCollapsed.props.className, 'dsh-dbimg-trigger-chip');
  assert.equal(chipCollapsed.props['data-dsh-doubao-chip'], 'collapsed');
  assert.equal(chipCollapsed.props['aria-expanded'], false);
  const chipText = chipCollapsed.props.children.map((child) => child?.props?.children ?? '').join('|');
  assert.ok(chipText.includes('豆包网页生图'), chipText);
  // 无障碍：按钮化 + 可键盘激活 + 屏幕阅读器提示
  assert.equal(chipCollapsed.props.role, 'button');
  assert.equal(chipCollapsed.props.tabIndex, 0);
  assert.match(String(chipCollapsed.props['aria-label'] || ''), /豆包网页生图工坊/);
  assert.match(String(chipCollapsed.props.title || ''), /展开/);
  assert.equal(typeof chipCollapsed.props.onKeyDown, 'function');
  let prevented = false;
  chipCollapsed.props.onKeyDown({
    key: 'Enter',
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true, 'Enter 必须 preventDefault，避免触发表单提交');
  assert.equal(moduleApi.getSessionStore('session-1').getSnapshot().expanded, true, 'Enter 应展开面板');
  moduleApi.getSessionStore('session-1').toggleExpanded();
  assert.equal(moduleApi.getSessionStore('session-1').getSnapshot().expanded, false);
  assert.equal(dockFactory({ sessionId: 'session-1' }), null, '收起态 dock 槽不渲染任何节点');

  moduleApi.getSessionStore('session-1').toggleExpanded();
  const chipExpanded = chipFactory({ sessionId: 'session-1' });
  assert.equal(chipExpanded.props['data-dsh-doubao-chip'], 'expanded');
  assert.equal(chipExpanded.props['aria-expanded'], true);
  const dockExpanded = dockFactory({ sessionId: 'session-1' });
  assert.equal(dockExpanded.props.className, 'dsh-dbimg-dock-wrap');
  assert.equal(dockExpanded.props['data-dsh-doubao-dock'], 'expanded');
  assert.equal(dockExpanded.props.children.props.className, 'dsh-dbimg-panel');
});

// ── G9 其它纯函数 ───────────────────────────────────────────────────────────
test('G9: Config 校验 / 文件名前缀 / 输出目录 / CLI 解析', () => {
  const validated = Config['~standard'].validate({ timeoutMs: 1000, defaultAspectRatio: '21:9' });
  assert.equal(validated.value.timeoutMs, 30000);
  assert.equal(validated.value.defaultAspectRatio, '21:9');

  assert.equal(sanitizeFilenamePrefix('My Cat!@#'), 'My_Cat');
  assert.equal(sanitizeFilenamePrefix(''), 'doubao');
  assert.equal(sanitizeFilenamePrefix('中文前缀'), 'doubao');
  assert.equal(sanitizeFilenamePrefix(undefined), 'doubao');
  assert.equal(sanitizeFilenamePrefix('a'.repeat(80)).length, 40);

  assert.equal(resolveOutputDirectory('out', '/tmp/ws'), path.resolve('/tmp/ws', 'out'));
  assert.equal(resolveOutputDirectory('/abs/dir', '/tmp/ws'), '/abs/dir');
  assert.equal(resolveOutputDirectory('', '/tmp/ws'), path.resolve('/tmp/ws', 'doubao_images'));

  assert.ok(resolveDefaultChromeCliPath().length > 0);
  assert.equal(resolveDefaultChromeCliPath('  /custom/cli  '), '/custom/cli');

  // daemon 参数比对：别的工具起的隔离 daemon 不能被直接复用，否则持久 profile / 有头登录失效
  const statusLine =
    'chrome-devtools-mcp daemon is running.\npid=1 socket=\\\\.\\pipe\\x args=["--viaCli","--headless"]';
  assert.deepEqual(parseDaemonArgs(statusLine), ['--viaCli', '--headless']);
  assert.deepEqual(parseDaemonArgs('no args here'), []);

  const profile = 'C:\\Users\\u\\.dsh\\doubao-chrome-profile';
  const ours = ['--viaCli', '--headless=false', '--userDataDir', profile];
  assert.equal(daemonMatchesOptions(ours, { headless: false, profileDir: profile }), true);
  assert.equal(daemonMatchesOptions(ours, { headless: true, profileDir: profile }), false);
  assert.equal(daemonMatchesOptions(['--viaCli', '--headless'], { headless: false, profileDir: profile }), false);
  assert.equal(
    daemonMatchesOptions(['--headless=false', '--userDataDir', 'C:\\other'], {
      headless: false,
      profileDir: profile,
    }),
    false,
  );
});
test('G10: ego 后端适配器（解析 / 路径探测 / 调用形态 / 无页面守卫 / 截图降级）', async () => {
  // 1) 输出解析：ego 把脚本 console.log 写到 stderr，stdout 常常是空的
  assert.deepEqual(parseEgoPayload('', '{"ok":true,"spaceId":5}\r\n'), { ok: true, spaceId: 5 });
  assert.deepEqual(parseEgoPayload('{"ok":true,"from":"stdout"}', '{"ok":true,"from":"stderr"}'), {
    ok: true,
    from: 'stdout',
  });
  // 列表也是合法载荷（TaskSpace 清单）
  assert.deepEqual(parseEgoPayload('', '[{"id":0},{"id":5}]'), [{ id: 0 }, { id: 5 }]);
  assert.equal(parseEgoPayload('just a banner', ''), null);

  // 2) 路径探测：env 覆盖 → 版本目录取最高 → 都没有则空串
  const fakeExists = (set) => (p) => set.has(p);
  const root = 'C:\\Program Files\\Citro Labs\\ego lite\\Application';
  const v7 = `${root}\\0.6.2.7\\ego-browser.exe`;
  const v6 = `${root}\\0.6.2.6\\ego-browser.exe`;
  const envHit = resolveDefaultEgoCliPath({
    env: { DSH_EGO_CLI_PATH: 'C:\\custom\\ego-browser.exe' },
    platform: 'win32',
    existsSync: fakeExists(new Set(['C:\\custom\\ego-browser.exe'])),
    readdirSync: () => [],
    cache: new Map(),
  });
  assert.equal(envHit, 'C:\\custom\\ego-browser.exe');

  const highest = resolveDefaultEgoCliPath({
    env: {},
    platform: 'win32',
    existsSync: fakeExists(new Set([root, v6, v7])),
    readdirSync: () => [
      { name: '0.6.2.6', isDirectory: true },
      { name: '0.6.2.7', isDirectory: true },
    ],
    cache: new Map(),
  });
  assert.equal(highest, v7);

  assert.equal(
    resolveDefaultEgoCliPath({ env: {}, platform: 'win32', existsSync: () => false, readdirSync: () => [], cache: new Map() }),
    '',
  );

  // 3) 调用形态：.mjs 文件 + nodejs -e "await import(file:///...)"（PowerShell 会吃掉 -e 里的引号）
  const invocation = buildEgoInvocation('C:\\ego\\ego-browser.exe', 'C:\\tmp\\a b\\x.mjs');
  assert.equal(invocation.command, 'C:\\ego\\ego-browser.exe');
  assert.equal(invocation.args[0], 'nodejs');
  assert.equal(invocation.args[1], '-e');
  assert.match(invocation.args[2], /^await import\("file:\/\/\/C:\/tmp\/a b\/x\.mjs"\)$/);
  assert.throws(() => buildEgoInvocation('', 'x.mjs'), (error) => error.code === 'EGO_CLI_MISSING');

  // 4) 会话契约：未 ensurePage 就 evaluate/screenshot 必须拒绝；截图超时降级不抛
  const calls = [];
  const stub = async (cliPath, script, extra) => {
    calls.push({ cliPath, hasAttach: script.includes('async function __attach()'), timeoutMs: extra?.timeoutMs });
    if (script.includes('page.evaluate')) return { ok: true, result: { hello: 'world' } };
    if (script.includes('page.screenshot')) {
      const error = new EgoCliError('timed out', { code: 'EGO_TIMEOUT' });
      throw error;
    }
    if (script.includes('task.spaceId')) return { ok: true, spaceId: 5, spaceName: 'dsh-doubao-paint' };
    return { ok: true, spaceId: 5, label: 'p1', url: 'https://www.doubao.com/chat/1', title: '豆包' };
  };
  const session = createEgoSession({ cliPath: 'C:\\ego\\ego-browser.exe', doubaoUrl: 'https://www.doubao.com/chat/', runScript: stub });
  assert.equal(session.backend, 'ego');
  await assert.rejects(() => session.evaluate('01-probe', '() => 1'), (error) => error.code === 'EGO_NO_PAGE');

  const daemon = await session.ensureDaemon();
  assert.deepEqual(daemon, { running: true, service: 'ego', cliPath: 'C:\\ego\\ego-browser.exe', spaceId: 5, restarted: false });
  const page = await session.ensurePage();
  assert.equal(page.label, 'p1');
  assert.equal(session.pageId, 'p1');
  assert.equal(session.spaceId, 5);

  assert.deepEqual(await session.evaluate('05-input', '(async () => ({ ok: true }))()'), { hello: 'world' });
  assert.ok(calls.every((entry) => entry.hasAttach));

  const shot = await session.screenshot('D:\\ws\\.runs\\x\\generation.png');
  assert.equal(shot.skipped, true);
  assert.equal(shot.reason, 'ego-background-space-has-no-compositor');

  assert.deepEqual(await session.stop(), { stopped: false, reason: 'ego-space-persists' });
});

test('G11: 后端选择 — 公共默认 auto、ego 显式优先、chrome 可强制、探测不到回落', async () => {
  const { createBrowserSession, resolveBrowserBackend } = await import('../lib/orchestrator.js');

  // 面向他人的公共默认是 auto（探测到 ego 就用 ego，否则回落 chrome）
  assert.equal(normalizeConfig({}).browserBackend, 'auto');
  assert.equal(DEFAULT_BROWSER_BACKEND, 'auto');
  // 本机装了 ego，所以 auto / 未指定 都会解析成 ego
  assert.equal(resolveBrowserBackend({}), 'ego');
  assert.equal(resolveBrowserBackend({ browserBackend: 'auto' }), 'ego');
  assert.equal(resolveBrowserBackend({ browserBackend: 'chrome' }), 'chrome');
  // ego 显式要求但探测不到 → 回落 chrome，而不是抛出（第二参注入探测器桩）
  assert.equal(resolveBrowserBackend({ browserBackend: 'ego' }, () => ''), 'chrome');
  assert.equal(resolveBrowserBackend({ browserBackend: 'auto' }, () => ''), 'chrome');
  assert.equal(resolveBrowserBackend({ browserBackend: 'ego', egoCliPath: 'C:\\ego\\ego-browser.exe' }), 'ego');

  const egoSession = createBrowserSession({ browserBackend: 'ego', doubaoUrl: 'https://www.doubao.com/chat/' });
  assert.equal(egoSession.backend, 'ego');
  assert.equal(typeof egoSession.finish, 'function');
  assert.equal(typeof egoSession.evaluate, 'function');

  const chromeSession = createBrowserSession({
    browserBackend: 'chrome',
    chromeCliPath: 'C:\\cli\\chrome-devtools.js',
    doubaoUrl: 'https://www.doubao.com/chat/',
  });
  assert.equal(chromeSession.backend, 'chrome');
  assert.equal(typeof chromeSession.stop, 'function');
  assert.equal(typeof chromeSession.finish, 'undefined');
});

test('G12: /file 路由只服务 history 记录或 outputDir 内的图片', async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), 'dsh-doubao-file-'));
  try {
    const inside = path.join(outputDir, 'inside.png');
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'dsh-doubao-outside-'));
    const outside = path.join(outsideDir, 'secret.png');
    await writeFile(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const history = [
      {
        index: 1,
        filePath: inside,
        filename: 'inside.png',
        attachment: { attachmentId: 'att-1' },
      },
    ];

    const params = (query) => new URLSearchParams(query);

    // id 命中 history 记录
    assert.equal(
      resolveImageRequest(params('id=att-1'), { history, outputDir }).filePath,
      path.resolve(inside),
    );
    const byName = resolveImageRequest(params('id=inside.png'), { history, outputDir });
    assert.equal(byName.filePath, path.resolve(inside));

    // 未知 id
    assert.deepEqual(resolveImageRequest(params('id=nope'), { history, outputDir }), {
      status: 404,
      error: 'Unknown image id',
    });

    // 完全没给参数
    assert.deepEqual(resolveImageRequest(params(''), { history, outputDir }), {
      status: 400,
      error: 'Missing id or path',
    });

    // 相对路径拒绝
    assert.deepEqual(resolveImageRequest(params('path=inside.png'), { history, outputDir }), {
      status: 400,
      error: 'Invalid file path',
    });

    // outputDir 内的绝对路径放行（重启后 history 为空也能预览自己的产物）
    assert.equal(
      resolveImageRequest(params(`path=${encodeURIComponent(inside)}`), { history: [], outputDir })
        .filePath,
      path.resolve(inside),
    );

    // 任意位置的图片一律 403（这条是公开发布的安全底线）
    assert.deepEqual(
      resolveImageRequest(params(`path=${encodeURIComponent(outside)}`), { history, outputDir }),
      { status: 403, error: 'Path is outside the configured output directory' },
    );

    // 目录越界判断本身
    assert.equal(isInsideDirectory(inside, outputDir), true);
    assert.equal(isInsideDirectory(outputDir, outputDir), true);
    assert.equal(isInsideDirectory(outside, outputDir), false);
    assert.equal(isInsideDirectory(path.join(outputDir, '..', 'escape.png'), outputDir), false);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('G13: 结构化错误码 — 归类与结果三件套', async () => {
  assert.ok(PAINT_ERROR_CODES.length >= 12);
  for (const code of ['busy', 'cancelled', 'cli_missing', 'backend_unavailable', 'contract_changed', 'download_failed', 'partial', 'no_image', 'rate_limited']) {
    assert.ok(PAINT_ERROR_CODES.includes(code), `missing code: ${code}`);
  }

  // 显式 code 原样保留
  assert.equal(classifyError(new PaintError('cli_missing')), 'cli_missing');
  // AbortError → cancelled
  const abortErr = new Error('The operation was aborted');
  abortErr.name = 'AbortError';
  assert.equal(classifyError(abortErr), 'cancelled');
  // 选择器失败文案 → contract_changed
  assert.equal(classifyError(new Error('无法把提示词写入豆包输入框（{}）')), 'contract_changed');
  // 限流文案 → rate_limited
  assert.equal(classifyError(new Error('HTTP 429 Too Many Requests')), 'rate_limited');

  // 中英双语文案：每个 code 都有英文条目，未知语言回落中文，未知 code 回落 unknown
  for (const code of PAINT_ERROR_CODES) {
    assert.equal(typeof PAINT_ERROR_MESSAGES_EN[code], 'string', `missing en message: ${code}`);
    assert.ok(PAINT_ERROR_MESSAGES_EN[code].length > 3, `en message too short: ${code}`);
  }
  assert.match(errorMessage('busy', 'en'), /already running/i);
  assert.match(errorMessage('busy'), /已有一次生图任务/);
  assert.match(errorMessage('busy', 'fr'), /已有一次生图任务/);
  assert.equal(errorMessage('not-a-code', 'en'), PAINT_ERROR_MESSAGES_EN.unknown);

  // 编排器把异常收敛成 failed + code，而不是把异常抛给上层
  const abortChrome = {
    async ensureDaemon() {},
    async ensurePage() { return { pageId: 1, url: 'https://www.doubao.com/chat/' }; },
    async evaluate(name) {
      if (name === '01-probe') {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return { ok: true };
    },
    async screenshot() {},
    async stop() {},
  };
  const aborted = await executeDoubaoAction(
    { mode: 'status', config: normalizeConfig({}) },
    { chrome: abortChrome, history: [] },
  );
  assert.equal(aborted.status, 'failed');
  assert.equal(aborted.code, 'cancelled');
  assert.equal(typeof aborted.message, 'string');
});

test('G14: 落盘原子性与同秒重名', async () => {
  const { downloadImages } = await import('../lib/download.js');
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-doubao-atomic-'));
  try {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetchImage = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () => pngBytes,
    });
    const baseOptions = {
      outputDir: dir,
      prefix: 'doubao',
      timestamp: '2026-11-07T12-00-00',
      history: [],
      fetchImage,
    };
    const first = await downloadImages(
      [{ src: 'https://p3.doubao.com/rc_gen_image/a.png~wm0.png', width: 2048, height: 2048 }],
      baseOptions,
    );
    const second = await downloadImages(
      [{ src: 'https://p3.doubao.com/rc_gen_image/b.png~wm0.png', width: 2048, height: 2048 }],
      baseOptions,
    );
    assert.equal(first[0].filename, 'doubao_2026-11-07T12-00-00_1.png');
    assert.equal(second[0].filename, 'doubao_2026-11-07T12-00-00_1-2.png');
    assert.equal((await stat(first[0].filePath)).size, pngBytes.length);
    assert.equal((await stat(second[0].filePath)).size, pngBytes.length);
    // 不留临时文件
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G15: 单飞锁 — 并发调用立即返回 busy', async () => {
  const slowChrome = {
    async ensureDaemon() {
      await new Promise((resolve) => setTimeout(resolve, 40));
    },
    async ensurePage() { return { pageId: 2, url: 'https://www.doubao.com/chat/' }; },
    async evaluate(name) {
      if (name === '01-probe') {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { status: 'succeeded', isLoggedIn: true, pageUrl: 'https://www.doubao.com/chat/', pageTitle: '豆包' };
      }
      return { ok: true };
    },
    async screenshot() {},
    async stop() {},
  };

  const firstPromise = executeDoubaoAction(
    { mode: 'status', config: normalizeConfig({}) },
    { chrome: slowChrome, history: [] },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await executeDoubaoAction(
    { mode: 'status', config: normalizeConfig({}) },
    { chrome: slowChrome, history: [] },
  );
  assert.equal(second.status, 'busy');
  assert.equal(second.code, 'busy');
  assert.equal(second.activeMode, 'status');
  // 第一个仍然正常完成，锁在 finally 里释放
  const first = await firstPromise;
  assert.equal(first.status, 'succeeded');
  assert.equal(first.code, 'ok');
  const third = await executeDoubaoAction(
    { mode: 'status', config: normalizeConfig({}) },
    { chrome: slowChrome, history: [] },
  );
  assert.equal(third.status, 'succeeded');
});

test('G16: 选择器契约快照与漂移检测', async () => {
  const { COMPOSER_SELECTORS, DOUBAO_SELECTORS, DOUBAO_MARKERS, REQUIRED_SELECTORS, missingSelectors, describeContract } =
    await import('../lib/contract.js');

  // 契约表是脚本的唯一真源：每个选择器都必须真的出现在某个脚本里
  const sources = {
    probe: buildProbeScript().source ?? buildProbeScript(),
    input: buildInputScript({ prompt: 'x' }).source ?? buildInputScript({ prompt: 'x' }),
    send: buildSendScript().source ?? buildSendScript(),
    skill: buildSkillScript().source ?? buildSkillScript(),
    collect: buildCollectScript().source ?? buildCollectScript(),
    newConversation: buildNewConversationScript().source ?? buildNewConversationScript(),
    switchMode: buildSwitchWorkModeScript().source ?? buildSwitchWorkModeScript(),
  };
  // 脚本里的选择器可能被 JSON.stringify 转义过，比对前先把 \" 还原成 "
  const allSource = Object.values(sources).join('\n').replace(/\\"/g, '"');
  for (const [id, selector] of Object.entries(DOUBAO_SELECTORS)) {
    assert.ok(allSource.includes(selector), `selector ${id} 未出现在任何页面脚本中`);
  }
  for (const marker of Object.values(DOUBAO_MARKERS)) {
    assert.ok(allSource.includes(marker), `marker ${marker} 未出现在页面脚本中`);
  }
  // 探针确实把契约统计回传（脚本里的 census 表达式）
  assert.match(String(sources.probe), /contract: Object\.fromEntries/);
  assert.match(String(sources.probe), /querySelectorAll\(sel\)\.length/);

  // 漂移判定
  const healthy = Object.fromEntries(REQUIRED_SELECTORS.map((id) => [id, 1]));
  assert.deepEqual(missingSelectors(healthy), { ok: true, missing: [], total: REQUIRED_SELECTORS.length });
  // 骨架缺失（探针阶段）
  const broken = { ...healthy, workspaceChip: 0 };
  const verdict = missingSelectors(broken);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['workspaceChip']);
  // 输入区缺失（对话打开后单独判定，不算骨架失败）
  const composerBroken = { workspaceChip: 1, newConversation: 1, inputEditor: 0, sendButton: 0 };
  assert.equal(missingSelectors(composerBroken).ok, true);
  assert.deepEqual(missingSelectors(composerBroken, COMPOSER_SELECTORS).missing, ['inputEditor']);
  assert.equal(missingSelectors({}).ok, false);
  assert.equal(describeContract().length, Object.keys(DOUBAO_SELECTORS).length);
});

test('G17: 页面结构漂移时返回 contract_changed 而不是超时', async () => {
  const drifted = {
    async ensureDaemon() {},
    async ensurePage() { return { pageId: 3, url: 'https://www.doubao.com/chat/' }; },
    async evaluate(name) {
      if (name === '01-probe') {
        return {
          status: 'succeeded',
          isLoggedIn: true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          // 已登录但页面骨架（workspaceChip / newConversation）全为 0 —— 典型改版
          contract: { loginButton: 0, loginModal: 0, inputEditor: 0, sendButton: 0, skillButton: 0 },
          images: [],
        };
      }
      return { ok: true };
    },
    async screenshot() {},
    async stop() {},
  };
  const result = await executeDoubaoAction(
    { mode: 'generate', prompt: '一只猫', config: normalizeConfig({}) },
    { chrome: drifted, history: [] },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'contract_changed');
  assert.deepEqual(result.details.missingSelectors, ['workspaceChip', 'newConversation']);
});

test('G17b: 对话打开后输入区漂移也返回 contract_changed', async () => {
  const composerDrift = {
    async ensureDaemon() {},
    async ensurePage() { return { pageId: 4, url: 'https://www.doubao.com/chat/' }; },
    async evaluate(name) {
      if (name === '01-probe') {
        return {
          isLoggedIn: true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          contract: { workspaceChip: 1, newConversation: 1, inputEditor: 0, sendButton: 0 },
          images: [],
        };
      }
      if (name === '05b-composer') {
        return { ok: false, contract: { inputEditor: 0, sendButton: 0 } };
      }
      return { ok: true };
    },
    async screenshot() {},
    async stop() {},
  };
  const result = await executeDoubaoAction(
    { mode: 'generate', prompt: '一只猫', config: normalizeConfig({}) },
    { chrome: composerDrift, history: [] },
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'contract_changed');
  assert.deepEqual(result.details.missingSelectors, ['inputEditor']);
});

test('G18：history 持久化（落盘 / 读回 / 坏 JSON / 合并去重 / 上限）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-history-'));
  try {
    const records = [
      { filePath: path.join(dir, 'doubao_1.png'), filename: 'doubao_1.png', previewUrl: '/doubao-paint/file?path=x' },
      { filePath: path.join(dir, 'doubao_2.png'), filename: 'doubao_2.png' },
    ];
    const saved = await saveHistory(dir, records);
    assert.equal(saved.count, 2);
    assert.equal(saved.filePath, historyFilePath(dir));
    assert.ok(saved.filePath.endsWith(HISTORY_FILENAME));

    const loaded = await loadHistory(dir);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].filename, 'doubao_1.png');

    // 坏 JSON 不应当让插件起不来
    await writeFile(historyFilePath(dir), '{ not json', 'utf8');
    assert.deepEqual(await loadHistory(dir), []);

    // 合并：内存（新）优先，重复的 filePath 只留一份
    const merged = mergeHistory(
      [{ filePath: 'a.png', filename: 'a.png' }, { filePath: 'b.png', filename: 'b.png' }],
      [{ filePath: 'b.png', filename: 'b.png' }, { filePath: 'c.png', filename: 'c.png' }],
    );
    assert.deepEqual(merged.map((item) => item.filename), ['b.png', 'c.png', 'a.png']);

    // 上限
    const many = Array.from({ length: 40 }, (_, index) => ({ filePath: `m${index}.png`, filename: `m${index}.png` }));
    assert.equal(mergeHistory([], many).length, 30);
    const capped = await saveHistory(dir, many);
    assert.equal(capped.count, 30);
    assert.equal((await loadHistory(dir)).length, 30);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G19：.runs 保留策略（超出 keepRuns 整目录删除，窗口内保留截图数量）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-runs-'));
  const runs = path.join(dir, '.runs');
  try {
    const base = Date.now() - 60_000;
    const names = ['r1', 'r2', 'r3', 'r4'];
    for (let index = 0; index < names.length; index += 1) {
      const runDir = path.join(runs, names[index]);
      await mkdir(runDir, { recursive: true });
      await writeFile(path.join(runDir, 'generation.png'), 'png', 'utf8');
      await writeFile(path.join(runDir, '05-input.js'), 'script', 'utf8');
      const stamp = new Date(base + index * 10_000);
      await utimes(runDir, stamp, stamp);
    }

    // 保留最近 2 个目录、其中最近 1 个保留截图
    const result = await pruneRunDirs(dir, { keepRuns: 2, keepScreenshots: 1 });
    assert.equal(result.scanned, 4);
    assert.deepEqual(result.removedDirs.sort(), ['r1', 'r2']);
    assert.deepEqual(result.removedFiles, [path.join('r3', 'generation.png')]);

    // r4 完整保留；r3 只丢了 png，脚本还在；r1/r2 整目录消失
    assert.ok(await stat(path.join(runs, 'r4', 'generation.png')));
    assert.ok(await stat(path.join(runs, 'r3', '05-input.js')));
    await assert.rejects(stat(path.join(runs, 'r3', 'generation.png')));
    await assert.rejects(stat(path.join(runs, 'r1')));

    // 目录不存在时安全返回
    const empty = await pruneRunDirs(path.join(dir, 'nope'));
    assert.deepEqual(empty, { scanned: 0, removedDirs: [], removedFiles: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('G20：环境体检（cli 缺失 / 输出目录不可写 / 全绿三态）', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-health-'));
  try {
    // 全绿：目录存在且可写、后端 CLI 在位
    const healthy = buildHealthReport({
      config: { outputDir: dir },
      backend: 'ego',
      version: '0.4.0',
      ego: { path: 'C:\\fake\\ego-browser.exe', exists: true },
      chrome: { path: '', exists: false },
    });
    assert.equal(healthy.ok, true);
    assert.equal(healthy.backend, 'ego');
    assert.equal(healthy.outputDir.exists, true);
    assert.equal(healthy.outputDir.writable, true);
    assert.equal(healthy.contract.selectors, 8);
    assert.equal(healthy.contract.required, 2);
    assert.equal(healthy.contract.composer, 1);
    assert.equal(healthy.versions.plugin, '0.4.0');
    assert.deepEqual(healthy.problems, []);

    // 后端 CLI 缺失
    const noCli = buildHealthReport({
      config: { outputDir: dir },
      backend: 'chrome',
      ego: { path: '', exists: false },
      chrome: { path: 'C:\\nope\\chrome-devtools.js', exists: false },
    });
    assert.equal(noCli.ok, false);
    assert.equal(noCli.problems[0].code, 'cli_missing');
    assert.equal(noCli.cli.exists, false);

    // 输出目录不存在但父目录可写 → 仍算可写（会自建）
    const nested = inspectOutputDir(path.join(dir, 'a', 'b'));
    assert.equal(nested.exists, false);
    assert.equal(nested.writable, true);
    assert.ok(nested.path.endsWith(path.join('a', 'b')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── G21 三个入口共用同一份结果契约 ───────────────────────────────────────────
function makePaintOutcome(overrides = {}) {
  return {
    status: 'succeeded',
    code: 'ok',
    message: '已生成并保存 1 张图片',
    mode: 'generate',
    prompt: '一只猫',
    formattedPrompt: '请生成图片：一只猫（画面比例：16:9）',
    aspectRatio: '16:9',
    style: 'auto',
    outputDir: 'C:/tmp/out',
    requestId: 'doubao-generate-test',
    imageCount: 1,
    images: [
      {
        filename: 'a.png',
        filePath: 'C:/tmp/out/a.png',
        previewUrl: '/doubao-paint/file?id=a.png',
        width: 2848,
        height: 1600,
        sizeBytes: 4155616,
      },
    ],
    screenshots: [],
    ...overrides,
  };
}

test('G21: 工具与路由两个适配器输出同一份结果契约', () => {
  const outcome = makePaintOutcome();

  const toolBlocks = renderToolResult(outcome);
  assert.equal(toolBlocks.length, 1, '工具结果只回文字块，图片交给会话语图卡');
  assert.equal(toolBlocks[0].type, 'text');
  const toolJson = JSON.parse(toolBlocks[0].text);

  // 路由侧直接返回 outcome（sendJson 的结果），这里等价于 identity
  const routeJson = JSON.parse(JSON.stringify(outcome));

  for (const view of [toolJson, routeJson]) {
    assert.equal(view.status, 'succeeded');
    assert.equal(view.outputDir, 'C:/tmp/out');
    assert.equal(view.images.length, 1);
    assert.equal(view.images[0].filename, 'a.png');
  }
  assert.equal(toolJson.imageCount, 1);
  assert.equal(routeJson.images[0].previewUrl, '/doubao-paint/file?id=a.png');

  const failed = makePaintOutcome({ status: 'failed', code: 'contract_changed', message: '页面结构变了', imageCount: 0, images: [] });
  assert.equal(JSON.parse(renderToolResult(failed)[0].text).code, 'contract_changed');
});

// ── G23 技能注册 ────────────────────────────────────────────────────────────
test('G23: runtime 技能注册（模型可调用 + 内容含工具与命令用法）', () => {
  const registered = [];
  const skills = {
    register(skill) {
      registered.push(skill);
      return () => {};
    },
  };
  const disposer = registerPaintSkill(skills);
  assert.equal(typeof disposer, 'function');
  assert.equal(registered.length, 1);

  const skill = registered[0];
  assert.equal(skill.name, 'doubao-paint');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.match(skill.description, /豆包/);
  assert.match(skill.content, /doubao_generate_image/);
  assert.match(skill.content, /\/doubao-paint/);
  assert.match(skill.content, /不要.*生成图片/);
  assert.equal(PAINT_SKILL.name, skill.name);
});

// ── G24 client 面板挂载面（v1.3.0 起没有 commandview） ─────────────────────
test('G24: client 只注册 input.left / input.dock / tool.call.toolview，不再有命令图卡', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  const buildModule = sandbox.__DSH_DOUBAO_PAINT_BUILD__;
  const makeStub = () => new Proxy(function () {}, {
    get: (target, key) => {
      if (key === 'then' || key === Symbol.toPrimitive) return undefined;
      return makeStub();
    },
    apply: () => makeStub(),
  });
  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const moduleApi = buildModule((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return { jsx: makeStub, jsxs: makeStub, Fragment: 'Fragment' };
    if (id === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: () => {
          const state = { expanded: false };
          return {
            getSnapshot: () => state,
            subscribe: () => () => {},
            toggleExpanded: () => { state.expanded = !state.expanded; },
          };
        },
        useStore: (store, selector) => (selector ? selector(store.getSnapshot()) : store.getSnapshot()),
      };
    }
    return makeStub();
  });

  const registered = [];
  const ctx = {
    slots: {
      inject: (name, factory) => factory(),
      register: (definition, component) => {
        registered.push({ name: name_of(definition), definition, component });
        return () => {};
      },
    },
    locale: { register: () => {}, current: () => 'zh' },
    effect: () => () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  function name_of(d) { return d && d.name; }
  moduleApi.apply(ctx);

  const names = registered.map((item) => item.name);
  assert.ok(names.includes('conversation.input.left'));
  assert.ok(names.includes('conversation.input.dock'));
  assert.ok(names.includes('tool.call.toolview'));
  assert.equal(names.includes('conversation.chat.commandview'), false, 'v1.3.0 起不再注册命令图卡');
  assert.equal(moduleApi.createDoubaoCommandViewComponent, undefined);
  assert.equal(moduleApi.splitCommandText, undefined);
});

// ── G26 工具图卡（tool.call.toolview key=doubao_generate_image） ─────────────
test('G26: client 注册 tool.call.toolview 并渲染图片/折叠详情/派发事件', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  const buildModule = sandbox.__DSH_DOUBAO_PAINT_BUILD__;

  const React = {
    createElement: () => null,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useLayoutEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  };
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: 'Fragment',
  };
  const moduleApi = buildModule((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-store') return { useStore: (store, selector) => selector(store.getSnapshot()) };
    return {};
  });

  const registrations = [];
  const components = [];
  const slots = {
    inject: (name, factory) => factory(),
    register: (config, component) => {
      registrations.push(config);
      components.push(component);
      return () => {};
    },
  };
  // client.js 跑在 vm 上下文里，`window` / `CustomEvent` 必须挂到 sandbox 上
  const dispatched = [];
  sandbox.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: (event) => dispatched.push(event),
  };
  sandbox.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init && init.detail;
    }
  };

  moduleApi.apply({ locale: { register: () => {}, current: () => 'zh' }, slots });

  const registration = registrations.find((entry) => entry.name === 'tool.call.toolview');
  assert.ok(registration, '必须注册 tool.call.toolview');
  assert.equal(registration.key, 'doubao_generate_image');

  const ToolView = components[registrations.indexOf(registration)];
  assert.equal(typeof ToolView, 'function');

  const running = ToolView({ phase: 'start', block: { callId: 'c1', content: [] } });
  assert.equal(running.props['aria-busy'], true);
  assert.equal(running.props['data-dsh-doubao-tool'], '1');

  const settled = ToolView({
    phase: 'result',
    block: { callId: 'c1', isError: false, content: [{ type: 'text', text: JSON.stringify(makePaintOutcome()) }] },
  });
  const grid = settled.props.children.find((child) => child && child.props && child.props.className === 'dsh-dbimg-tool-grid');
  assert.ok(grid, '成功结果必须渲染图片网格');
  assert.equal(grid.props.children[0].props.children[0].props.src, '/doubao-paint/file?id=a.png');
  const details = settled.props.children.find((child) => child && child.props && child.props.className === 'dsh-dbimg-tool-details');
  assert.ok(details, '详细信息必须折叠在 details 里');
  assert.equal(details.props.children[0].type, 'summary');
  // 工具结果里不再有 image 块，图片只由这张图卡呈现；结束事件驱动 dock 刷新
  assert.equal(moduleApi.emitGenerated(makePaintOutcome().images), true);
  assert.equal(dispatched.some((event) => event.type === moduleApi.GENERATED_EVENT), true);

  const failed = ToolView({ phase: 'result', block: { callId: 'c1', isError: true, error: { code: 'cli_missing' }, content: [] } });
  assert.match(failed.props.className, /failed/);
});


// ── G25 统一入口：submitPaintRequest 归一化 + 未登录时不写 history ─────────────
test('G25: submitPaintRequest 归一化缺省值，未登录时不落盘 history', async () => {
  const normalized = normalizePaintRequest({ mode: 'generate', prompt: '猫' });
  assert.equal(normalized.maxImages, 4);
  assert.equal(normalized.newConversation, true);
  assert.equal(normalized.mode, 'generate');
  assert.equal(normalizePaintRequest({ mode: 'status' }).prompt, undefined);

  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-entry-'));
  try {
    const history = [];
    const fakeChrome = {
      backend: 'fake',
      async ensureDaemon() {
        return { running: true };
      },
      async ensurePage() {
        return { pageId: 1 };
      },
      async evaluate() {
        // 未登录：探针返回 isLoggedIn=false
        return { status: 'succeeded', isLoggedIn: false, pageUrl: 'https://www.doubao.com/chat/', pageTitle: '豆包' };
      },
      async screenshot() {
        return { path: path.join(dir, 'login.png') };
      },
    };

    const outcome = await submitPaintRequest(
      { mode: 'generate', prompt: '猫', config: { outputDir: dir } },
      { history, attachments: undefined, chrome: fakeChrome },
    );

    assert.equal(outcome.code, 'login_required');
    assert.equal(outcome.status, 'login_required');
    assert.equal(history.length, 0);
    assert.equal(existsSync(path.join(dir, '.history.json')), false, '未成功的调用不得写 history 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
