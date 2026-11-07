/**
 * 人类命令入口。
 *
 * 自 v1.2.0 起分两条，语义不同但共用同一份结果契约与提示词拼装：
 *
 *   `/doubao-paint`        → **转交模型**：命令只解析参数，把「先细化再调工具」
 *                            的指令交给客户端代你送进会话输入框并发送
 *                            （用户 2026-11-07 批注：命令应先让大模型接收）。
 *   `/doubao-paint-direct` → **零模型回合直出**：解析参数 → submitPaintRequest
 *                            → renderCommandResult（CLI / 远程终端 / 想跳过模型时用）。
 */

import { buildRefineInstruction, renderCommandResult, renderRelayResult } from './render.js';

export const PAINT_COMMAND_NAME = 'doubao-paint';

export const PAINT_DIRECT_COMMAND_NAME = 'doubao-paint-direct';

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

  const relayDefinition = {
    name: PAINT_COMMAND_NAME,
    description: '把画面描述转交模型细化后调用 doubao_generate_image（先在输入框写成指令，再自动发送）',
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

      const instruction = buildRefineInstruction(args);
      return renderRelayResult({ ...args, instruction });
    },
  };

  const directDefinition = {
    name: PAINT_DIRECT_COMMAND_NAME,
    description: '不经模型、直接操控豆包网页生图（CLI / 远程终端用；等价于 doubao_generate_image 工具）',
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
          text: `用法：/${PAINT_DIRECT_COMMAND_NAME} ${PAINT_COMMAND_HINT}`,
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

  const disposers = [relayDefinition, directDefinition].map((definition) => {
    const disposer = commands.register(definition);
    return typeof disposer === 'function' ? disposer : () => {};
  });

  return () => {
    for (const disposer of disposers) {
      try {
        disposer();
      } catch {
        /* 释放失败不影响其余条目 */
      }
    }
  };
}