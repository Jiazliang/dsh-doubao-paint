/**
 * dsh-doubao-paint 离线验收测试
 *
 * 运行：`node --test test/index.test.js`（不要传目录，Windows 下目录形式会 MODULE_NOT_FOUND）
 *
 * 全部断言都是 headless 数值/结构断言：不起浏览器、不读图片内容（用户级硬规则 2026-10-29）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  resolveRequestWorkspace,
  resolveWorkspaceBySessionId,
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
  backfillWorkspace,
  groupHistoryByWorkspace,
  HISTORY_FILENAME,
  historyFilePath,
  inferWorkspaceFromFilePath,
  loadHistory,
  mergeHistory,
  pruneRunDirs,
  repairFallbackWorkspace,
  saveHistory,
  workspaceLabel,
} from '../lib/history.js';

const noopCtx = { attachments: undefined };

// ── G1 配置归一化 ────────────────────────────────────────────────────────────
test('G1: normalizeConfig 归一化 + volatile 解包 + 超时夹取', () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.doubaoUrl, 'https://www.doubao.com/chat/');
  assert.equal(defaults.defaultAspectRatio, '16:9');
  assert.equal(defaults.defaultStyle, 'auto');
  assert.equal(defaults.outputDir, path.join(homedir(), '.dsh', 'dsh-doubao-paint', 'images'));
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
      config: { outputDir: dir, timeoutMs: 30000, keepTab: true, attachImages: true },
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
      config: { outputDir: dir, timeoutMs: 30000, keepTab: true, attachImages: true },
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
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-apply-'));
  const { ctx, registered } = makeFakeHostCtx();
  apply(ctx, { enabled: true, outputDir: dir });

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
    ['/doubao-paint/clear', '/doubao-paint/file', '/doubao-paint/generate', '/doubao-paint/open', '/doubao-paint/status'],
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
  // 后端可用才算 200：CI 裸机既没有 ego lite 也没有 chrome-devtools，会走 503，
  // 因此这里断言「二选一且自洽」，而不是写死 200（本机装了 ego 才恒为 200）。
  assert.equal([200, 503].includes(payload.code), true, `status 路由返回了 ${payload.code}`);
  if (payload.code === 503) {
    assert.equal(payload.body.ok, false);
    assert.equal(payload.body.code, 'backend_unavailable');
  } else {
    assert.equal(payload.body.ok, true);
    assert.equal(payload.body.code, 'ok');
  }
  assert.equal(payload.body.config.defaultAspectRatio, '16:9');
  assert.equal('taskName' in payload.body.config, false);
  assert.ok(payload.body.config.chromeCliPath.length > 0);
  assert.equal(payload.body.aspectRatios.length, 8);
  assert.equal(payload.body.presets.length, 8);
  assert.deepEqual(payload.body.history, []);
  assert.equal(payload.body.browserStatus, null);
  // v1.4.0：按工作区分组 —— 空历史时 groups 为空数组，且回显请求里的 workspace
  assert.equal(payload.body.workspace, '');
  assert.deepEqual(payload.body.groups, []);

  // 带 ?workspace= 时原样回显，供前端判定「当前工作区」
  let wsPayload;
  await statusRoute.handler(
    { url: '/doubao-paint/status?workspace=' + encodeURIComponent('D:\\work\\proj-a'), on: () => {} },
    {
      writeHead: (code, headers) => {
        wsPayload = { code, headers };
      },
      end: (body) => {
        wsPayload.body = JSON.parse(body);
      },
    },
  );
  assert.equal(wsPayload.body.workspace, 'D:\\work\\proj-a');
  assert.deepEqual(wsPayload.body.groups, []);

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

  await rm(dir, { recursive: true, force: true });
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

  // 「✨ 插入对话让 Agent 生图」插入的是 /doubao-paint 技能手势（v1.3.0 起唯一人类入口）
  assert.equal(
    moduleApi.formatAgentCommandPrompt('  一只  猫  ', { aspectRatio: '4:3', style: 'cinematic-cg' }),
    '/doubao-paint 一只 猫（比例：4:3，风格：电影级 CG）',
  );
  assert.equal(moduleApi.formatAgentCommandPrompt(''), '');
  const gesture = moduleApi.formatAgentCommandPrompt('月球上的橘猫', { aspectRatio: '16:9', style: 'auto' });
  assert.match(gesture, /^\/doubao-paint 月球上的橘猫（比例：16:9）$/);
  assert.equal(gesture.includes('请调用'), false, '不再让 Agent 自己拼工具调用指令');
  assert.equal(gesture.includes('\n'), false, '手势必须单行，附带参数不能另起一行');

  // 工作区分组：服务端 groups 优先，老服务端裸 history 回落为单组
  const wsA = 'D:\\Projects\\active\\a';
  const wsB = 'D:\\Projects\\active\\b';
  const grouped = moduleApi.normalizeHistoryGroups(
    {
      groups: [
        { key: wsB, label: 'b', count: 12, current: false, images: [{ id: 'b1' }] },
        { key: wsA, label: 'a', count: 3, current: true, images: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] },
      ],
    },
    wsA,
  );
  assert.equal(grouped[0].key, wsA, '当前工作区必须置顶');
  assert.equal(grouped[0].count, 3);
  assert.equal(grouped[0].images.length, 3, '当前组必须吐出全部 3 张，不能再截断');
  assert.equal(grouped[1].count, 12, '其它组的 count 用服务端真实总数');
  assert.equal(moduleApi.workspaceOfSession({ cwd: wsA }), wsA);
  assert.equal(moduleApi.workspaceOfSession({ header: { cwd: wsB } }), wsB);
  assert.equal(moduleApi.workspaceOfSession(undefined), '');
  const legacy = moduleApi.normalizeHistoryGroups({ history: [{ id: 'x1' }, { id: 'x2' }] }, '');
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].count, 2);
  assert.equal(legacy[0].current, true);

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
  assert.ok(chipText.includes('豆包生图'), chipText);
  // 无障碍：按钮化 + 可键盘激活 + 屏幕阅读器提示
  assert.equal(chipCollapsed.props.role, 'button');
  assert.equal(chipCollapsed.props.tabIndex, 0);
  assert.match(String(chipCollapsed.props['aria-label'] || ''), /豆包生图/);
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

  // ── 分组渲染：张数必须「显示多少就是多少」，且按工作区分区/折叠 ─────────
  const collect = (root) => {
    const nodes = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      nodes.push(node);
      if (node.props) walk(node.props.children);
    };
    walk(root);
    return nodes;
  };
  const textOf = (root) =>
    collect(root)
      .map((node) => (node.props ? node.props.children : undefined))
      .filter((value) => typeof value === 'string')
      .join('|');

  assert.doesNotMatch(
    textOf(dockExpanded),
    /唤醒豆包网页|重新唤起登录框/,
    '未登录只提示文案，不提供专门的唤起按钮（2026-11-07 用户要求去掉）',
  );

  const sessionStore = moduleApi.getSessionStore('session-1');
  const groupImages = Array.from({ length: 6 }, (_, index) => ({
    id: `group-${index}`,
    filename: `group-${index}.png`,
    filePath: `D:\\work\\proj-a\\doubao_images\\group-${index}.png`,
    previewUrl: `/doubao-paint/file?path=group-${index}.png`,
    aspectRatio: '16:9',
  }));
  sessionStore.setGroups(
    [
      { key: 'D:\\work\\proj-a', label: 'proj-a', count: 6, latestAt: '', current: true, images: groupImages },
      { key: 'D:\\work\\proj-b', label: 'proj-b', count: 9, latestAt: '', current: false, images: groupImages.slice(0, 2) },
    ],
    'D:\\work\\proj-a',
  );

  const groupedDock = dockFactory({ sessionId: 'session-1', session: { cwd: 'D:\\work\\proj-a' } });
  const dockNodes = collect(groupedDock);
  assert.equal(
    dockNodes.filter((node) => node.type === 'img').length,
    6,
    '6 条历史必须渲染 6 个 img（v1.3.x 的 slice(0, 4) 只画 4 张）',
  );
  const groupHeads = dockNodes.filter(
    (node) => node.type === 'button' && node.props['data-dsh-doubao-group'] !== undefined,
  );
  assert.equal(groupHeads.length, 2);
  assert.doesNotMatch(
    textOf(groupedDock),
    /group-\d+\.png/,
    '卡片条只放「引用路径」，不显示文件名（文件名太长会挤坏排版）',
  );

  // 右下角浮层只剩「引用路径」；删除是图片右上角独立的「×」角标
  const cardBars = dockNodes.filter(
    (node) => node.props && node.props.className === 'dsh-dbimg-card-bar',
  );
  assert.equal(cardBars.length, 6, '每张缩略图都要有「引用路径」浮层容器');
  const barButtons = dockNodes.filter(
    (node) =>
      node.type === 'button' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('dsh-dbimg-mini-btn'),
  );
  assert.equal(barButtons.length, 6, '「引用路径」按钮仍留在右下角浮层里');
  const cards = dockNodes.filter((node) => node.props && node.props.className === 'dsh-dbimg-card');
  assert.equal(cards.length, 6);
  const closeButtons = dockNodes.filter(
    (node) => node.type === 'button' && node.props.className === 'dsh-dbimg-card-close',
  );
  assert.equal(closeButtons.length, 6, '每张图都要有右上角「×」删除角标');
  assert.equal(closeButtons[0].props.children, '×', '角标用文本 ×（U+00D7），不用 emoji');
  assert.equal(closeButtons[0].props['data-dsh-doubao-remove-image'], groupImages[0].filePath);
  assert.equal(closeButtons[0].props['aria-label'], '删除');
  assert.match(String(closeButtons[0].props.title), /本地文件/, '二次确认文案必须说明会删本地文件');
  assert.equal(typeof closeButtons[0].props.onClick, 'function');
  for (const card of cards) {
    const children = Array.isArray(card.props.children)
      ? card.props.children
      : [card.props.children];
    assert.equal(
      children.filter((child) => child && child.props && child.props.className === 'dsh-dbimg-card-close')
        .length,
      1,
      '「×」必须是卡片的直接子元素（不是右下角浮层的一员）',
    );
    assert.equal(
      children.filter((child) => child && child.props && child.props.className === 'dsh-dbimg-card-bar')
        .length,
      1,
      '右下角浮层容器仍是卡片的直接子元素',
    );
  }
  for (const bar of cardBars) {
    const children = Array.isArray(bar.props.children) ? bar.props.children : [bar.props.children];
    assert.equal(
      children.filter(
        (child) => child && child.props && child.props['data-dsh-doubao-remove-image'] !== undefined,
      ).length,
      0,
      '「×」不能再放在右下角浮层内',
    );
  }
  assert.equal(groupHeads[0].props['data-dsh-doubao-group'], 'D:\\work\\proj-a');
  assert.equal(groupHeads[0].props['aria-expanded'], 'true', '当前工作区默认展开');
  assert.equal(groupHeads[1].props['aria-expanded'], 'false', '其它工作区默认折叠');
  assert.match(textOf(groupHeads[0]), /6 张/);
  assert.match(textOf(groupHeads[0]), /当前工作区/);
  assert.match(textOf(groupHeads[1]), /9 张/, '折叠组显示真实总数，不是已加载条数');

  // 触发条徽标口径与面板一致：6 + 9 = 15
  assert.match(textOf(chipFactory({ sessionId: 'session-1' })), /15 张/);

  // 点击组头折叠当前组 → 图片全部收起，再点回来
  groupHeads[0].props.onClick();
  assert.equal(
    collect(dockFactory({ sessionId: 'session-1', session: { cwd: 'D:\\work\\proj-a' } })).filter(
      (node) => node.type === 'img',
    ).length,
    0,
    '折叠后该组不再渲染图片',
  );
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
  assert.equal(resolveOutputDirectory('', '/tmp/ws'), path.join(homedir(), '.dsh', 'dsh-doubao-paint', 'images'));

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
  //    期望路径必须用 `path.join` 拼（Linux 上 join 是 posix 语义，写死反斜杠会永远不匹配）
  const fakeExists = (set) => (p) => set.has(p);
  const root = 'C:\\Program Files\\Citro Labs\\ego lite\\Application';
  const v7 = path.join(root, '0.6.2.7', 'ego-browser.exe');
  const v6 = path.join(root, '0.6.2.6', 'ego-browser.exe');
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
  // 「探得到 ego 就用 ego」用探测器桩断言，避免把本机是否装了 ego 写进测试
  assert.equal(resolveBrowserBackend({}, () => 'C:\\fake\\ego-browser.exe'), 'ego');
  assert.equal(resolveBrowserBackend({ browserBackend: 'auto' }, () => 'C:\\fake\\ego-browser.exe'), 'ego');
  assert.equal(resolveBrowserBackend({ browserBackend: 'chrome' }, () => 'C:\\fake\\ego-browser.exe'), 'chrome');
  // ego 显式要求但探测不到 → 回落 chrome，而不是抛出
  assert.equal(resolveBrowserBackend({ browserBackend: 'ego' }, () => ''), 'chrome');
  assert.equal(resolveBrowserBackend({ browserBackend: 'auto' }, () => ''), 'chrome');
  assert.equal(resolveBrowserBackend({ browserBackend: 'ego', egoCliPath: 'C:\\ego\\ego-browser.exe' }), 'ego');
  // 未指定后端时只看真实探测结果，二选一即可（CI 裸机无 ego → chrome）
  assert.equal(['ego', 'chrome'].includes(resolveBrowserBackend({})), true);

  // 会话工厂同理：显式给出 egoCliPath，才不会在裸机（未装 ego）上被回落成 chrome
  const egoSession = createBrowserSession({
    browserBackend: 'ego',
    egoCliPath: 'C:\\fake\\ego-browser.exe',
    doubaoUrl: 'https://www.doubao.com/chat/',
  });
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
  const {
    COMPOSER_SELECTORS,
    DOUBAO_SELECTORS,
    DOUBAO_MARKERS,
    HARD_SELECTORS,
    SHELL_HARD_SELECTORS,
    SOFT_SELECTORS,
    missingSelectors,
    softDegradations,
    describeContract,
  } = await import('../lib/contract.js');

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

  // 漂移判定（P1：契约分级 —— hard 才判失败，soft 只进 degraded）
  const healthy = Object.fromEntries(HARD_SELECTORS.map((id) => [id, 1]));
  assert.deepEqual(missingSelectors(healthy), {
    ok: true,
    missing: [],
    total: HARD_SELECTORS.length,
  });
  // hard 缺失（输入框）→ 判失败
  const hardBroken = { ...healthy, inputEditor: 0 };
  const verdict = missingSelectors(hardBroken);
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.missing, ['inputEditor']);
  // soft 缺失（工作区 chip / 新建会话 / 技能按钮）→ 不判失败，只降级
  const softBroken = {
    ...healthy,
    loginButton: 1,
    loginModal: 1,
    workMode: 1,
    workspaceChip: 0,
    newConversation: 0,
    skillButton: 0,
  };
  assert.equal(missingSelectors(softBroken, SHELL_HARD_SELECTORS).ok, true);
  assert.deepEqual(softDegradations(softBroken), ['workspaceChip', 'newConversation', 'skillButton']);
  // 输入区单独判定（对话打开后）：送发按钮此时还没渲染，不算本阶段必需
  const composerBroken = { workspaceChip: 1, newConversation: 1, inputEditor: 0, sendButton: 0 };
  assert.equal(missingSelectors(composerBroken, COMPOSER_SELECTORS).ok, false);
  assert.deepEqual(missingSelectors(composerBroken, COMPOSER_SELECTORS).missing, ['inputEditor']);
  // 空探针 → hard 全缺
  assert.equal(missingSelectors({}).ok, false);
  assert.equal(describeContract().length, Object.keys(DOUBAO_SELECTORS).length);
  // 分级表本身可审：hard 只有「能写进去」和「能发出去」
  assert.deepEqual([...HARD_SELECTORS].sort(), ['inputEditor', 'sendButton']);
  assert.equal(SOFT_SELECTORS.length, Object.keys(DOUBAO_SELECTORS).length - HARD_SELECTORS.length);
  assert.deepEqual([...SHELL_HARD_SELECTORS], []);
});

// ── P1/P2：伪页面变体（契约分级 / 错误语义 / 失败取证）──────────────────────
/**
 * 伪页面变体工厂：用桩模拟「豆包改版后的不同形态」，只验证编排层的降级与失败语义。
 *
 * 硬约束：outputDir 恒为 mkdtemp 临时目录——验收绝不碰生产目录
 * `C:\Users\Jiaz\.dsh\dsh-doubao-paint\`。
 *
 * @param {{
 *   contract?: Record<string, number>|null,   // 探针回传的选择器计数
 *   composer?: object|null,                   // 05b-composer 返回
 *   input?: object|null,                      // 05-input 返回
 *   send?: object|null,                       // 06-send 返回
 *   skill?: object|null,                      // 04-skill 返回
 *   images?: Array<object>|null,              // 07-collect 返回的图片候选
 * }} [overrides]
 */
