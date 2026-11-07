/**
 * 人类命令入口 `/doubao-paint`。
 *
 * 命令 = 零模型回合的确定性直出：解析参数 → submitPaintRequest →
 * renderCommandResult。与工具、路由共用同一个入口与同一份结果契约，
 * 唯一的差别是"谁来渲染"。
 */

import { renderCommandResult } from './render.js';

export const PAINT_COMMAND_NAME = 'doubao-paint';

export const PAINT_COMMAND_HINT =
  '<画面描述> [--ratio 16:9] [--style cyberpunk] [--count 2] [--neg 避免内容] [--dir 目录] [--reuse]';

const VALUE_FLAGS = new Map([
  ['--ratio', 'aspectRatio'],
  ['--aspect', 'aspectRatio'],
  ['--style', 'style'],
  ['--count', 'maxImages'],
  ['--n', 'maxImages'],
  ['--neg', 'negativePrompt'],
  ['--negative', 'negativePrompt'],
  ['--dir', 'outputDir'],
  ['--out', 'outputDir'],
  ['--prefix', 'filenamePrefix'],
  ['--filename-prefix', 'filenamePrefix'],
]);

const BOOLEAN_FLAGS = new Map([
  ['--reuse', 'newConversation'],
  ['--keep-chat', 'newConversation'],
  ['--keep-tab', 'keepTab'],
  ['--no-keep-tab', 'keepTab'],
]);

/** 去掉成对的引号，让 `/doubao-paint "一只猫" --style anime` 也能用。 */
function unquote(value) {
  const text = String(value ?? '').trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * 解析命令行参数。未知 `--flag` 不报错，原样留在提示词里（宽容解析）。
 * @returns {{prompt: string, aspectRatio?: string, style?: string, negativePrompt?: string,
 *            maxImages?: number, newConversation?: boolean, keepTab?: boolean,
 *            outputDir?: string, filenamePrefix?: string}}
 */
export function parseCommandArgs(rawInput) {
  const tokens = String(rawInput ?? '').match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const promptParts = [];
  /** @type {Record<string, unknown>} */
  const parsed = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const equals = token.indexOf('=');

    if (equals > 2 && token.startsWith('--')) {
      const flag = token.slice(0, equals);
      const value = unquote(token.slice(equals + 1));
      if (VALUE_FLAGS.has(flag)) {
        parsed[VALUE_FLAGS.get(flag)] = value;
        continue;
      }
      promptParts.push(token);
      continue;
    }

    if (BOOLEAN_FLAGS.has(token)) {
      const key = BOOLEAN_FLAGS.get(token);
      parsed[key] = token === '--reuse' || token === '--keep-chat' ? false : token === '--keep-tab';
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const key = VALUE_FLAGS.get(token);
      const next = tokens[i + 1];
      if (next === undefined) {
        throw new Error(`参数 ${token} 缺少取值`);
      }
      parsed[key] = unquote(next);
      i += 1;
      continue;
    }

    promptParts.push(unquote(token));
  }

  const prompt = promptParts.join(' ').trim();
  if (typeof parsed.maxImages === 'string') {
    const count = Number.parseInt(parsed.maxImages, 10);
    parsed.maxImages = Number.isFinite(count) ? count : undefined;
  }

  return {
    prompt,
    ...parsed,
  };
}

/**
 * 注册 `/doubao-paint` 命令。
 *
 * @param {object} commands 宿主 commands 服务
 * @param {(request: object) => Promise<object>} run 执行器（由 index.js 绑定 ctx/config/history）
 * @returns {() => void} disposer
 */
export function registerPaintCommand(commands, run) {
  if (!commands || typeof commands.register !== 'function') {
    return () => {};
  }

  const definition = {
    name: PAINT_COMMAND_NAME,
    description: '用豆包网页版生成图片（等价于 doubao_generate_image 工具，零模型回合）',
    input: { hint: PAINT_COMMAND_HINT, attachments: false },
    async handler(invocation) {
      let args;
      try {
        args = parseCommandArgs(invocation?.rawInput);
      } catch (err) {
        return { kind: 'error', text: String(err?.message || err) };
      }

      if (!args.prompt) {
        return {
          kind: 'error',
          text: `用法：/${PAINT_COMMAND_NAME} ${PAINT_COMMAND_HINT}`,
        };
      }

      const outcome = await run({
        mode: 'generate',
        prompt: args.prompt,
        aspectRatio: args.aspectRatio,
        style: args.style,
        negativePrompt: args.negativePrompt,
        outputDir: args.outputDir,
        filenamePrefix: args.filenamePrefix,
        maxImages: args.maxImages,
        newConversation: args.newConversation,
        keepTab: args.keepTab,
      });
      return renderCommandResult(outcome);
    },
  };

  const disposer = commands.register(definition);
  return typeof disposer === 'function' ? disposer : () => {};
}