async function makeVariantPage(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-variant-'));
  const calls = [];
  const baseline = 'https://p3.doubao.com/rc_gen_image/baseline.png';
  const chrome = {
    calls,
    async ensureDaemon() {},
    async ensurePage() {
      return { pageId: 9, url: 'https://www.doubao.com/chat/' };
    },
    async evaluate(name) {
      calls.push(name);
      if (name === '01-probe') {
        return {
          status: 'succeeded',
          isLoggedIn: true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          ...(overrides.contract ? { contract: overrides.contract } : {}),
          images: [{ src: baseline, naturalWidth: 1080, naturalHeight: 1080 }],
        };
      }
      if (name === '04-skill') {
        return overrides.skill ?? { ok: true, clicked: true, hasLoginModal: false };
      }
      if (name === '05b-composer') {
        return overrides.composer ?? { ok: true, contract: { inputEditor: 1, sendButton: 0 } };
      }
      if (name === '05-input') {
        return overrides.input ?? { ok: true, field: 'prosemirror', inserted: true, textLength: 20 };
      }
      if (name === '06-send') return overrides.send ?? { ok: true, via: 'button' };
      if (name.startsWith('07-collect')) {
        return {
          status: 'succeeded',
          hasLoginModal: false,
          pageUrl: 'https://www.doubao.com/chat/abc',
          images: overrides.images ?? [
            {
              src: 'https://p3.doubao.com/rc_gen_image/freshhash.png~wm0.png',
              naturalWidth: 2048,
              naturalHeight: 2048,
            },
          ],
        };
      }
      if (name.startsWith('dom-dump-')) {
        return {
          ok: true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          html: '<html><body><div data-testid="chat_input_input"></div></body></html>',
          htmlLength: 71,
          truncated: false,
        };
      }
      if (name === '08-tail-text') return { tailText: '豆包页面正在生成…' };
      return { ok: true };
    },
    async screenshot(filePath) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return 'ok';
    },
    async stop() {},
  };
  const fetchImage = async () => ({
    ok: true,
    headers: { get: () => 'image/webp' },
    arrayBuffer: async () => Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer,
  });
  const run = async () =>
    executeDoubaoAction(
      {
        mode: 'generate',
        prompt: '一只哈基米',
        aspectRatio: '1:1',
        style: 'photorealistic',
        maxImages: 1,
        config: normalizeConfig({ outputDir: dir, timeoutMs: 8000, keepTab: true, attachImages: false }),
      },
      { chrome, fetchImage, history: [], cwd: dir },
    );
  return { dir, chrome, run };
}

test('G17: 骨架 soft 缺失只降级不 fail-fast；发送失败才报 send_not_ready（P1+L2）', async () => {
  const page = await makeVariantPage({
    // 工作区 chip / 新建会话 / 技能按钮都不见了 —— 旧版这里直接 contract_changed
    contract: {
      loginButton: 0,
      loginModal: 0,
      workspaceChip: 0,
      newConversation: 0,
      workMode: 0,
      skillButton: 0,
      inputEditor: 1,
      sendButton: 0,
    },
    send: { ok: false, reason: 'neither_button_nor_editor' },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'send_not_ready');
    assert.match(result.message, /第 4 步（提交指令）失败：发送按钮不可用/);
    assert.deepEqual(result.degraded, [
      'loginButton',
      'loginModal',
      'workMode',
      'workspaceChip',
      'newConversation',
      'skillButton',
    ]);
    // P2：失败取证落在 runDir，结果里只带指针不带 HTML
    assert.equal(result.details.step, '06-send');
    assert.equal(result.details.reason, 'send_not_ready');
    assert.match(result.details.artifacts.dom, /dom-06-send\.html$/);
    assert.equal(result.details.evidence?.html, undefined);
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test('G17b: 对话打开后输入区漂移也返回 contract_changed（hard 契约）', async () => {
  const page = await makeVariantPage({
    contract: { workspaceChip: 1, newConversation: 1, inputEditor: 1, sendButton: 0 },
    composer: { ok: false, contract: { inputEditor: 0, sendButton: 0 } },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'contract_changed');
    assert.deepEqual(result.details.missingSelectors, ['inputEditor']);
    assert.equal(result.details.step, '05-input');
    assert.match(result.message, /第 3 步（写入提示词）失败：输入框未找到/);
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test('G32a: 技能按钮 testid 改版 → 仍能出图，降级记 skillButton', async () => {
  const page = await makeVariantPage({
    contract: {
      loginButton: 0,
      loginModal: 0,
      workspaceChip: 1,
      newConversation: 1,
      workMode: 0,
      skillButton: 0,
      inputEditor: 1,
      sendButton: 1,
    },
    skill: { ok: false, clicked: false, hasLoginModal: false },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(result.code, 'ok');
    assert.deepEqual(result.degraded, ['loginButton', 'loginModal', 'workMode', 'skillButton']);
    assert.equal(result.imageCount, 1);
    assert.ok(path.resolve(result.images[0].filePath).startsWith(path.resolve(page.dir)));
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test('G32b: 删掉工作区 chip → 仍能出图，degraded 含 workspaceChip', async () => {
  const page = await makeVariantPage({
    contract: {
      loginButton: 0,
      loginModal: 0,
      workspaceChip: 0,
      newConversation: 0,
      workMode: 0,
      skillButton: 1,
      inputEditor: 1,
      sendButton: 1,
    },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.degraded, ['loginButton', 'loginModal', 'workMode', 'workspaceChip', 'newConversation']);
    assert.ok(!result.degraded.includes('skillButton'));
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test('G32c: 输入区退回纯 textarea → 仍能出图', async () => {
  const page = await makeVariantPage({
    contract: {
      loginButton: 0,
      loginModal: 0,
      workspaceChip: 1,
      newConversation: 1,
      workMode: 0,
      skillButton: 1,
      inputEditor: 1,
      sendButton: 1,
    },
    input: { ok: true, field: 'textarea', inserted: true, textLength: 20, matches: true },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'succeeded');
    assert.equal(result.imageCount, 1);
    assert.ok(page.chrome.calls.includes('05-input'));
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
});

test('G32d: 输入框与发送按钮一起消失 → contract_changed + dom-05-input.html 落盘', async () => {
  const page = await makeVariantPage({
    contract: {
      loginButton: 0,
      loginModal: 0,
      workspaceChip: 1,
      newConversation: 1,
      workMode: 0,
      skillButton: 1,
      inputEditor: 0,
      sendButton: 0,
    },
    composer: { ok: false, contract: { inputEditor: 0, sendButton: 0 } },
  });
  try {
    const result = await page.run();
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 'contract_changed');
    const domPath = result.details.artifacts.dom;
    assert.match(domPath, /dom-05-input\.html$/);
    const html = await readFile(domPath, 'utf8');
    assert.match(html, /chat_input_input/);
    const contractJson = JSON.parse(await readFile(result.details.artifacts.contract, 'utf8'));
    assert.equal(contractJson.step, '05-input');
    assert.equal(contractJson.contract.inputEditor, 0);
    const pageUrlText = await readFile(result.details.artifacts.pageUrl, 'utf8');
    assert.match(pageUrlText, /doubao\.com\/chat/);
  } finally {
    await rm(page.dir, { recursive: true, force: true });
  }
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

    // 同一张图内存那份缺 workspace 时，用磁盘副本补齐（否则面板仍显示「未标记工作区」）
    const enriched = mergeHistory(
      [{ filePath: 'd.png', filename: 'd.png', workspace: 'D:\\work\\proj-a' }],
      [{ filePath: 'd.png', filename: 'd.png' }],
    );
    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].workspace, 'D:\\work\\proj-a');
    // 内存那份已有 workspace 时以内存为准（新的优先），不用磁盘覆盖
    const keptOwn = mergeHistory(
      [{ filePath: 'e.png', filename: 'e.png', workspace: 'D:\\work\\proj-b' }],
      [{ filePath: 'e.png', filename: 'e.png', workspace: 'D:\\work\\proj-a' }],
    );
    assert.equal(keptOwn[0].workspace, 'D:\\work\\proj-a');

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

test('G18b：旧记录按 filePath 回填 workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-backfill-'));
  try {
    const workspaceA = path.join(root, 'proj-a');
    const workspaceB = path.join(root, 'proj-b');
    const dirA = path.join(workspaceA, 'doubao_images');

    // 纯函数：图片目录名等于输出目录名时才推断
    assert.equal(inferWorkspaceFromFilePath(path.join(dirA, 'doubao_1.png')), workspaceA);
    assert.equal(inferWorkspaceFromFilePath(path.join(root, 'elsewhere', 'doubao_1.png')), '');
    assert.equal(inferWorkspaceFromFilePath(''), '');
    assert.equal(inferWorkspaceFromFilePath(undefined), '');

    // 已有 workspace 的记录保持不变，无 workspace 的按路径补齐
    const backfilled = backfillWorkspace([
      { filePath: path.join(dirA, 'doubao_1.png') },
      { filePath: path.join(workspaceB, 'doubao_images', 'doubao_2.png') },
      { filePath: path.join(dirA, 'doubao_3.png'), workspace: workspaceA },
      { filePath: path.join(root, 'loose.png') },
    ]);
    assert.equal(backfilled[0].workspace, workspaceA);
    assert.equal(backfilled[1].workspace, workspaceB);
    assert.equal(backfilled[2].workspace, workspaceA);
    assert.equal(backfilled[3].workspace, undefined);

    // loadHistory 落盘再读回时自动回填（v1.3.x 存量记录的场景）
    const saved = await saveHistory(dirA, [
      { filePath: path.join(dirA, 'doubao_1.png'), filename: 'doubao_1.png' },
      { filePath: path.join(workspaceB, 'doubao_images', 'doubao_2.png'), filename: 'doubao_2.png' },
    ]);
    assert.equal(saved.count, 2);
    const loaded = await loadHistory(dirA);
    assert.equal(loaded[0].workspace, workspaceA);
    assert.equal(loaded[1].workspace, workspaceB);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('G18c：groupHistoryByWorkspace 分组、置顶、计数与截断', () => {
  // 用平台无关路径：POSIX 上 path.basename('D:\work\proj-a') 取不到末段
  const wsA = path.resolve('work', 'proj-a');
  const wsB = path.resolve('work', 'proj-b');
  const mk = (id, workspace, createdAt) => ({ id, workspace, createdAt, previewUrl: `/doubao-paint/file?path=${id}` });
  const list = [
    mk('b1', wsB, '2026-11-07T10:00:00.000Z'),
    mk('a1', wsA, '2026-11-07T09:00:00.000Z'),
    mk('a2', wsA, '2026-11-07T09:30:00.000Z'),
    mk('n1', '', '2026-11-07T08:00:00.000Z'),
  ];

  // 当前工作区置顶并标记 current，其余按时间倒序
  const groups = groupHistoryByWorkspace(list, { currentWorkspace: wsA });
  assert.equal(groups[0].key, wsA);
  assert.equal(groups[0].current, true);
  assert.equal(groups[0].label, 'proj-a');
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].images.map((item) => item.id), ['a1', 'a2']);
  assert.equal(groups[1].key, wsB);
  assert.equal(groups[1].current, false);
  assert.equal(groups[2].label, '未标记工作区');

  // count 是真实总数，images 按 perGroupLimit 截断
  const limited = groupHistoryByWorkspace(list, { currentWorkspace: wsB, perGroupLimit: 1 });
  assert.equal(limited[0].key, wsB);
  assert.equal(limited[0].count, 1);
  assert.equal(limited[0].images.length, 1);
  const wsAGroup = limited.find((group) => group.key === wsA);
  assert.equal(wsAGroup.count, 2);
  assert.equal(wsAGroup.images.length, 1);

  // 空列表 / 非数组都安全
  assert.deepEqual(groupHistoryByWorkspace([], { currentWorkspace: wsA }), []);
  assert.deepEqual(groupHistoryByWorkspace(undefined), []);

  // 标签取路径末段，去尾部分隔符
  assert.equal(workspaceLabel(`${wsA}${path.sep}`), 'proj-a');
  assert.equal(workspaceLabel('   '), '未标记工作区');
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
  // 宿主 skills 加载器校验：source / provider 必须是字符串，否则整轮抛 `loaded skill "…" source must be a string`
  assert.equal(typeof skill.source, 'string');
  assert.equal(typeof skill.provider, 'string');
  assert.equal(typeof skill.content, 'string');
  assert.ok(skill.content.length > 100);
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
test('G27: 状态条 15 秒后自动收回，loading 期间不排定', async () => {
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
  const jsxRuntime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'Fragment' };
  const moduleApi = buildModule((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-store') return { useStore: (store, selector) => selector(store.getSnapshot()) };
    return {};
  });

  assert.equal(moduleApi.STATUS_TTL_MS, 15000);

  let scheduled = null;
  const timers = {
    setTimeout: (fn, ms) => {
      scheduled = { fn, ms };
      return 7;
    },
    clearTimeout: () => {
      scheduled = null;
    },
  };
  const store = moduleApi.createDoubaoStudioStore(undefined, timers);

  store.setLoginRequired(true, '请先输入生图画面描述词（Prompt）');
  assert.ok(store.getSnapshot().statusMessage.includes('请先输入'));
  assert.equal(scheduled.ms, 15000, '告警必须排定 15 秒收回');
  scheduled.fn();
  assert.equal(store.getSnapshot().statusMessage, '');
  assert.equal(store.getSnapshot().loginRequired, false);

  scheduled = null;
  store.setLoading(true, '生图中…');
  assert.equal(scheduled, null, 'loading 进行中的提示不排定收回');
  store.setLoading(false, '✅ 成功', 'info');
  assert.equal(scheduled.ms, 15000, 'loading 结束后的提示同样排定收回');

  // 不注入 timers 时必须回落 globalThis（真宿主走这条路径）：
  // 默认参数 `{}` 曾把真计时器挡掉，表现为提示永不消失。
  let hostScheduled = null;
  sandbox.setTimeout = (fn, ms) => {
    hostScheduled = { fn, ms };
    return 11;
  };
  sandbox.clearTimeout = () => {
    hostScheduled = null;
  };
  const hostStore = moduleApi.createDoubaoStudioStore();
  hostStore.setLoading(false, '请先输入生图画面描述词（Prompt）', 'warn');
  assert.equal(hostScheduled?.ms, 15000, '未注入 timers 时也必须用宿主的 setTimeout 排定收回');
  hostScheduled.fn();
  assert.equal(hostStore.getSnapshot().statusMessage, '', '未注入 timers 时提示同样会被清空');
});

// ── G28 按工作区清除 ────────────────────────────────────────────────────────
function makeRouteReq(method, payload) {
  const listeners = new Map();
  const req = {
    method,
    url: '/doubao-paint/clear',
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return req;
    },
  };
  setImmediate(() => {
    const chunk = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    for (const handler of listeners.get('data') || []) handler(chunk);
    for (const handler of listeners.get('end') || []) handler();
  });
  return req;
}

async function callClearRoute(route, method, payload) {
  const result = {};
  await route.handler(makeRouteReq(method, payload), {
    writeHead: (code, headers) => {
      result.code = code;
      result.headers = headers;
    },
    end: (body) => {
      result.body = body ? JSON.parse(body) : undefined;
    },
  });
  return result;
}

test('G28：清除只删指定工作区的记录与本地文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-clear-'));
  const wsA = 'D:\\work\\proj-a';
  const wsB = 'D:\\work\\proj-b';
  const fileA1 = path.join(dir, 'doubao_a1.png');
  const fileA2 = path.join(dir, 'doubao_a2.png');
  const fileB1 = path.join(dir, 'doubao_b1.png');
  try {
    for (const file of [fileA1, fileA2, fileB1]) await writeFile(file, 'png');
    await saveHistory(dir, [
      { filePath: fileB1, filename: 'doubao_b1.png', workspace: wsB },
      { filePath: fileA1, filename: 'doubao_a1.png', workspace: wsA },
      { filePath: fileA2, filename: 'doubao_a2.png', workspace: wsA },
    ]);

    const { ctx, registered } = makeFakeHostCtx();
    apply(ctx, { outputDir: dir });
    const clearRoute = registered.routes.find((route) => route.path === '/doubao-paint/clear');
    assert.ok(clearRoute, '必须注册 /doubao-paint/clear');

    // 非 POST 一律 405：清除是不可回退操作，只认 POST
    const notAllowed = await callClearRoute(clearRoute, 'GET', undefined);
    assert.equal(notAllowed.code, 405);
    assert.equal(notAllowed.body.ok, false);

    const payload = await callClearRoute(clearRoute, 'POST', { workspace: wsA });
    assert.equal(payload.code, 200);
    assert.equal(payload.body.ok, true);
    assert.equal(payload.body.workspace, wsA);
    assert.equal(payload.body.removed, 2);
    assert.equal(payload.body.filesRemoved, 2);

    // 只删本组文件，别的组不受影响
    assert.equal(existsSync(fileA1), false);
    assert.equal(existsSync(fileA2), false);
    assert.equal(existsSync(fileB1), true);

    // 返回的分组里 wsA 消失、wsB 仍在且计数为 1
    const keys = payload.body.groups.map((group) => String(group.key));
    assert.equal(keys.some((key) => key.includes('proj-a')), false, `残留 proj-a 组：${keys.join(',')}`);
    const wsBGroup = payload.body.groups.find((group) => String(group.key).includes('proj-b'));
    assert.ok(wsBGroup);
    assert.equal(wsBGroup.count, 1);

    // 落盘同步：磁盘上只剩 wsB 那条
    const onDisk = await loadHistory(dir);
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].workspace, wsB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── G29 关闭单张图片（缩略图悬浮删除按钮的后端语义） ────────────────────────
test('G29：单张删除只删目标记录与本地文件，未知目标 404 且不动任何文件', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-clear-one-'));
  const wsA = 'D:\\work\\proj-a';
  const wsB = 'D:\\work\\proj-b';
  const fileA1 = path.join(dir, 'doubao_a1.png');
  const fileA2 = path.join(dir, 'doubao_a2.png');
  const fileB1 = path.join(dir, 'doubao_b1.png');
  const fileGone = path.join(dir, 'doubao_gone.png');
  try {
    for (const file of [fileA1, fileA2, fileB1]) await writeFile(file, 'png');
    await saveHistory(dir, [
      { filePath: fileB1, filename: 'doubao_b1.png', workspace: wsB },
      { filePath: fileA1, filename: 'doubao_a1.png', workspace: wsA, attachment: { attachmentId: 'att-a1' } },
      { filePath: fileA2, filename: 'doubao_a2.png', workspace: wsA, attachment: { attachmentId: 'att-a2' } },
      { filePath: fileGone, filename: 'doubao_gone.png', workspace: wsA },
    ]);

    const { ctx, registered } = makeFakeHostCtx();
    apply(ctx, { outputDir: dir });
    const clearRoute = registered.routes.find((route) => route.path === '/doubao-paint/clear');
    assert.ok(clearRoute, '单张删除复用 /doubao-paint/clear');
    const diskPaths = async () => (await loadHistory(dir)).map((item) => item.filePath);

    // 未知 id：404，且一张记录/一个文件都不动
    const unknown = await callClearRoute(clearRoute, 'POST', { id: 'no-such-image' });
    assert.equal(unknown.code, 404);
    assert.equal(unknown.body.ok, false);
    assert.equal(unknown.body.removed, 0);
    assert.equal(existsSync(fileA1), true);
    assert.equal((await diskPaths()).includes(fileA1), true, '未知目标不得删记录');

    // filePath 优先于 id：同一次请求里给一个别的文件名，也不能多删一张
    const first = await callClearRoute(clearRoute, 'POST', {
      filePath: fileA1,
      id: 'doubao_a2.png',
      currentWorkspace: wsA,
    });
    assert.equal(first.code, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.removed, 1);
    assert.equal(first.body.filesRemoved, 1);
    assert.equal(first.body.workspace, wsA);
    assert.equal(existsSync(fileA1), false);
    assert.equal(existsSync(fileA2), true, '同组其它图片必须保留');
    assert.equal(existsSync(fileB1), true, '其它工作区必须保留');
    assert.equal((await diskPaths()).includes(fileA2), true, 'filePath 必须优先，不能按 id 误删第二张');
    const wsAGroup = first.body.groups.find((group) => String(group.key) === wsA);
    assert.ok(wsAGroup, '删除后仍返回该工作区分组');
    assert.equal(wsAGroup.count, 2, 'wsA 从 3 张降到 2 张');

    // id 命中附件 id 同样可以删单张
    const byAttachment = await callClearRoute(clearRoute, 'POST', { id: 'att-a2' });
    assert.equal(byAttachment.code, 200);
    assert.equal(byAttachment.body.removed, 1);
    assert.equal(byAttachment.body.filesRemoved, 1);
    assert.equal(existsSync(fileA2), false);

    // 文件已被手动删掉：记录照样清掉，不得抛错（filesRemoved 为 0）
    const gone = await callClearRoute(clearRoute, 'POST', { id: 'doubao_gone.png' });
    assert.equal(gone.code, 200);
    assert.equal(gone.body.removed, 1);
    assert.equal(gone.body.filesRemoved, 0);
    assert.equal((await diskPaths()).includes(fileGone), false);

    // 落盘只剩 wsB 那条（本次临时目录内）
    assert.equal((await diskPaths()).includes(fileB1), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── G30 面板通道工作区归属：sessionId → 会话 header.cwd ───────────────────────
async function callStatusRoute(route, url) {
  const result = {};
  await route.handler(
    { url, on: () => {} },
    {
      writeHead: (code, headers) => {
        result.code = code;
        result.headers = headers;
      },
      end: (body) => {
        result.body = body ? JSON.parse(body) : undefined;
      },
    },
  );
  return result;
}

/** 假宿主：额外提供 sessionPersistence.stat(id) → { header: { cwd } }，unknown 会抛错。 */
function makeSessionHostCtx(cwdBySession) {
  const { ctx, registered } = makeFakeHostCtx();
  const statCalls = [];
  const baseGet = ctx.get;
  ctx.get = (key) => {
    if (key === 'sessionPersistence') {
      return {
        stat: async (id) => {
          statCalls.push(id);
          if (!Object.prototype.hasOwnProperty.call(cwdBySession, id)) {
            throw new Error('unknown session: ' + id);
          }
          return { header: { id, cwd: cwdBySession[id] } };
        },
      };
    }
    return baseGet(key);
  };
  return { ctx, registered, statCalls };
}

test('G30：面板通道只带 sessionId 时按会话 header.cwd 归组，并矫正被进程 cwd 兜底误标的存量记录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-panel-ws-'));
  const sessionId = 'session-panel-fixture';
  const sessionCwd = 'D:\\work\\proj-a';
  const fallbackCwd = process.cwd();
  const filePanel = path.join(dir, 'doubao_panel.png');
  const fileLegacy = path.join(dir, 'doubao_legacy.png');
  try {
    await writeFile(filePanel, 'png');
    await writeFile(fileLegacy, 'png');
    // 复刻真机 .history.json：同一会话里，面板通道那条被兜底标成 profile 目录，
    // 工具通道那条是对的（真机：desktop vs dsh-doubao-paint）。
    await saveHistory(dir, [
      { filePath: filePanel, filename: 'doubao_panel.png', workspace: fallbackCwd, sessionId },
      { filePath: fileLegacy, filename: 'doubao_legacy.png', workspace: sessionCwd, sessionId },
    ]);

    const { ctx, registered } = makeSessionHostCtx({ [sessionId]: sessionCwd });
    apply(ctx, { outputDir: dir });
    const statusRoute = registered.routes.find((route) => route.path === '/doubao-paint/status');
    assert.ok(statusRoute, '必须注册 /doubao-paint/status');

    const panel = await callStatusRoute(statusRoute, '/doubao-paint/status?sessionId=' + encodeURIComponent(sessionId));
    assert.equal(panel.code === 200 || panel.code === 503, true);
    assert.equal(panel.body.workspace, sessionCwd, '工作区必须由 sessionId 反查会话 header.cwd');
    assert.equal(panel.body.workspaceSource, 'session');

    const own = panel.body.groups.filter((group) => String(group.key) === sessionCwd);
    assert.equal(own.length, 1, '当前工作区只有一个分组');
    assert.equal(own[0].current, true, '「当前工作区」标签必须显示（此前 current=false 的 bug）');
    assert.equal(own[0].label, 'proj-a');
    assert.equal(own[0].count >= 2, true, '两条记录都归到当前工作区');
    const fallbackGroups = panel.body.groups.filter((group) => String(group.key) === fallbackCwd);
    assert.deepEqual(fallbackGroups, [], '不能再出现进程 cwd（desktop）分组');

    const panelFiles = (own[0].images || []).filter((item) => item.filename === path.basename(filePanel) || item.filename === path.basename(fileLegacy));
    assert.equal(panelFiles.length, 2, '一条记录都不能丢');
    assert.equal(panelFiles.every((item) => item.workspace === sessionCwd), true, '误标记录按会话归位');

    // 归位写回磁盘：后续 hydrate/清除看到同一份归属
    const onDisk = (await loadHistory(dir)).filter((item) => item.filename === path.basename(filePanel) || item.filename === path.basename(fileLegacy));
    assert.equal(onDisk.length, 2);
    assert.equal(onDisk.every((item) => item.workspace === sessionCwd), true);

    // 显式 ?workspace 仍然优先（会话内 cd 之后前端能给出更精确的路径）
    const explicit = await callStatusRoute(
      statusRoute,
      '/doubao-paint/status?workspace=' + encodeURIComponent(sessionCwd + '\\design') + '&sessionId=' + encodeURIComponent(sessionId),
    );
    assert.equal(explicit.body.workspace, sessionCwd + '\\design');
    assert.equal(explicit.body.workspaceSource, 'request');

    // 会话已删除时回落：解析不到就退回空串（不要让 stat 的异常冒到路由）
    const orphan = await callStatusRoute(statusRoute, '/doubao-paint/status?sessionId=session-gone');
    assert.equal(orphan.body.workspace, '');
    assert.equal(orphan.body.workspaceSource, 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── G31 工作区矫正的边界：只动「进程 cwd 兜底」记录 ──────────────────────────
test('G31：工作区矫正只动进程 cwd 兜底记录，cd 子目录 / 未知会话 / 其它工作区保持原样', async () => {
  const fallback = process.cwd();
  const sessionCwd = 'D:\\work\\proj-a';
  const subdir = path.join(sessionCwd, 'design');
  const records = [
    { filename: 'cd-subdir.png', workspace: subdir, sessionId: 'session-a' },
    { filename: 'unknown-session.png', workspace: '', sessionId: 'session-missing' },
    { filename: 'other-workspace.png', workspace: 'D:\\work\\proj-b', sessionId: 'session-a' },
    { filename: 'fallback-hit.png', workspace: fallback, sessionId: 'session-a' },
    { filename: 'no-session.png', workspace: fallback, sessionId: '' },
  ];

  const { ctx } = makeSessionHostCtx({ 'session-a': sessionCwd });
  assert.equal(await resolveWorkspaceBySessionId(ctx, 'session-a'), sessionCwd);
  assert.equal(await resolveWorkspaceBySessionId(ctx, 'session-missing'), '', '未知会话不抛错');
  assert.equal(await resolveWorkspaceBySessionId({}, 'session-a'), '');
  assert.deepEqual(await resolveRequestWorkspace(ctx, { sessionId: 'session-a' }), {
    workspace: sessionCwd,
    source: 'session',
  });
  assert.deepEqual(await resolveRequestWorkspace(ctx, { workspace: '  D:\\work\\proj-z  ', sessionId: 'session-a' }), {
    workspace: 'D:\\work\\proj-z',
    source: 'request',
  });
  assert.deepEqual(await resolveRequestWorkspace(makeFakeHostCtx().ctx, { sessionId: 'session-a' }), {
    workspace: '',
    source: 'none',
  });

  const index = new Map([['session-a', sessionCwd]]);
  const repaired = repairFallbackWorkspace(records, index, [fallback]);
  assert.notEqual(repaired, records, '有命中时必须返回新数组');
  assert.equal(repaired.length, records.length, '不得增删记录');
  assert.equal(repaired[0].workspace, subdir, 'cd 到子目录生成的记录不能被改写');
  assert.equal(repaired[1].workspace, '', '未知会话的记录保持原样');
  assert.equal(repaired[2].workspace, 'D:\\work\\proj-b', '其它工作区记录不动');
  assert.equal(repaired[3].workspace, sessionCwd, '被进程 cwd 兜底误标的记录归位到会话工作区');
  assert.equal(repaired[4].workspace, fallback, '没有 sessionId 的记录无法反查，保持原样');
  assert.equal(records[3].workspace, fallback, '入参不被就地改写');

  const untouched = records.slice(0, 3);
  assert.equal(repairFallbackWorkspace(untouched, index, [fallback]), untouched, '无命中时原样返回同一引用');
  assert.equal(repairFallbackWorkspace(records, new Map(), [fallback]), records, '没有会话索引时不做事');
  assert.equal(repairFallbackWorkspace(records, index, []), records, '没有兜底候选时不做事');
});

// ── G33 预览灯箱（点击缩略图放大） ───────────────────────────────────────────
test('G33：点击缩略图打开灯箱预览，×/引用路径不触发，Esc 与箭头可用', async () => {
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
  const listeners = new Map();
  let confirmAnswer = true;
  let clearResponse = { ok: true, groups: [] };
  const windowStub = {
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener: (type, handler) => {
      const set = listeners.get(type);
      if (set) set.delete(handler);
    },
    dispatchEvent: () => true,
    confirm: () => confirmAnswer,
  };
  const sandbox = {
    window: windowStub,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    URL,
    URLSearchParams,
    AbortController,
    fetch: async () => ({ ok: true, json: async () => clearResponse }),
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  // 带状态的 hook 桩：同一次 render 内按调用顺序分配槽位，便于模拟点击后的重渲染
  const states = [];
  const effectSlots = [];
  let hookIndex = 0;
  let currentEffects = [];
  const React = {
    createElement: () => null,
    useState: (initial) => {
      const index = hookIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      const setState = (value) => {
        states[index] = typeof value === 'function' ? value(states[index]) : value;
      };
      return [states[index], setState];
    },
    useEffect: (fn, deps) => {
      currentEffects.push({ slot: hookIndex++, fn, deps });
    },
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
  const makeStub = () =>
    new Proxy(function () {}, {
      get: (target, key) =>
        key === 'then' || key === Symbol.toPrimitive ? undefined : makeStub(),
      apply: () => makeStub(),
    });
  const moduleApi = sandbox.__DSH_DOUBAO_PAINT_BUILD__((id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return jsxRuntime;
    if (id === '@deepseek-ai/dsh-client-store') {
      return {
        useStore: (store, selector) => (selector ? selector(store.getSnapshot()) : store.getSnapshot()),
      };
    }
    return makeStub();
  });

  const registeredComponents = [];
  const clientCtx = {
    locale: { register: () => {} },
    effect: (fn) => fn(),
    enableInputDock: true,
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, component) => registeredComponents.push(component),
    },
  };
  moduleApi.apply(clientCtx);
  const dockFactory = registeredComponents[1];

  const store = moduleApi.getSessionStore('session-1');
  if (!store.getSnapshot().expanded) store.toggleExpanded();

  const images = Array.from({ length: 6 }, (_, index) => ({
    id: `preview-${index}`,
    filename: `preview-${index}.png`,
    filePath: `D:\\work\\proj-a\\doubao_images\\preview-${index}.png`,
    previewUrl: `/doubao-paint/file?path=preview-${index}.png`,
    prompt: `提示词 ${index}`,
    width: 2848,
    height: 1600,
  }));
  const groupKey = 'D:\\work\\proj-a';
  store.setGroups(
    [{ key: groupKey, label: 'proj-a', count: 6, latestAt: '', current: true, images }],
    groupKey,
  );

  const commitEffects = () => {
    const next = currentEffects;
    const seen = new Set();
    next.forEach((effect) => {
      seen.add(effect.slot);
      const prev = effectSlots[effect.slot];
      const changed =
        !prev ||
        !prev.deps ||
        !effect.deps ||
        prev.deps.length !== effect.deps.length ||
        prev.deps.some((value, index) => value !== effect.deps[index]);
      if (!changed) return;
      if (prev && typeof prev.cleanup === 'function') prev.cleanup();
      const cleanup = effect.fn();
      effectSlots[effect.slot] = { deps: effect.deps, cleanup };
    });
    effectSlots.forEach((prev, slot) => {
      if (seen.has(slot) || !prev || typeof prev.cleanup !== 'function') return;
      prev.cleanup();
      effectSlots[slot] = undefined;
    });
  };
  const render = () => {
    hookIndex = 0;
    currentEffects = [];
    const node = dockFactory({ sessionId: 'session-1', session: { cwd: groupKey } });
    commitEffects();
    return node;
  };

  const collect = (root) => {
    const nodes = [];
    const walk = (node) => {
      if (node === null || node === undefined || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      nodes.push(node);
      if (node.props) walk(node.props.children);
    };
    walk(root);
    return nodes;
  };
  const textOf = (root) =>
    collect(root)
      .map((node) => (node.props ? node.props.children : undefined))
      .filter((value) => typeof value === 'string')
      .join('|');
  const byClass = (nodes, className) =>
    nodes.filter((node) => node.props && node.props.className === className);
  const findMask = (nodes) => byClass(nodes, 'dsh-dbimg-preview-mask')[0];

  let dock = render();
  assert.equal(findMask(collect(dock)), undefined, '默认不渲染预览浮层');
  const cards = () => byClass(collect(dock), 'dsh-dbimg-card');
  assert.equal(cards().length, 6);

  // 1) 卡片带点击入口，且不改变卡片原有的两个角标/浮层子结构
  for (const [index, card] of cards().entries()) {
    assert.equal(typeof card.props.onClick, 'function', '缩略图卡片必须可点击打开预览');
    assert.equal(card.props['data-dsh-doubao-open-preview'], index, '卡片携带组内下标');
  }

  // 2) 点第一张 → 浮层结构齐备
  cards()[0].props.onClick();
  dock = render();
  let nodes = collect(dock);
  const mask = findMask(nodes);
  assert.ok(mask, '点击缩略图必须渲染预览浮层');
  assert.equal(mask.props['data-dsh-doubao-preview'], groupKey);
  const previewImg = byClass(nodes, 'dsh-dbimg-preview-img');
  assert.equal(previewImg.length, 1, '浮层里只有一张大图');
  assert.equal(previewImg[0].type, 'img');
  assert.equal(previewImg[0].props.src, images[0].previewUrl, '大图打开的是被点的这张');
  assert.equal(byClass(nodes, 'dsh-dbimg-preview-stage').length, 1);
  assert.equal(byClass(nodes, 'dsh-dbimg-preview-info').length, 1);
  const navs = () => byClass(collect(dock), 'dsh-dbimg-preview-nav');
  assert.equal(navs().length, 2, '左右各一个切换箭头');
  assert.equal(navs()[0].props.disabled, true, '第一张时「上一张」禁用，不循环');
  assert.equal(navs()[1].props.disabled, false);
  const closeBtn = byClass(nodes, 'dsh-dbimg-preview-close')[0];
  assert.ok(closeBtn, '浮层要有右上角关闭按钮');
  assert.equal(closeBtn.props.children, '×');
  assert.equal(closeBtn.props['aria-label'], '关闭预览');
  assert.equal(closeBtn.props['data-dsh-doubao-preview-close'], '1');
  assert.equal(typeof closeBtn.props.onClick, 'function');
  const infoText = textOf(mask);
  assert.match(infoText, /提示词 0/, '信息行显示提示词');
  assert.match(infoText, /2848×1600/, '信息行显示尺寸');
  assert.match(infoText, /preview-0\.png/, '信息行显示文件名');
  assert.equal(byClass(nodes, 'dsh-dbimg-preview-prompt').length, 1);
  assert.equal(byClass(nodes, 'dsh-dbimg-preview-meta').length, 1);
  assert.ok(
    nodes.some((node) => node.props && node.props['data-dsh-doubao-preview-remove'] === '1'),
    '浮层内保留删除入口',
  );
  assert.ok(
    nodes.some((node) => node.props && node.props['data-dsh-doubao-preview-quote'] === '1'),
    '浮层内保留引用路径入口',
  );

  // 3) 键盘监听只在预览打开时挂载
  assert.equal((listeners.get('keydown') || new Set()).size, 1, '打开预览即挂载 keydown');

  // 4) 左右切换：→ 前进、← 到头保持第一张
  navs()[1].props.onClick({ stopPropagation: () => {} });
  dock = render();
  assert.equal(
    byClass(collect(dock), 'dsh-dbimg-preview-img')[0].props.src,
    images[1].previewUrl,
  );
  assert.equal(navs()[0].props.disabled, false, '第二张起「上一张」可用');
  navs()[0].props.onClick({ stopPropagation: () => {} });
  dock = render();
  navs()[0].props.onClick({ stopPropagation: () => {} });
  dock = render();
  assert.equal(
    byClass(collect(dock), 'dsh-dbimg-preview-img')[0].props.src,
    images[0].previewUrl,
    '到边界后不再往前翻',
  );
  assert.equal(navs()[0].props.disabled, true);

  // 5) Esc 关闭 + 解绑
  const keydown = Array.from(listeners.get('keydown') || [])[0];
  assert.equal(typeof keydown, 'function');
  let prevented = false;
  keydown({ key: 'Escape', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true, 'Esc 必须 preventDefault');
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, 'Esc 关闭浮层');
  assert.equal((listeners.get('keydown') || new Set()).size, 0, '关闭后解绑 keydown');

  // 6) 遮罩空白处点击关闭
  cards()[2].props.onClick();
  dock = render();
  findMask(collect(dock)).props.onClick({});
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, '点遮罩空白处关闭浮层');

  // 7) 预览内「引用路径」不关闭、不冒泡；缩略图「×」与「引用路径」不打开预览
  cards()[3].props.onClick();
  dock = render();
  nodes = collect(dock);
  const quoteInside = nodes.find(
    (node) => node.props && node.props['data-dsh-doubao-preview-quote'] === '1',
  );
  let stopped = false;
  quoteInside.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, '浮层内按钮必须阻止冒泡到遮罩（否则点一下就被关掉）');
  dock = render();
  assert.ok(findMask(collect(dock)), '点浮层内「引用路径」后浮层仍在');
  byClass(collect(dock), 'dsh-dbimg-preview-close')[0].props.onClick({
    stopPropagation: () => {},
  });
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, '点浮层内「×」关闭浮层');

  nodes = collect(dock);
  const thumbs = byClass(nodes, 'dsh-dbimg-card');
  const quoteThumb = byClass(nodes, 'dsh-dbimg-mini-btn')[0];
  stopped = false;
  quoteThumb.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, '缩略图「引用路径」必须阻止冒泡');
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, '点「引用路径」不得打开预览');

  const closeThumb = byClass(collect(dock), 'dsh-dbimg-card-close')[0];
  stopped = false;
  closeThumb.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.equal(stopped, true, '缩略图「×」必须阻止冒泡');
  await new Promise((resolve) => setTimeout(resolve, 0));
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, '点「×」不得打开预览');
  assert.equal(thumbs.length, 6);

  // 8) 预览内删除后跟随刷新：删掉当前图，预览落到同组下一张
  clearResponse = { ok: true, workspace: groupKey, removed: 1, groups: [
    { key: groupKey, label: 'proj-a', count: 5, images: images.slice(1) },
  ] };
  const remaining = images.slice(1);
  store.setGroups([{ key: groupKey, label: 'proj-a', count: 6, images }], groupKey);
  dock = render();
  cards()[0].props.onClick();
  dock = render();
  nodes = collect(dock);
  const removeInside = nodes.find(
    (node) => node.props && node.props['data-dsh-doubao-preview-remove'] === '1',
  );
  assert.equal(typeof removeInside.props.onClick, 'function');
  removeInside.props.onClick({ stopPropagation: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dock = render();
  nodes = collect(dock);
  const afterDelete = findMask(nodes);
  assert.ok(afterDelete, '删掉一张后浮层仍打开（还有图）');
  assert.equal(
    byClass(nodes, 'dsh-dbimg-preview-img')[0].props.src,
    remaining[0].previewUrl,
    '删除后预览指向同组下一张',
  );

  // 9) 删掉最后一张 → 浮层自动关闭
  clearResponse = { ok: true, workspace: groupKey, removed: 1, groups: [] };
  store.setGroups([{ key: groupKey, label: 'proj-a', count: 1, images: [remaining[0]] }], groupKey);
  dock = render();
  cards()[0].props.onClick();
  dock = render();
  const lastRemove = collect(dock).find(
    (node) => node.props && node.props['data-dsh-doubao-preview-remove'] === '1',
  );
  lastRemove.props.onClick({ stopPropagation: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  dock = render();
  assert.equal(findMask(collect(dock)), undefined, '删掉最后一张后浮层自动关闭');
  assert.equal((listeners.get('keydown') || new Set()).size, 0, '关闭后不留键盘监听');
});

// ── G34 取证只对真实动作模式落盘（t8：status 轮询不再产生 doubao-status-* 噪音） ──
test('G34：status 模式失败不落盘（只回契约计数），generate 失败仍写 dom-<step>.html', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'doubao-evidence-'));
  const runsDir = path.join(dir, '.runs');
  const contractCounts = {
    loginButton: 1,
    loginModal: 0,
    workMode: 1,
    workspaceChip: 0,
    newConversation: 1,
    skillButton: 1,
    inputEditor: 1,
    sendButton: 1,
  };
  // 浏览器脚本在 01-probe 直接抛错（宿主里 status 轮询失败的典型形态）
  const failingChrome = {
    async ensureDaemon() {},
    async ensurePage() {
      return { pageId: 7, url: 'https://www.doubao.com/chat/' };
    },
    async evaluate(name) {
      if (name === '00-wait-ready') return { ok: true };
      if (name === '01-probe') {
        throw new Error('evaluate failed: target closed');
      }
      if (name.startsWith('dom-dump-')) {
        return {
          ok: true,
          pageUrl: 'https://www.doubao.com/chat/abc',
          pageTitle: '豆包',
          html: '<html><body><div id="chat_input_input"></div></body></html>',
          htmlLength: 57,
          truncated: false,
        };
      }
      return { ok: true };
    },
    async screenshot() {
      return 'ok';
    },
    async stop() {},
  };
  const fetchImage = async () => ({
    ok: true,
    headers: { get: () => 'image/webp' },
    arrayBuffer: async () => Uint8Array.from([0x52, 0x49, 0x46, 0x46]).buffer,
  });
  const config = normalizeConfig({ outputDir: dir, timeoutMs: 8000, keepTab: true, attachImages: false });

  try {
    // 1) status（纯查询）：失败也不许落盘、不许建 runDir，只把契约计数带回响应体
    const statusResult = await executeDoubaoAction(
      { mode: 'status', config },
      { chrome: failingChrome, fetchImage, history: [], cwd: dir },
    );
    assert.equal(statusResult.status, 'failed');
    assert.equal(statusResult.details?.skipped, 'mode:status', '查询模式取证必须被跳过');
    assert.deepEqual(statusResult.details?.artifacts, { dom: null, pageUrl: null, contract: null });
    assert.equal(statusResult.details?.step, '01-probe');
    assert.equal(existsSync(runsDir), false, 'status 失败不得新建 .runs 目录（噪音来源）');
    assert.deepEqual((await readdirSafe(dir)) , [], '.runs 不存在时临时目录里不应多出任何取证文件');

    // 2) generate（真实动作）：同样的失败必须把现场写进 runDir
    const genResult = await executeDoubaoAction(
      { mode: 'generate', prompt: '一只哈基米', maxImages: 1, config },
      { chrome: failingChrome, fetchImage, history: [], cwd: dir },
    );
    assert.equal(genResult.status, 'failed');
    assert.equal(genResult.details?.step, '01-probe');
    assert.equal(genResult.details?.skipped, undefined, '动作模式不得走 skipped 分支');
    const savedRuns = await readdirSafe(runsDir);
    assert.equal(savedRuns.length, 1, 'generate 失败恰好产生一个 runDir');
    const runDir = path.join(runsDir, savedRuns[0]);
    const domPath = genResult.details?.artifacts?.dom;
    assert.equal(path.dirname(domPath), runDir);
    assert.match(path.basename(domPath), /^dom-01-probe\.html$/);
    const domStat = await stat(domPath);
    assert.ok(domStat.size > 0, 'dom-<step>.html 必须真落盘');
    assert.deepEqual((await readdirSafe(runDir)).sort(), ['contract.json', 'dom-01-probe.html', 'page-url.txt']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function readdirSafe(target) {
  try {
    return await readdir(target);
  } catch {
    return [];
  }
}
