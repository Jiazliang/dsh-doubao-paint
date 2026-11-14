(() => {
  const MODULE_ID = "dsh-doubao-paint";
  const NS = "doubao-paint";
  const STYLE_ELEMENT_ID = "dsh-doubao-paint-styles";

  const ASPECT_RATIOS = [
    { id: "16:9", label: "16:9 横屏" },
    { id: "1:1", label: "1:1 方图" },
    { id: "9:16", label: "9:16 竖屏" },
    { id: "4:3", label: "4:3 经典" },
    { id: "3:4", label: "3:4 海报" },
    { id: "3:2", label: "3:2 摄影" },
    { id: "2:3", label: "2:3 竖画" },
  ];

  const STYLE_PRESETS = [
    { id: "auto", label: "✨ 智能匹配", hint: "" },
    { id: "cinematic-cg", label: "🎬 电影级 CG", hint: "电影级 CG 渲染，极致光影质感，8K 超高清细节" },
    { id: "photorealistic", label: "📷 写实摄影", hint: "大师级写实摄影，自然景深，光学镜头质感" },
    { id: "cyberpunk", label: "🌃 赛博朋克", hint: "赛博朋克霓虹未来主义，冷暖高对比光效" },
    { id: "chinese-ink", label: "🖌️ 国风水墨", hint: "东方美学新国风水墨意境，留白构图，宣纸晕染" },
    { id: "anime", label: "🌸 动漫二次元", hint: "高品质动画电影风格，通透光感，细腻色彩" },
    { id: "3d-isometric", label: "🧊 3D 盲盒潮玩", hint: "C4D + Blender 3D 盲盒潮玩渲染，柔和全局光照" },
    { id: "minimal-editorial", label: "📐 极简插画", hint: "现代极简扁平矢量插画，高级配色，干净利落" },
  ];

  /** 从 slot 下发的 session 快照里取工作区根目录（宿主 byId 记录上的 cwd）。 */
  function workspaceOfSession(session) {
    if (!session || typeof session !== "object") return "";
    const candidates = [
      session.cwd,
      session.header && session.header.cwd,
      session.workingDirectory,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
    }
    return "";
  }

  /** 大小写不敏感地比较两个 Windows/POSIX 风格工作区路径。 */
  function sameWorkspace(a, b) {
    const left = String(a || "").replace(/[\\/]+$/, "").toLowerCase();
    const right = String(b || "").replace(/[\\/]+$/, "").toLowerCase();
    return left.length > 0 && left === right;
  }

  /**
   * 把服务端 groups / 老服务端的裸 history 归一成面板可渲染的分组列表。
   * 每组：{ key, label, count, current, images }；当前工作区置顶。
   */
  function normalizeHistoryGroups(data, workspace) {
    const source = data && typeof data === "object" ? data : {};
    const current = typeof workspace === "string" ? workspace : "";
    const groups = Array.isArray(source.groups) ? source.groups : [];
    const normalized = groups
      .filter((group) => group && typeof group === "object")
      .map((group) => {
        const images = Array.isArray(group.images) ? group.images : [];
        const key = typeof group.key === "string" ? group.key : "";
        const count = Number(group.count);
        return {
          key,
          label: typeof group.label === "string" && group.label ? group.label : "全部记录",
          count: Number.isFinite(count) && count >= images.length ? count : images.length,
          current: Boolean(group.current) || sameWorkspace(key, current),
          images,
        };
      });
    if (normalized.length > 0) {
      normalized.sort((a, b) => Number(b.current) - Number(a.current));
      return normalized;
    }
    const history = Array.isArray(source.history) ? source.history : [];
    if (history.length === 0) return [];
    return [{ key: "", label: "全部记录", count: history.length, current: true, images: history }];
  }

  /**
   * 生成插入输入框的文本：用 `/doubao-paint` 技能手势（v1.3.0 起的唯一人类入口），
   * 宿主会把技能说明注入本回合，模型再调 `doubao_generate_image` 走同一条生图通道。
   * 手势后紧跟描述与可选参数，保持单行，避免破坏手势解析。
   */
  function formatAgentCommandPrompt(prompt, options = {}) {
    const cleaned = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
    if (!cleaned) return "";
    const ratio = options.aspectRatio || "16:9";
    const styleObj = STYLE_PRESETS.find((s) => s.id === options.style);
    const styleLabel =
      styleObj && styleObj.id !== "auto"
        ? styleObj.label.replace(/^[^\s]+\s*/, "")
        : options.style && options.style !== "auto"
          ? options.style
          : "";
    const meta = [`比例：${ratio}`];
    if (styleLabel) meta.push(`风格：${styleLabel}`);
    if (options.negativePrompt && options.negativePrompt.trim()) {
      meta.push(`负面提示词：${options.negativePrompt.trim()}`);
    }
    return `/doubao-paint ${cleaned}（${meta.join("，")}）`;
  }

  /**
   * 取会话输入框的动作集（InputActions）。
   * 优先使用 slot 下发的 `inputActions` prop；宿主未给该 prop 时保留旧的
   * `ctx.conversation.input.shell()` 兜底（该路径在 client 侧通常不存在）。
   */
  function resolveInputActions(ctx, sessionId, inputActions) {
    if (inputActions && typeof inputActions === "object") return inputActions;
    try {
      const shell = ctx?.conversation?.input?.shell?.(sessionId);
      if (shell && shell.actions && typeof shell.actions === "object") return shell.actions;
    } catch (_err) {
      return undefined;
    }
    return undefined;
  }

  function insertIntoComposerDraft(ctx, sessionId, rawText, inputActions) {
    const cleaned = typeof rawText === "string" ? rawText.trim() : "";
    if (!cleaned) return false;
    const textWithNewline = `${cleaned}\n`;

    const actions = resolveInputActions(ctx, sessionId, inputActions);
    if (actions) {
      let insertedByActions = false;
      if (
        typeof actions.captureInsertion === "function" &&
        typeof actions.insertText === "function"
      ) {
        try {
          const span = actions.captureInsertion();
          insertedByActions = Boolean(actions.insertText(textWithNewline, span));
        } catch (_err) {
          insertedByActions = false;
        }
      }
      if (!insertedByActions && typeof actions.setDraft === "function") {
        try {
          actions.setDraft(textWithNewline);
          insertedByActions = true;
        } catch (_err) {
          insertedByActions = false;
        }
      }
      if (insertedByActions && typeof actions.persistDraft === "function") {
        try {
          actions.persistDraft();
        } catch (_err) {
          // 持久化失败不影响已插入的草稿
        }
      }
      if (insertedByActions) return true;
    }

    const shell = ctx?.conversation?.input?.shell?.(sessionId);
    let inserted = false;

    if (shell) {
      const currentDraft = shell.projection?.clipboardText ?? "";
      const hasExisting = currentDraft.trim().length > 0;
      const payload = hasExisting
        ? `${currentDraft.replace(/\s+$/, "")}\n\n${textWithNewline}`
        : textWithNewline;

      if (!hasExisting && shell.actions && typeof shell.actions.insertText === "function") {
        try {
          const span =
            typeof shell.actions.captureInsertion === "function"
              ? shell.actions.captureInsertion()
              : undefined;
          inserted = Boolean(shell.actions.insertText(textWithNewline, span));
        } catch (_err) {
          inserted = false;
        }
      }

      if (!inserted && typeof shell.setDraft === "function") {
        shell.setDraft(payload);
        inserted = true;
      } else if (!inserted && shell.actions && typeof shell.actions.insertText === "function") {
        const prefix = currentDraft && !currentDraft.endsWith("\n") ? "\n\n" : "";
        const span =
          typeof shell.actions.captureInsertion === "function"
            ? shell.actions.captureInsertion()
            : undefined;
        inserted = Boolean(shell.actions.insertText(`${prefix}${textWithNewline}`, span));
      }

      if (typeof shell.focus === "function") {
        try {
          shell.focus();
        } catch (_err) {
          // ignore
        }
      }
    }
    return inserted;
  }

  function ensureStylesInjected() {
    if (typeof document === "undefined") return;
    if (document.getElementById(STYLE_ELEMENT_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ELEMENT_ID;
    style.textContent = `
      /* 语义槽位：面板与触发条共用一套，明暗由宿主令牌换值，本文件不再写
         @media (prefers-color-scheme: dark) 补丁。accent 的透明度变体用
         color-mix 从同一个 accent 派生，先给 rgba 兜底再给 color-mix。 */
      .dsh-dbimg-panel,
      .dsh-dbimg-trigger-chip {
        --db-surface: var(--dsh-surface-floating, #ffffff);
        --db-text: var(--dsh-text-primary, #0f172a);
        --db-text-dim: var(--dsw-alias-label-secondary, #6b7280);
        --db-line: var(--dsw-alias-line-subtle, #e5e7eb);
        --db-line-soft: var(--dsw-alias-border-weak, #e5e7eb);
        --db-wash: var(--dsw-alias-bg-subtle, #f9fafb);
        --db-accent: var(--dsw-alias-state-business-primary, #2563eb);
        --db-accent-strong: #1d4ed8;
        --db-accent-strong: color-mix(in srgb, var(--db-accent) 82%, #000000);
        --db-accent-soft: var(--dsw-alias-interactive-bg-hover-solid, rgba(37, 99, 235, 0.12));
        --db-accent-line: rgba(37, 99, 235, 0.3);
        --db-accent-line: color-mix(in srgb, var(--db-accent) 30%, transparent);
        --db-accent-ink: light-dark(#ffffff, #10131a);
        --db-warn: var(--dsw-alias-state-error-primary, #dc2626);
        --db-warn-soft: rgba(220, 38, 38, 0.08);
        --db-warn-soft: color-mix(in srgb, var(--db-warn) 8%, transparent);
        --db-warn-line: rgba(220, 38, 38, 0.3);
        --db-warn-line: color-mix(in srgb, var(--db-warn) 30%, transparent);
        --db-canvas: var(--dsw-alias-bg-subtle, #f3f4f6);
        --db-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.12);
        --db-overlay: rgba(8, 11, 18, 0.62);
        --db-overlay-ink: #ffffff;
      }

      /* dock 槽外层已由 GRgSLq_root 给了一侧 clearance，这里不再重复 padding，
         宽度与 composer 卡片保持一致，面板圆角也用同一个 --dsw-radius-panel 令牌 */
      .dsh-dbimg-dock-wrap {
        box-sizing: border-box;
        width: 100%;
        display: flex;
        justify-content: center;
        padding: 0;
        margin: 0 auto 6px;
        font-family: system-ui, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }

      /* 触发条：挂在 conversation.input.left，与「工作区内修改」同一行、紧随其右侧 */
      .dsh-dbimg-trigger-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: var(--db-text-dim);
        font-family: inherit;
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        transition: background 0.12s ease, color 0.12s ease;
      }

      .dsh-dbimg-trigger-chip:hover {
        background: var(--db-wash);
        color: var(--db-text);
      }

      .dsh-dbimg-trigger-chip > svg {
        width: 15px;
        height: 15px;
        flex: none;
        display: block;
      }

      .dsh-dbimg-trigger-chip[data-dsh-doubao-chip="expanded"] {
        background: var(--db-accent-soft);
        color: var(--db-accent);
      }

      .dsh-dbimg-trigger-chip-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .dsh-dbimg-trigger-chip-badge {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--db-accent-soft);
        color: var(--db-accent);
        font-size: 11px;
        font-weight: 600;
      }

      @container (width<=560px) {
        .dsh-dbimg-trigger-chip-label {
          display: none;
        }
      }

      .dsh-dbimg-panel {
        box-sizing: border-box;
        width: 100%;
        max-width: var(--dsh-composer-card-max-width, 952px);
        color-scheme: light dark;
        border-radius: 20px;
        padding: 12px 14px;
        max-height: min(60vh, 560px);
        overflow-y: auto;
        background: var(--db-surface);
        color: var(--db-text);
        border: 1px solid var(--db-line);
        box-shadow: var(--db-shadow);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .dsh-dbimg-mini-btn {
        border: 1px solid var(--db-line);
        background: transparent;
        color: inherit;
        font-size: 11.5px;
        padding: 3px 9px;
        border-radius: 7px;
        cursor: pointer;
        opacity: 0.82;
        transition: all 0.15s ease;
      }

      .dsh-dbimg-mini-btn:hover {
        opacity: 1;
        background: var(--db-accent-soft);
        border-color: var(--db-accent-line);
      }

      .dsh-dbimg-textarea {
        width: 100%;
        min-height: 62px;
        max-height: 160px;
        resize: vertical;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid var(--db-line);
        background: var(--db-wash);
        color: inherit;
        padding: 8px 10px;
        font-size: 13px;
        line-height: 1.45;
        outline: none;
        font-family: inherit;
      }

      .dsh-dbimg-textarea:focus {
        border-color: var(--db-accent);
        box-shadow: 0 0 0 2px var(--db-accent-soft);
      }

      .dsh-dbimg-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
      }

      .dsh-dbimg-row-label {
        font-size: 11.5px;
        color: var(--db-text-dim);
        margin-right: 3px;
        font-weight: 500;
      }

      .dsh-dbimg-chip {
        border: 1px solid var(--db-line);
        background: transparent;
        color: inherit;
        font-size: 11.5px;
        padding: 2.5px 9px;
        border-radius: 999px;
        cursor: pointer;
        transition: all 0.14s ease;
      }

      .dsh-dbimg-chip:hover {
        border-color: var(--db-accent-line);
        color: var(--db-accent);
      }

      .dsh-dbimg-chip.active {
        background: var(--db-accent);
        color: var(--db-accent-ink);
        border-color: var(--db-accent);
        font-weight: 600;
      }

      .dsh-dbimg-footer {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 2px;
      }

      .dsh-dbimg-primary-btn {
        background: var(--db-accent);
        color: var(--db-accent-ink);
        border: none;
        border-radius: 8px;
        padding: 6px 14px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition: background 0.15s ease;
      }

      .dsh-dbimg-primary-btn:hover:not(:disabled) {
        background: var(--db-accent-strong);
      }

      .dsh-dbimg-primary-btn.waiting {
        background: var(--db-accent-soft);
        color: var(--db-text-dim);
        font-weight: 500;
      }

      .dsh-dbimg-primary-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .dsh-dbimg-status {
        font-size: 12px;
        padding: 7px 10px;
        border-radius: 8px;
        background: var(--db-accent-soft);
        border: 1px solid var(--db-accent-line);
        color: var(--db-text);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .dsh-dbimg-status.warn {
        background: var(--db-warn-soft);
        border-color: var(--db-warn-line);
        color: var(--db-warn);
      }

      .dsh-dbimg-groups {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .dsh-dbimg-group {
        border: 1px solid var(--db-line-soft);
        border-radius: 14px;
        padding: 6px 8px;
        background: var(--db-wash);
      }

      .dsh-dbimg-group.current {
        border-color: var(--db-accent-line);
        background: var(--db-accent-soft);
      }

      .dsh-dbimg-group-head {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 2px 0;
      }

      .dsh-dbimg-group-toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1;
        min-width: 0;
        padding: 0;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
      }

      .dsh-dbimg-group-clear {
        flex: none;
        padding: 1px 6px;
        border: none;
        border-radius: 999px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 11px;
        color: var(--db-text-dim);
        cursor: pointer;
      }

      .dsh-dbimg-group-clear:hover {
        opacity: 1;
        color: var(--db-warn);
        background: var(--db-warn-soft);
      }

      .dsh-dbimg-group-chevron {
        width: 12px;
        height: 12px;
        color: var(--db-text-dim);
        flex: none;
        display: block;
      }

      .dsh-dbimg-group-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 600;
      }

      .dsh-dbimg-group-tag {
        flex: none;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--db-accent-soft);
        color: var(--db-accent);
        font-size: 10.5px;
      }

      .dsh-dbimg-group-count {
        margin-left: auto;
        flex: none;
        font-size: 11px;
        color: var(--db-text-dim);
      }

      .dsh-dbimg-gallery {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
        gap: 8px;
        margin-top: 6px;
        max-height: 320px;
        overflow-y: auto;
      }

      .dsh-dbimg-card {
        position: relative;
        border-radius: 9px;
        overflow: hidden;
        border: 1px solid rgba(15, 23, 42, 0.12);
        background: rgba(15, 23, 42, 0.03);
        display: flex;
        flex-direction: column;
      }

      .dsh-dbimg-card img {
        width: 100%;
        height: 92px;
        object-fit: cover;
        display: block;
      }

      /* 「引用路径」浮在图的右下角，不占卡片高度（与设计稿的 .card-act 同构） */
      .dsh-dbimg-card-bar {
        position: absolute;
        right: 5px;
        bottom: 5px;
        display: flex;
        align-items: center;
        gap: 4px;
        opacity: 0;
        transition: opacity 0.12s;
      }

      .dsh-dbimg-card:hover .dsh-dbimg-card-bar,
      .dsh-dbimg-card:focus-within .dsh-dbimg-card-bar {
        opacity: 1;
      }

      @media (hover: none) {
        .dsh-dbimg-card-bar {
          opacity: 1;
        }
      }

      .dsh-dbimg-card-bar .dsh-dbimg-mini-btn,
      .dsh-dbimg-card-bar .dsh-dbimg-mini-btn:hover {
        border-color: transparent;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
        font-size: 10.5px;
        padding: 2px 7px;
        border-radius: 6px;
        opacity: 1;
      }

      /* 删除是图片右上角独立的「×」角标，显隐与「引用路径」同源（悬停/键盘焦点才出现）。 */
      .dsh-dbimg-card-close {
        position: absolute;
        top: 5px;
        right: 5px;
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 50%;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
        font-size: 13px;
        line-height: 1;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.12s, background 0.12s;
      }

      .dsh-dbimg-card:hover .dsh-dbimg-card-close,
      .dsh-dbimg-card:focus-within .dsh-dbimg-card-close {
        opacity: 1;
      }

      .dsh-dbimg-card-close:hover {
        border-color: transparent;
        background: var(--db-warn);
        color: #ffffff;
      }

      @media (hover: none) {
        .dsh-dbimg-card-close {
          opacity: 1;
        }
      }

      /* 预览灯箱：铺满可视区、按窗口等比缩放；颜色一律走 --db-* 槽位。 */
      .dsh-dbimg-preview-mask {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 20px;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
      }

      .dsh-dbimg-preview-close {
        position: absolute;
        top: 14px;
        right: 16px;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 50%;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }

      .dsh-dbimg-preview-close:hover,
      .dsh-dbimg-preview-nav:hover:not(:disabled) {
        background: var(--db-warn);
      }

      .dsh-dbimg-preview-stage {
        flex: 1 1 auto;
        min-height: 0;
        display: grid;
        grid-template-columns: 44px minmax(0, 1fr) 44px;
        grid-template-rows: minmax(0, 1fr);
        align-items: center;
        gap: 10px;
      }

      .dsh-dbimg-preview-img {
        justify-self: center;
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
        border-radius: 10px;
      }

      .dsh-dbimg-preview-nav {
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 50%;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }

      .dsh-dbimg-preview-nav:disabled {
        opacity: 0.3;
        cursor: default;
      }

      .dsh-dbimg-preview-info {
        flex: none;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .dsh-dbimg-preview-text {
        min-width: 0;
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .dsh-dbimg-preview-prompt {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 13px;
      }

      .dsh-dbimg-preview-meta {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-size: 11.5px;
        opacity: 0.75;
      }

      .dsh-dbimg-preview-actions {
        flex: none;
        display: flex;
        gap: 6px;
      }

      .dsh-dbimg-preview-actions .dsh-dbimg-mini-btn {
        border-color: transparent;
        background: var(--db-overlay);
        color: var(--db-overlay-ink);
      }

      .dsh-dbimg-cmd {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
        border: 1px solid var(--dsw-alias-line-subtle, #e5e7eb);
        border-radius: var(--dsw-radius-panel, 12px);
        background: var(--dsw-alias-bg-layer, #ffffff);
        font-size: 13px;
      }

      .dsh-dbimg-cmd.failed {
        border-color: var(--dsw-alias-state-error, #ef4444);
      }

      .dsh-dbimg-cmd-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .dsh-dbimg-cmd-title {
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #111827);
      }

      .dsh-dbimg-cmd-status {
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, #6b7280);
      }

      .dsh-dbimg-cmd-text {
        margin: 0;
        font-family: inherit;
        font-size: 12px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--dsw-alias-label-secondary, #4b5563);
      }

      .dsh-dbimg-cmd-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
        gap: 8px;
      }

      .dsh-dbimg-cmd-fig {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .dsh-dbimg-cmd-fig img {
        width: 100%;
        border-radius: 8px;
        display: block;
        background: var(--dsw-alias-bg-subtle, #f3f4f6);
      }

      .dsh-dbimg-cmd-fig figcaption {
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, #6b7280);
        word-break: break-all;
      }

      /* 工具图卡：图片独立成块，详细信息默认折叠 */
      .dsh-dbimg-tool {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--dsw-alias-border-weak, #e5e7eb);
        background: var(--dsw-alias-bg-subtle, #f9fafb);
      }

      .dsh-dbimg-tool.failed {
        border-color: var(--dsw-alias-state-error, #dc2626);
      }

      .dsh-dbimg-tool-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .dsh-dbimg-tool-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #111827);
      }

      .dsh-dbimg-tool-status {
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #6b7280);
      }

      .dsh-dbimg-tool-prompt {
        font-size: 12px;
        line-height: 1.55;
        color: var(--dsw-alias-label-secondary, #4b5563);
      }

            .dsh-dbimg-tool-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 8px;
      }

            .dsh-dbimg-tool-fig {
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

            .dsh-dbimg-tool-fig img {
        width: 100%;
        border-radius: 8px;
        display: block;
        background: var(--dsw-alias-bg-subtle, #f3f4f6);
      }

      .dsh-dbimg-tool-fig figcaption {
        font-size: 11px;
        color: var(--dsw-alias-label-secondary, #6b7280);
        word-break: break-all;
      }

      .dsh-dbimg-tool-details summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #6b7280);
      }

      .dsh-dbimg-tool-pre {
        margin: 6px 0 0;
        max-height: 320px;
        overflow: auto;
        font-size: 11px;
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--dsw-alias-label-secondary, #4b5563);
      }
    `;
    document.head.appendChild(style);
  }

  function createFallbackSnapshotStore(initialState) {
    let state = initialState;
    const listeners = new Set();
    const set = (next) => {
      if (Object.is(next, state)) return state;
      state = next;
      for (const listener of [...listeners]) {
        listener();
      }
      return state;
    };
    return {
      getSnapshot: () => state,
      set,
      setState(updater) {
        const next = typeof updater === "function" ? updater(state) : updater;
        return set(next);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  /* 状态条只停留 15 秒：错误与告警长期挂着会误导用户以为当前仍在报错。 */
  const STATUS_TTL_MS = 15000;

  function createDoubaoStudioStore(createSnapshotStoreFn = createFallbackSnapshotStore, timers = {}) {
    const store = (createSnapshotStoreFn || createFallbackSnapshotStore)({
      expanded: false,
      prompt: "",
      aspectRatio: "16:9",
      style: "auto",
      loading: false,
      statusMessage: "",
      statusKind: "info",
      loginRequired: false,
      history: [],
      // 按工作区聚合的 history（服务端 /doubao-paint/status 的 groups）
      groups: [],
      workspace: "",
      // 折叠状态：key=工作区绝对路径；未记录时当前组默认展开、其他组默认折叠
      collapsedGroups: {},
    });

    const update = (recipe) => {
      const prev = store.getSnapshot();
      const next = typeof recipe === "function" ? recipe(prev) : recipe;
      if (Object.is(next, prev)) return prev;
      if (typeof store.set === "function") {
        store.set(next);
      } else if (typeof store.setState === "function") {
        store.setState(next);
      }
      return store.getSnapshot();
    };

    /* 定时器可能不存在（离线测试的 vm 沙箱、部分宿主注入环境），取值必须全程 typeof 守卫。 */
    /* 注入的 timers 只当覆盖用：缺 setTimeout 时必须继续回落 globalThis，
       否则默认参数 `{}` 会把真宿主的计时器挡掉，导致提示永不收回。 */
    const hostTimers =
      timers && typeof timers.setTimeout === "function"
        ? timers
        : typeof globalThis !== "undefined" && globalThis
          ? globalThis
          : {};
    const setTimer = typeof hostTimers.setTimeout === "function" ? hostTimers.setTimeout.bind(hostTimers) : null;
    const clearTimer =
      typeof hostTimers.clearTimeout === "function" ? hostTimers.clearTimeout.bind(hostTimers) : null;
    let statusTimer = null;
    const clearStatusTimer = () => {
      if (statusTimer === null) return;
      try {
        if (typeof clearTimer === "function") clearTimer(statusTimer);
      } catch (_err) {
        // 计时器已被环境清理，忽略
      }
      statusTimer = null;
    };
    /* 任何错误/告警/成功提示都只保留 STATUS_TTL_MS 秒，然后自动收回。 */
    const scheduleStatusClear = () => {
      clearStatusTimer();
      if (typeof setTimer !== "function") return;
      statusTimer = setTimer(() => {
        statusTimer = null;
        const current = store.getSnapshot();
        if (!current.statusMessage) return;
        update({ ...current, statusMessage: "", loginRequired: false });
      }, STATUS_TTL_MS);
    };

    return {
      getSnapshot: () => store.getSnapshot(),
      subscribe: (listener) => store.subscribe(listener),
      toggleExpanded() {
        return update((s) => ({ ...s, expanded: !s.expanded }));
      },
      setExpanded(val) {
        return update((s) => ({ ...s, expanded: Boolean(val) }));
      },
      setPrompt(prompt) {
        return update((s) => ({ ...s, prompt: String(prompt ?? "") }));
      },
      setAspectRatio(aspectRatio) {
        return update((s) => ({ ...s, aspectRatio: String(aspectRatio || "16:9") }));
      },
      setStyle(style) {
        return update((s) => ({ ...s, style: String(style || "auto") }));
      },
      setLoading(loading, statusMessage = "", statusKind = "info") {
        const next = update((s) => ({
          ...s,
          loading: Boolean(loading),
          statusMessage,
          statusKind,
        }));
        // 进行中的状态条随 loading 一起存在，结束后才需要自动收回。
        if (!loading && statusMessage) scheduleStatusClear();
        else if (loading) clearStatusTimer();
        return next;
      },
      setLoginRequired(loginRequired, statusMessage = "") {
        const next = update((s) => ({
          ...s,
          loading: false,
          loginRequired: Boolean(loginRequired),
          statusMessage,
          statusKind: loginRequired ? "warn" : "info",
        }));
        if (statusMessage) scheduleStatusClear();
        return next;
      },
      setHistory(history) {
        return update((s) => ({
          ...s,
          history: Array.isArray(history) ? history : [],
        }));
      },
      /**
       * 写入按工作区聚合的分组。`workspace` 为当前会话的工作区绝对路径（可为空）。
       * 老服务端不带 groups 时回退为「全部记录一个未标记分组」，保证面板仍可用。
       */
      setGroups(groups, workspace) {
        return update((s) => {
          const list = Array.isArray(groups) ? groups : [];
          return {
            ...s,
            groups: list,
            workspace: typeof workspace === "string" ? workspace : "",
            history: list.reduce((acc, group) => {
              if (group && Array.isArray(group.images)) acc.push(...group.images);
              return acc;
            }, []),
          };
        });
      },
      toggleGroup(key) {
        return update((s) => {
          const normalized = typeof key === "string" ? key : "";
          if (!normalized) return s;
          return {
            ...s,
            collapsedGroups: {
              ...s.collapsedGroups,
              [normalized]: !s.collapsedGroups[normalized],
            },
          };
        });
      },
    };
  }

  const LOCALE_STRINGS = {
    zh: {
      studioTitle: "豆包生图",
      chipLabel: "豆包生图",
      expandHint: "展开豆包生图",
      collapseHint: "收起豆包生图",
      triggerLabel: "🎨 豆包生图",
      genBtn: "生成",
      waitBtn: "生成中…",
      promptRequired: "请先输入生图画面描述词（Prompt）",
      genRunning: "生图中…（约 15~40 秒）",
      genSuccess: "已生成 {count} 张图片",
      genPartial: "部分失败：{ok} 张成功、{bad} 张失败",
      requestError: "请求异常：{message}",
      historyClear: "清除",
      historyClearConfirm: "删除「{label}」的 {count} 张图（含本地文件）？",
      historyCleared: "已清除 {count} 张",
      removeImage: "删除",
      removeImageConfirm: "删除这张图片「{name}」？会同时删除本地文件，且不可恢复。",
      removeImageDone: "已删除该图片（含本地文件）",
      removeImageFailed: "删除失败，请刷新后重试。",
      removeImageMissing: "这条记录没有可用路径，无法删除。",
      previewClose: "关闭预览",
      previewPrev: "上一张",
      previewNext: "下一张",
      previewInfo: "{size} · {name}",
      previewPromptEmpty: "（无提示词）",
      cmdDirectHint: "直出模式：/doubao-paint-direct 不经模型、零模型回合。",
      imgRunning: "生图中…",
      imgDone: "已生图",
      imgFailed: "生图失败",
      imgDetails: "详细信息",
      imgNoImage: "这次没有图片产出。",
      err_login_required: "豆包网页版尚未登录，请先在浏览器里完成扫码或手机号登录后重试。",
      err_no_image: "等待超时：豆包页面未在规定时间内产出符合条件的高清图。",
      err_partial: "部分图片下载失败，已成功落盘的文件保留在输出目录。",
      err_download_failed: "全部图片下载失败，未能落盘任何文件。",
      err_busy: "已有一次生图任务在运行，请稍后重试。",
      err_cancelled: "任务被取消。",
      err_cli_missing: "未找到可用的浏览器 CLI（ego-browser 或 chrome-devtools）。",
      err_backend_unavailable: "所选浏览器后端不可用，且没有可回落的后端。",
      err_contract_changed: "豆包网页结构疑似改版，关键选择器未命中；请升级插件。",
      err_rate_limited: "豆包返回了限流或需要人工验证的页面，请稍后重试。",
      err_unknown: "生图未完成，请检查浏览器里的豆包标签页。",
      historyAllRecords: "全部记录",
      historyCurrentTag: "当前工作区",
      historyCount: "{count} 张",
    },
    en: {
      studioTitle: "Doubao Image",
      chipLabel: "Doubao Image",
      expandHint: "Expand the Doubao Image panel",
      collapseHint: "Collapse the Doubao Image panel",
      triggerLabel: "🎨 Doubao Image",
      genBtn: "Generate",
      waitBtn: "Generating…",
      promptRequired: "Enter an image prompt first.",
      genRunning: "Generating… (about 15–40s)",
      genSuccess: "Generated {count} image(s)",
      genPartial: "Partially done: {ok} saved, {bad} failed",
      requestError: "Request failed: {message}",
      historyClear: "Clear",
      historyClearConfirm: "Delete {count} image(s) of \"{label}\" including local files?",
      historyCleared: "Cleared {count} image(s)",
      removeImage: "Delete",
      removeImageConfirm: "Delete this image \"{name}\"? Its local file is deleted too and this cannot be undone.",
      removeImageDone: "Image deleted (local file removed)",
      removeImageFailed: "Delete failed. Please refresh and retry.",
      removeImageMissing: "This record has no usable path, so it cannot be deleted.",
      previewClose: "Close preview",
      previewPrev: "Previous image",
      previewNext: "Next image",
      previewInfo: "{size} · {name}",
      previewPromptEmpty: "(no prompt)",
      cmdDirectHint: "Direct mode: /doubao-paint-direct runs without the model.",
      imgRunning: "Generating…",
      imgDone: "Generated",
      imgFailed: "Generation failed",
      imgDetails: "Details",
      imgNoImage: "No image was produced this time.",
      err_login_required: "Doubao Web is not signed in. Scan the QR code or sign in, then retry.",
      err_no_image: "Timed out: Doubao did not produce a qualifying image in time.",
      err_partial: "Some images failed to download; saved files remain in the output directory.",
      err_download_failed: "All image downloads failed; nothing was saved.",
      err_busy: "Another generation is already running. Please retry later.",
      err_cancelled: "The task was cancelled.",
      err_cli_missing: "No usable browser CLI found (ego-browser or chrome-devtools).",
      err_backend_unavailable: "The selected browser backend is unavailable and there is no fallback.",
      err_contract_changed: "Doubao page structure looks changed; key selectors were not found. Please upgrade the plugin.",
      err_rate_limited: "Doubao returned a rate-limit or human-verification page. Please retry later.",
      err_unknown: "Generation did not finish; check the Doubao tab in the browser.",
      historyAllRecords: "All records",
      historyCurrentTag: "Current workspace",
      historyCount: "{count} image(s)",
    },
  };

  /** 当前语言：宿主 locale 服务能给出就用它，否则回落 zh（不抛错）。 */
  function currentLang(ctx) {
    try {
      const direct = typeof ctx?.locale?.current === "function" ? ctx.locale.current() : null;
      const value = typeof direct === "string" ? direct : ctx?.locale?.lang || ctx?.lang;
      if (typeof value === "string" && value.toLowerCase().startsWith("en")) return "en";
    } catch (_err) {
      /* 拿不到就按中文 */
    }
    return "zh";
  }

  /** 取文案并替换 `{name}` 占位符；缺键回落中文表，再缺回落键名。 */
  function t(ctx, key, vars) {
    const lang = currentLang(ctx);
    const table = LOCALE_STRINGS[lang] || LOCALE_STRINGS.zh;
    let text = table[key] != null ? table[key] : LOCALE_STRINGS.zh[key];
    if (text == null) return key;
    if (vars && typeof vars === "object") {
      for (const [name, value] of Object.entries(vars)) {
        text = text.split(`{${name}}`).join(String(value));
      }
    }
    return text;
  }

  /** 按错误码取本地化失败文案。 */
  function errorText(ctx, code, fallbackMessage) {
    const key = code ? `err_${code}` : "";
    const lang = currentLang(ctx);
    const table = LOCALE_STRINGS[lang] || LOCALE_STRINGS.zh;
    if (key && table[key]) return table[key];
    if (key && LOCALE_STRINGS.zh[key]) return LOCALE_STRINGS.zh[key];
    return fallbackMessage || t(ctx, "err_unknown");
  }

  const CONFIG_LOCALE_STRINGS = {
    zh: {
      _title: "豆包生图",
      _description:
        "操控豆包网页版（doubao.com）进行 AI 图像生成：注册 doubao_generate_image 原生工具，优先用本机 ego lite（复用已登录 Profile）、不可用时回落 Chrome + chrome-devtools-mcp，自动提交提示词、选择比例与风格、下载高清原图并注入对话附件，同时在输入框工具行提供触发条与展开面板。",
      enabled: {
        _title: "启用豆包生图插件",
        _description: "开启后将注册 doubao_generate_image / doubao_image_status 工具，并在对话输入框工具行挂载「豆包生图」触发条。",
      },
      browserBackend: {
        _title: "浏览器后端",
        _description: "auto（默认）：探测到 ego lite 就用 ego，否则回落 Chrome；ego：强制 ego lite（复用已登录 Profile，免扫码）；chrome：强制 chrome-devtools-mcp + 独立 Chrome profile（需一次扫码）。",
      },
      egoCliPath: {
        _title: "ego lite 可执行文件路径",
        _description: "留空则自动扫描 ego lite 版本目录并取最高版本（也可用环境变量 DSH_EGO_CLI_PATH 覆盖）。",
      },
      chromeCliPath: {
        _title: "chrome-devtools CLI 可执行文件路径",
        _description: "用于操控 Chrome 的 chrome-devtools CLI 路径（留空则按平台自动解析 npm 全局目录 / PATH）。",
      },
      doubaoUrl: {
        _title: "豆包网页版入口地址",
        _description: "默认访问的豆包对话与生图页面 URL（默认 https://www.doubao.com/chat/）。",
      },
      defaultAspectRatio: {
        _title: "默认画面比例",
        _description: "未显式指定比例时默认使用的生图画面比例（如 1:1、16:9、9:16、4:3、3:4）。",
      },
      defaultStyle: {
        _title: "默认视觉风格预设",
        _description: "未显式指定风格时附加的默认视觉风格（留空或 auto 表示由提示词自行决定）。",
      },
      outputDir: {
        _title: "高清原图本地保存目录",
        _description: "豆包生成图片下载后的本地保存目录，默认为 ~/.dsh/dsh-doubao-paint/images；写成相对路径时基于当前工作区解析。",
      },
      timeoutMs: {
        _title: "单次生图等待超时时间 (ms)",
        _description: "等待豆包网页完成图像生成与高清原图下载的最大毫秒数（默认 120000，范围 30000~180000）。",
      },
      keepTab: {
        _title: "生图完成后保留豆包标签页",
        _description: "开启后在生图结束时保留浏览器中的豆包标签页，便于连续追问改图或复用会话。",
      },
      injectSystemPrompt: {
        _title: "向 System Prompt 注入生图工具指引",
        _description: "开启后向 Agent 系统提示词注入豆包生图工具使用说明，使模型在收到画图请求时优先自动调用。",
      },
    },
    en: {
      _title: "Doubao Paint Studio",
      _description:
        "Automate Doubao Web (doubao.com) for AI image generation: registers doubao_generate_image, prefers the local ego lite browser (reusing the signed-in profile) and falls back to Chrome + chrome-devtools-mcp; submits the prompt, picks aspect ratio and style, downloads lossless images into multimodal chat attachments, and adds a trigger chip on the composer tool row plus an expandable panel.",
      enabled: {
        _title: "Enable Doubao Paint Plugin",
        _description: "Registers doubao_generate_image / doubao_image_status tools and mounts the Doubao Image trigger chip on the composer tool row.",
      },
      browserBackend: {
        _title: "Browser Backend",
        _description: "auto (default): use ego lite when detected, otherwise fall back to Chrome; ego: force ego lite (signed-in profile, no QR scan); chrome: force chrome-devtools-mcp with a dedicated Chrome profile (one QR scan).",
      },
      egoCliPath: {
        _title: "ego lite Executable Path",
        _description: "Leave empty to auto-detect the newest ego lite version directory (override with the DSH_EGO_CLI_PATH env var).",
      },
      chromeCliPath: {
        _title: "chrome-devtools CLI Path",
        _description: "Path to the chrome-devtools CLI (leave empty to auto-resolve the npm global directory or PATH).",
      },
      doubaoUrl: {
        _title: "Doubao Web Entry URL",
        _description: "Target Doubao Web chat URL used for image generation (defaults to https://www.doubao.com/chat/).",
      },
      defaultAspectRatio: {
        _title: "Default Aspect Ratio",
        _description: "Default aspect ratio when none is specified in the tool call (1:1, 16:9, 9:16, 4:3, 3:4).",
      },
      defaultStyle: {
        _title: "Default Visual Style Preset",
        _description: "Default visual style appended when none is specified (leave empty or 'auto' for prompt-driven style).",
      },
      outputDir: {
        _title: "Local Output Directory",
        _description: "Directory where downloaded high-resolution Doubao images are saved. Defaults to ~/.dsh/dsh-doubao-paint/images; a relative path resolves against the workspace.",
      },
      timeoutMs: {
        _title: "Generation Timeout (ms)",
        _description: "Maximum time in milliseconds to wait for Doubao Web image generation and download (default 120000, range 30000–180000).",
      },
      keepTab: {
        _title: "Keep Doubao Tab Open After Generation",
        _description: "When enabled, retains the Doubao browser tab after generation for follow-up edits and session reuse.",
      },
      injectSystemPrompt: {
        _title: "Inject System Prompt Guidance",
        _description: "Injects usage guidance into the Agent system prompt so the model automatically invokes doubao_generate_image when asked to draw.",
      },
    },
  };

  function buildModule(require) {
    const React = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const storePkg = (() => {
      try {
        return require("@deepseek-ai/dsh-client-store");
      } catch (_err) {
        return {};
      }
    })();

    const createSnapshotStore = storePkg.createSnapshotStore || createFallbackSnapshotStore;
    const useStore =
      storePkg.useStore ||
      ((store, selector = (s) => s) =>
        React.useSyncExternalStore(
          store.subscribe,
          () => selector(store.getSnapshot()),
          () => selector(store.getSnapshot())
        ));

    const sessionStores = new Map();
    function getSessionStore(sessionId) {
      const key = String(sessionId || "__default__");
      let store = sessionStores.get(key);
      if (!store) {
        store = createDoubaoStudioStore(createSnapshotStore);
        sessionStores.set(key, store);
      }
      return store;
    }

    function createDoubaoStudioDockComponent(ctx) {
      return function DoubaoStudioDock({ sessionId, session, inputActions: inputActionsProp }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const state = useStore(store, (s) => s);
        // 会话工作区：dock slot 下发的 session 是 SessionSnapshot（只有 sessionId/pending 等字段，
        // 不含 cwd），因此本地取不到工作区；真正的归属由服务端按 sessionId 反查会话 header.cwd 决定
        // （见 lib/index.js resolveRequestWorkspace）。这里保留本地探测，只作为请求参数的辅助。
        const workspace = React.useMemo(() => workspaceOfSession(session), [session]);
        const inputActions = resolveInputActions(ctx, sessionId, inputActionsProp);
        const collapsedGroups = state.collapsedGroups || {};

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        /* 历史刷新：展开时拉一次，之后每次「本轮生图结束」的事件再拉一次（不轮询）。 */
        const refreshHistory = React.useCallback(() => {
          let cancelled = false;
          const params = new URLSearchParams();
          if (workspace) params.set("workspace", workspace);
          if (sessionId) params.set("sessionId", sessionId);
          const query = params.toString() ? `?${params.toString()}` : "";
          fetch(`/doubao-paint/status${query}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (cancelled || !data) return;
              const groups = normalizeHistoryGroups(data, workspace || data.workspace || "");
              store.setGroups(groups, workspace || data.workspace || "");
            })
            .catch(() => {});
          return () => {
            cancelled = true;
          };
        }, [store, workspace]);

        React.useEffect(() => {
          if (!state.expanded) return undefined;
          return refreshHistory();
        }, [state.expanded, refreshHistory]);

        React.useEffect(() => {
          const onGenerated = () => {
            refreshHistory();
          };
          window.addEventListener(GENERATED_EVENT, onGenerated);
          return () => {
            window.removeEventListener(GENERATED_EVENT, onGenerated);
          };
        }, [refreshHistory]);

        /* 引用图片路径：优先插进输入框；输入框拿不到 actions 时退化为复制到剪贴板。 */
        const handleQuotePath = (item) => {
          const filePath = item?.filePath ? String(item.filePath) : "";
          if (!filePath) {
            store.setLoading(false, "这条记录没有可用路径。", "warn");
            return;
          }
          if (insertIntoComposerDraft(ctx, sessionId, `@${filePath} `, inputActions)) {
            /* 成功不提示：输入框里已经能看到内容。 */
            return;
          }
          const snippet = `@${filePath} `;
          const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
          if (clipboard && typeof clipboard.writeText === "function") {
            clipboard.writeText(snippet).then(
              () => store.setLoading(false, "已复制路径", "info"),
              () => store.setLoading(false, snippet.trim(), "warn")
            );
            return;
          }
          store.setLoading(false, snippet.trim(), "warn");
        };

        /* 清除某个工作区的记录与本地图片：确认后一次性完成，不清则不动。 */
        const handleClearGroup = (group) => {
          const key = String(group?.key || "");
          const images = Array.isArray(group?.images) ? group.images : [];
          const total = Number(group?.count) > images.length ? Number(group.count) : images.length;
          const label = group?.label || t(ctx, "historyAllRecords");
          const canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
          if (canConfirm && !window.confirm(t(ctx, "historyClearConfirm", { label, count: total }))) {
            return;
          }
          fetch("/doubao-paint/clear", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ workspace: key }),
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!data) {
                store.setLoading(false, t(ctx, "requestError"), "warn");
                return;
              }
              store.setGroups(
                normalizeHistoryGroups(data, workspace || data.workspace || ""),
                workspace || data.workspace || ""
              );
              store.setLoading(false, t(ctx, "historyCleared", { count: Number(data.removed) || 0 }), "info");
            })
            .catch(() => store.setLoading(false, t(ctx, "requestError"), "warn"));
        };

        /* 关闭单张图片：确认后删记录 + 删本地文件，并用响应里的分组立即刷新面板。 */
        const handleRemoveImage = (item) => {
          const filePath = item?.filePath ? String(item.filePath) : "";
          const id = item?.filename
            ? String(item.filename)
            : item?.attachment?.attachmentId
              ? String(item.attachment.attachmentId)
              : "";
          if (!filePath && !id) {
            store.setLoading(false, t(ctx, "removeImageMissing"), "warn");
            return;
          }
          const name = String(item?.filename || item?.prompt || "").trim();
          const canConfirm = typeof window !== "undefined" && typeof window.confirm === "function";
          if (canConfirm && !window.confirm(t(ctx, "removeImageConfirm", { name }))) {
            return;
          }
          const applyGroups = (data) => {
            if (data && Array.isArray(data.groups)) {
              store.setGroups(
                normalizeHistoryGroups(data, workspace || data.workspace || ""),
                workspace || data.workspace || ""
              );
              return;
            }
            refreshHistory();
          };
          fetch("/doubao-paint/clear", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ filePath, id, currentWorkspace: String(workspace || "") }),
          })
            .then((resp) => resp.json().catch(() => ({})).then((data) => ({ resp, data })))
            .then(({ resp, data }) => {
              // 记录已被别处删掉（404）时也用服务端的新分组刷新，面板不停留在旧列表。
              applyGroups(data);
              if (!resp.ok || !data || data.ok !== true) {
                store.setLoading(false, t(ctx, "removeImageFailed"), "warn");
                return;
              }
              store.setLoading(false, t(ctx, "removeImageDone"), "info");
            })
            .catch(() => {
              refreshHistory();
              store.setLoading(false, t(ctx, "removeImageFailed"), "warn");
            });
        };

        /* ── 预览（灯箱） ──────────────────────────────────────────────
         * 状态只记「哪一组 + 组内第几张」，渲染时从当前 groups 里取图：
         * 删除后 groups 刷新，预览自动指向同组的下一条；组被清空则自动关闭。 */
        const [preview, setPreview] = React.useState({ open: false, groupKey: "", index: 0 });
        const [previewSize, setPreviewSize] = React.useState({ src: "", text: "" });

        const handleOpenPreview = (groupKey, index) => {
          setPreview({
            open: true,
            groupKey: String(groupKey == null ? "" : groupKey),
            index: Number(index) || 0,
          });
        };
        const handleClosePreview = () => {
          setPreview((prev) => (prev.open ? { open: false, groupKey: "", index: 0 } : prev));
        };
        const handlePreviewStep = (delta) => {
          setPreview((prev) => {
            if (!prev.open) return prev;
            const group = (state.groups || []).find((g) => String(g.key || "") === prev.groupKey);
            const list = group && Array.isArray(group.images) ? group.images : [];
            if (list.length === 0) return { open: false, groupKey: "", index: 0 };
            const current = Math.max(0, Math.min(prev.index, list.length - 1));
            const next = Math.max(0, Math.min(current + (Number(delta) || 0), list.length - 1));
            return { open: true, groupKey: prev.groupKey, index: next };
          });
        };

        const previewGroup = preview.open
          ? (state.groups || []).find((g) => String(g.key || "") === preview.groupKey)
          : null;
        const previewImages = previewGroup && Array.isArray(previewGroup.images) ? previewGroup.images : [];
        const previewIndex = Math.max(0, Math.min(preview.index, previewImages.length - 1));
        const previewItem = preview.open && previewImages.length > 0 ? previewImages[previewIndex] : null;
        const previewOpen = Boolean(previewItem);
        const previewPrompt = previewItem ? String(previewItem.prompt || "").trim() : "";
        const previewName = previewItem ? String(previewItem.filename || "").trim() : "";
        const previewSrc = previewItem && previewItem.previewUrl ? String(previewItem.previewUrl) : "";
        const previewDims =
          previewItem && previewItem.width && previewItem.height
            ? `${previewItem.width}×${previewItem.height}`
            : previewSize.src && previewSize.src === previewSrc
              ? previewSize.text
              : "";
        const previewInfoText =
          previewDims || previewName
            ? t(ctx, "previewInfo", { size: previewDims || "—", name: previewName || "—" })
            : "";

        /* 键盘监听只在预览打开期间挂载，关闭立即解绑（不常驻）。 */
        React.useEffect(() => {
          if (!previewOpen) return undefined;
          if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
            return undefined;
          }
          const onKeyDown = (event) => {
            const key = event && typeof event.key === "string" ? event.key : "";
            if (key !== "Escape" && key !== "ArrowLeft" && key !== "ArrowRight") return;
            if (typeof event.preventDefault === "function") event.preventDefault();
            if (key === "Escape") {
              handleClosePreview();
              return;
            }
            handlePreviewStep(key === "ArrowLeft" ? -1 : 1);
          };
          window.addEventListener("keydown", onKeyDown);
          return () => window.removeEventListener("keydown", onKeyDown);
        }, [previewOpen, preview.groupKey, preview.index, state.groups]);

        /* 目标图片被删/组被清空后，收起状态避免下次打开指向不存在的下标。 */
        React.useEffect(() => {
          if (preview.open && !previewItem) handleClosePreview();
        }, [preview.open, previewItem]);

        const handleDirectGenerate = async () => {
          const cleaned = (state.prompt || "").trim();
          if (!cleaned) {
            store.setLoading(false, t(ctx, "promptRequired"), "warn");
            return;
          }
          store.setLoading(true, t(ctx, "genRunning"), "info");
          try {
            const resp = await fetch("/doubao-paint/generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                prompt: cleaned,
                aspectRatio: state.aspectRatio,
                style: state.style,
                maxImages: 4,
                workspace,
                sessionId,
              }),
            });
            const data = await resp.json().catch(() => ({}));
            const outcome = data.outcome || {};
            const nextGroups = normalizeHistoryGroups(data, workspace || data.workspace || "");
            if (nextGroups.length > 0) {
              store.setGroups(nextGroups, workspace || data.workspace || "");
            }
            if (outcome.status === "login_required") {
              store.setLoginRequired(true, errorText(ctx, outcome.code || "login_required"));
              return;
            }
            if (outcome.status === "partial") {
              const saved = Number(outcome.imageCount || 0) || 0;
              const total = Array.isArray(outcome.images) ? outcome.images.length : saved;
              const bad = Math.max(total - saved, 0);
              store.setLoading(
                false,
                t(ctx, "genPartial", {
                  ok: saved,
                  bad,
                  dir: outcome.outputDir || "images",
                }),
                "warn"
              );
              return;
            }
            if (outcome.status !== "succeeded") {
              store.setLoading(
                false,
                errorText(ctx, outcome.code, outcome.message || data.error),
                "warn"
              );
              return;
            }
            store.setLoginRequired(
              false,
              t(ctx, "genSuccess", {
                count: outcome.imageCount || 0,
                dir: outcome.outputDir || "images",
              })
            );
          } catch (err) {
            store.setLoading(false, t(ctx, "requestError", { message: String(err?.message || err) }), "warn");
          }
        };

        if (!state.expanded) return null;

        return jsxRuntime.jsx("div", {
          className: "dsh-dbimg-dock-wrap",
          "data-dsh-doubao-dock": "expanded",
          children: jsxRuntime.jsxs("div", {
            className: "dsh-dbimg-panel",
            children: [
              jsxRuntime.jsx("textarea", {
                className: "dsh-dbimg-textarea",
                placeholder:
                  "输入你想让豆包生成的画面描述词（例如：一只戴着宇航员头盔的橘猫在月球表面喝咖啡，电影级光影）...",
                value: state.prompt,
                onChange: (e) => store.setPrompt(e.target.value),
              }),
              jsxRuntime.jsxs("div", {
                className: "dsh-dbimg-row",
                children: [
                  jsxRuntime.jsx("span", { className: "dsh-dbimg-row-label", children: "画面比例：" }),
                  ...ASPECT_RATIOS.map((r) =>
                    jsxRuntime.jsx(
                      "button",
                      {
                        type: "button",
                        className: `dsh-dbimg-chip${state.aspectRatio === r.id ? " active" : ""}`,
                        onClick: () => store.setAspectRatio(r.id),
                        children: r.label,
                      },
                      r.id
                    )
                  ),
                ],
              }),
              jsxRuntime.jsxs("div", {
                className: "dsh-dbimg-row",
                children: [
                  jsxRuntime.jsx("span", { className: "dsh-dbimg-row-label", children: "视觉风格：" }),
                  ...STYLE_PRESETS.map((s) =>
                    jsxRuntime.jsx(
                      "button",
                      {
                        type: "button",
                        className: `dsh-dbimg-chip${state.style === s.id ? " active" : ""}`,
                        onClick: () => store.setStyle(s.id),
                        children: s.label,
                      },
                      s.id
                    )
                  ),
                ],
              }),
              jsxRuntime.jsx("div", {
                className: "dsh-dbimg-footer",
                children: jsxRuntime.jsx("button", {
                  type: "button",
                  className: `dsh-dbimg-primary-btn${state.loading ? " waiting" : ""}`,
                  disabled: state.loading,
                  onClick: handleDirectGenerate,
                  children: state.loading ? t(ctx, "waitBtn") : t(ctx, "genBtn"),
                }),
              }),
              state.statusMessage
                ? jsxRuntime.jsxs("div", {
                    className: `dsh-dbimg-status${state.statusKind === "warn" ? " warn" : ""}`,
                    children: [jsxRuntime.jsx("span", { children: state.statusMessage })],
                  })
                : null,
              state.groups && state.groups.length > 0
                ? jsxRuntime.jsx("div", {
                    className: "dsh-dbimg-groups",
                    children: state.groups.map((group, index) => {
                      const key = String(group.key || "");
                      const isCurrent = Boolean(group.current);
                      const collapsed =
                        collapsedGroups[key] === undefined
                          ? state.groups.some((g) => g.current)
                            ? !isCurrent
                            : index !== 0
                          : Boolean(collapsedGroups[key]);
                      const images = Array.isArray(group.images) ? group.images : [];
                      const total = Number(group.count) > images.length ? Number(group.count) : images.length;
                      return jsxRuntime.jsxs(
                        "div",
                        {
                          className: `dsh-dbimg-group${isCurrent ? " current" : ""}`,
                          children: [
                            jsxRuntime.jsxs("div", {
                              className: "dsh-dbimg-group-head",
                              children: [
                                jsxRuntime.jsxs("button", {
                                  type: "button",
                                  className: "dsh-dbimg-group-toggle",
                                  "data-dsh-doubao-group": key,
                                  "aria-expanded": collapsed ? "false" : "true",
                                  onClick: () => store.toggleGroup(key),
                                  children: [
                                    jsxRuntime.jsx("svg", {
                                      viewBox: "0 0 12 12",
                                      "aria-hidden": "true",
                                      focusable: "false",
                                      className: "dsh-dbimg-group-chevron",
                                      children: jsxRuntime.jsx("path", {
                                        d: collapsed ? "M4.2 2 8.2 6 4.2 10" : "M2 4.2 6 8.2 10 4.2",
                                        fill: "none",
                                        stroke: "currentColor",
                                        strokeWidth: 1.6,
                                        strokeLinecap: "round",
                                        strokeLinejoin: "round",
                                      }),
                                    }),
                                    jsxRuntime.jsx("span", {
                                      className: "dsh-dbimg-group-label",
                                      title: key || undefined,
                                      children: group.label || t(ctx, "historyAllRecords"),
                                    }),
                                    isCurrent
                                      ? jsxRuntime.jsx("span", {
                                          className: "dsh-dbimg-group-tag",
                                          children: t(ctx, "historyCurrentTag"),
                                        })
                                      : null,
                                    jsxRuntime.jsx("span", {
                                      className: "dsh-dbimg-group-count",
                                      children: t(ctx, "historyCount", { count: total }),
                                    }),
                                  ],
                                }),
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "dsh-dbimg-group-clear",
                                  "data-dsh-doubao-group-clear": key,
                                  disabled: state.loading,
                                  title: t(ctx, "historyClearConfirm", {
                                    label: group.label || t(ctx, "historyAllRecords"),
                                    count: total,
                                  }),
                                  onClick: () => handleClearGroup(group),
                                  children: t(ctx, "historyClear"),
                                }),
                              ],
                            }),
                            collapsed
                              ? null
                              : jsxRuntime.jsx("div", {
                                  className: "dsh-dbimg-gallery",
                                  children: images.map((item, imageIndex) =>
                                    jsxRuntime.jsxs(
                                      "div",
                                      {
                                        className: "dsh-dbimg-card",
                                        "data-dsh-doubao-open-preview": imageIndex,
                                        onClick: () => handleOpenPreview(key, imageIndex),
                                        children: [
                                          jsxRuntime.jsx("img", {
                                            src: item.previewUrl,
                                            alt: item.prompt || item.filename,
                                            loading: "lazy",
                                          }),
                                          jsxRuntime.jsx("div", {
                                            className: "dsh-dbimg-card-bar",
                                            children: jsxRuntime.jsx("button", {
                                              type: "button",
                                              className: "dsh-dbimg-mini-btn",
                                              onClick: (event) => {
                                                if (event && typeof event.stopPropagation === "function") {
                                                  event.stopPropagation();
                                                }
                                                handleQuotePath(item);
                                              },
                                              children: "引用路径",
                                            }),
                                          }),
                                          jsxRuntime.jsx("button", {
                                            type: "button",
                                            className: "dsh-dbimg-card-close",
                                            "data-dsh-doubao-remove-image":
                                              item.filePath || item.filename || item.id || "",
                                            title: t(ctx, "removeImageConfirm", {
                                              name: String(item.filename || item.prompt || "").trim(),
                                            }),
                                            "aria-label": t(ctx, "removeImage"),
                                            onClick: (event) => {
                                              if (event && typeof event.stopPropagation === "function") {
                                                event.stopPropagation();
                                              }
                                              handleRemoveImage(item);
                                            },
                                            children: "×",
                                          }),
                                        ],
                                      },
                                      item.id || item.filePath
                                    )
                                  ),
                                }),
                          ],
                        },
                        key || group.label
                      );
                    }),
                  })
                : null,
              previewOpen
                ? jsxRuntime.jsxs("div", {
                    className: "dsh-dbimg-preview-mask",
                    role: "dialog",
                    "aria-modal": "true",
                    "aria-label": previewName || t(ctx, "previewClose"),
                    "data-dsh-doubao-preview": preview.groupKey || "1",
                    onClick: (event) => {
                      const target = event && event.target;
                      if (!target || target === (event && event.currentTarget)) {
                        handleClosePreview();
                        return;
                      }
                      // 点大图本身不关闭；其它空白（遮罩 / 舞台 / 信息行）都算「点空白处」
                      const tag = String(target.tagName || "").toUpperCase();
                      if (tag === "BUTTON" || tag === "IMG") return;
                      handleClosePreview();
                    },
                    children: [
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-dbimg-preview-close",
                        "data-dsh-doubao-preview-close": "1",
                        title: t(ctx, "previewClose"),
                        "aria-label": t(ctx, "previewClose"),
                        onClick: (event) => {
                          if (event && typeof event.stopPropagation === "function") {
                            event.stopPropagation();
                          }
                          handleClosePreview();
                        },
                        children: "×",
                      }),
                      jsxRuntime.jsxs("div", {
                        className: "dsh-dbimg-preview-stage",
                        children: [
                          jsxRuntime.jsx("button", {
                            type: "button",
                            className: "dsh-dbimg-preview-nav",
                            "data-dsh-doubao-preview-prev": "1",
                            title: t(ctx, "previewPrev"),
                            "aria-label": t(ctx, "previewPrev"),
                            disabled: previewIndex <= 0,
                            onClick: (event) => {
                              if (event && typeof event.stopPropagation === "function") {
                                event.stopPropagation();
                              }
                              handlePreviewStep(-1);
                            },
                            children: "‹",
                          }),
                          jsxRuntime.jsx("img", {
                            className: "dsh-dbimg-preview-img",
                            src: previewSrc,
                            alt: previewPrompt || previewName || "",
                            onLoad: (event) => {
                              const target = event && (event.currentTarget || event.target);
                              const naturalWidth = target ? Number(target.naturalWidth) : 0;
                              const naturalHeight = target ? Number(target.naturalHeight) : 0;
                              if (naturalWidth > 0 && naturalHeight > 0) {
                                setPreviewSize({
                                  src: previewSrc,
                                  text: `${naturalWidth}×${naturalHeight}`,
                                });
                              }
                            },
                          }),
                          jsxRuntime.jsx("button", {
                            type: "button",
                            className: "dsh-dbimg-preview-nav",
                            "data-dsh-doubao-preview-next": "1",
                            title: t(ctx, "previewNext"),
                            "aria-label": t(ctx, "previewNext"),
                            disabled: previewIndex >= previewImages.length - 1,
                            onClick: (event) => {
                              if (event && typeof event.stopPropagation === "function") {
                                event.stopPropagation();
                              }
                              handlePreviewStep(1);
                            },
                            children: "›",
                          }),
                        ],
                      }),
                      jsxRuntime.jsxs("div", {
                        className: "dsh-dbimg-preview-info",
                        children: [
                          jsxRuntime.jsxs("div", {
                            className: "dsh-dbimg-preview-text",
                            children: [
                              jsxRuntime.jsx("div", {
                                className: "dsh-dbimg-preview-prompt",
                                title: previewPrompt || undefined,
                                children: previewPrompt || t(ctx, "previewPromptEmpty"),
                              }),
                              jsxRuntime.jsx("div", {
                                className: "dsh-dbimg-preview-meta",
                                title: previewName || undefined,
                                children: previewInfoText || "—",
                              }),
                            ],
                          }),
                          jsxRuntime.jsxs("div", {
                            className: "dsh-dbimg-preview-actions",
                            children: [
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "dsh-dbimg-mini-btn",
                                "data-dsh-doubao-preview-remove": "1",
                                title: t(ctx, "removeImageConfirm", { name: previewName }),
                                onClick: (event) => {
                                  if (event && typeof event.stopPropagation === "function") {
                                    event.stopPropagation();
                                  }
                                  handleRemoveImage(previewItem);
                                },
                                children: t(ctx, "removeImage"),
                              }),
                              jsxRuntime.jsx("button", {
                                type: "button",
                                className: "dsh-dbimg-mini-btn",
                                "data-dsh-doubao-preview-quote": "1",
                                onClick: (event) => {
                                  if (event && typeof event.stopPropagation === "function") {
                                    event.stopPropagation();
                                  }
                                  handleQuotePath(previewItem);
                                },
                                children: "引用路径",
                              }),
                            ],
                          }),
                        ],
                      }),
                    ],
                  })
                : null,
            ],
          }),
        });
      };
    }

    // 紧凑触发条：注册在 conversation.input.left，渲染在「工作区内修改」右侧同一行
    const GENERATED_EVENT = "dsh-doubao-paint:generated";

    /**
     * 通知面板「本轮生图已结束」：dock 收到后重新拉 /doubao-paint/status 更新 history。
     * 事件驱动而非轮询（用户 2026-11-07 批注）。
     */
    function emitGenerated(images) {
      try {
        window.dispatchEvent(
          new CustomEvent(GENERATED_EVENT, {
            detail: { images: (Array.isArray(images) ? images : []).map((img) => img.previewUrl || img.filename || "") },
          })
        );
        return true;
      } catch {
        return false;
      }
    }

    function formatBytes(bytes) {
      const size = Number(bytes) || 0;
      if (size <= 0) return "";
      if (size < 1024) return `${size} B`;
      if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
      return `${(size / 1024 / 1024).toFixed(2)} MB`;
    }
    /** 工具结果里的 content blocks → 纯文本。 */
    function collectBlockText(block) {
      const content = block && Array.isArray(block.content) ? block.content : [];
      const parts = [];
      for (const item of content) {
        if (item && item.type === "text" && typeof item.text === "string") parts.push(item.text);
      }
      return parts.join("\n").trim();
    }

    /** 工具结果是 JSON 串；解析失败就当纯文本。 */
    function parseToolPayload(text) {
      if (!text || text[0] !== "{") return null;
      try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }

    /**
     * 工具调用的自定义图卡（conversation.chat.toolview key=doubao_generate_image）。
     * 用户 2026-11-07 批注：工具返回只提供详细信息并自动折叠，图片在会话里单独显示。
     */
    function createDoubaoImageViewComponent(ctx) {
      return function DoubaoImageToolView({ phase, block }) {
        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        const running = phase !== "result";
        const isError = Boolean(block && block.isError);
        const rawText = running ? "" : collectBlockText(block);
        const payload = parseToolPayload(rawText);
        const images = payload && Array.isArray(payload.images) ? payload.images : [];
        const status = payload && typeof payload.status === "string" ? payload.status : "";
        const code = payload && typeof payload.code === "string" ? payload.code : "";
        const failed = !running && (isError || (status && status !== "succeeded" && status !== "partial"));

        const headline = running
          ? t(ctx, "imgRunning")
          : failed
            ? `${t(ctx, "imgFailed")}${code ? `（${code}）` : ""}`
            : images.length > 0
              ? t(ctx, "imgDone")
              : t(ctx, "imgNoImage");

        const detailText = payload ? JSON.stringify(payload, null, 2) : rawText;

        React.useEffect(() => {
          if (running || failed || images.length === 0) return;
          emitGenerated(images);
        }, [running, failed, images.length]);

        const promptLine = payload
          ? String(payload.formattedPrompt || payload.prompt || "").trim()
          : "";

        return jsxRuntime.jsxs("div", {
          className: `dsh-dbimg-tool${failed ? " failed" : ""}${running ? " running" : ""}`,
          "data-dsh-doubao-tool": "1",
          "aria-busy": running,
          children: [
            jsxRuntime.jsxs("div", {
              className: "dsh-dbimg-tool-head",
              children: [
                jsxRuntime.jsx("span", { className: "dsh-dbimg-tool-title", children: `🎨 ${t(ctx, "studioTitle")}` }),
                jsxRuntime.jsx("span", { className: "dsh-dbimg-tool-status", children: headline }),
              ],
            }),
            promptLine
              ? jsxRuntime.jsx("div", { className: "dsh-dbimg-tool-prompt", children: promptLine })
              : null,
            images.length > 0
              ? jsxRuntime.jsx("div", {
                  className: "dsh-dbimg-tool-grid",
                  children: images.map((img, index) =>
                    jsxRuntime.jsxs(
                      "figure",
                      {
                        className: "dsh-dbimg-tool-fig",
                        children: [
                          jsxRuntime.jsx("img", {
                            src: img.previewUrl || "",
                            alt: img.filename || `image ${index + 1}`,
                            loading: "lazy",
                          }),
                          jsxRuntime.jsx("figcaption", {
                            children: [
                              img.filename || `image ${index + 1}`,
                              img.width && img.height ? ` · ${img.width}×${img.height}` : "",
                              img.sizeBytes ? ` · ${formatBytes(img.sizeBytes)}` : "",
                            ].join(""),
                          }),
                        ],
                      },
                      img.filename || index
                    )
                  ),
                })
              : null,
            detailText
              ? jsxRuntime.jsx("details", {
                  className: "dsh-dbimg-tool-details",
                  children: [
                    jsxRuntime.jsx("summary", { children: t(ctx, "imgDetails") }),
                    jsxRuntime.jsx("pre", { className: "dsh-dbimg-tool-pre", children: detailText }),
                  ],
                })
              : null,
          ],
        });
      };
    }

    function createDoubaoStudioChipComponent(ctx) {
      return function DoubaoStudioChip({ sessionId }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const state = useStore(store, (s) => s);

        /* 命令卡片拿不到 inputActions prop，这里也登记一份（chip 常驻，先于命令卡片挂载）。 */

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        /* 未展开时也把总量拉一次，让徽标在首次打开面板前就是准数（事件驱动，不轮询）。 */
        React.useEffect(() => {
          let cancelled = false;
          // chip 只有 sessionId：把 sessionId 带给服务端，由服务端反查该会话的 header.cwd，
          // 否则分组既没有「当前工作区」标记，也可能退化成进程 cwd（profile 目录 desktop）。
          const chipQuery = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
          fetch(`/doubao-paint/status${chipQuery}`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (cancelled || !data) return;
              const groups = normalizeHistoryGroups(data, data.workspace || "");
              if (groups.length > 0) store.setGroups(groups, data.workspace || "");
            })
            .catch(() => {});
          return () => {
            cancelled = true;
          };
        }, [store, sessionId]);

        const toggle = () => store.toggleExpanded();
        const hint = state.expanded ? t(ctx, "collapseHint") : t(ctx, "expandHint");
        const ariaLabel = t(ctx, "studioTitle");
        const totalImages =
          state.groups && state.groups.length > 0
            ? state.groups.reduce(
                (sum, group) =>
                  sum +
                  (Number(group.count) > 0
                    ? Number(group.count)
                    : Array.isArray(group.images)
                      ? group.images.length
                      : 0),
                0
              )
            : state.history.length;

        return jsxRuntime.jsxs("button", {
          type: "button",
          className: "dsh-dbimg-trigger-chip",
          role: "button",
          tabIndex: 0,
          "data-dsh-doubao-chip": state.expanded ? "expanded" : "collapsed",
          "aria-expanded": state.expanded,
          "aria-label": hint || ariaLabel,
          title: hint,
          onMouseDown: (event) => event.preventDefault(),
          onClick: toggle,
          onKeyDown: (event) => {
            if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
            event.preventDefault();
            toggle();
          },
          children: [
            /* 图标用内联矢量：随字号缩放、颜色跟 --db-* 走，不再依赖系统 emoji 字形 */
            jsxRuntime.jsxs("svg", {
              viewBox: "0 0 16 16",
              "aria-hidden": "true",
              focusable: "false",
              children: [
                jsxRuntime.jsx("path", {
                  d: "M8 1.6a6.4 6.4 0 1 0 0 12.8c.9 0 1.3-.6 1.3-1.2 0-.5-.3-.8-.3-1.3 0-.7.5-1.1 1.3-1.1h1c1.6 0 2.5-1.1 2.5-2.6C13.8 4.2 11.3 1.6 8 1.6Z",
                  fill: "none",
                  stroke: "currentColor",
                  strokeWidth: 1.3,
                }),
                jsxRuntime.jsx("circle", { cx: 5.4, cy: 6, r: 1, fill: "currentColor" }),
                jsxRuntime.jsx("circle", { cx: 8, cy: 4.6, r: 1, fill: "currentColor" }),
                jsxRuntime.jsx("circle", { cx: 10.7, cy: 6, r: 1, fill: "currentColor" }),
              ],
            }),
            jsxRuntime.jsx("span", {
              className: "dsh-dbimg-trigger-chip-label",
              children: t(ctx, "chipLabel"),
            }),
            totalImages > 0
              ? jsxRuntime.jsx("span", {
                  className: "dsh-dbimg-trigger-chip-badge",
                  children: t(ctx, "historyCount", { count: totalImages }),
                })
              : null,
          ],
        });
      };
    }

    const inject = ["locale"];
    const name = NS;

    // cordis 只为 inject 里声明过的名字解析服务属性，读 `ctx.slots` 会抛
    // "cannot get property \"slots\" without inject"；而把 slots 写进 inject 又是硬门禁，
    // 宿主没有这个服务时整个 entry 会一直 pending、web boot 审计失败。
    // 所以按 dsh-notify-me 的做法做懒查找：ctx.get() 不要求 inject，再退回 reflect.get 和属性读。
    function lookupService(ctx, serviceName) {
      let service = null;
      try {
        if (ctx && typeof ctx.get === "function") service = ctx.get(serviceName) || null;
      } catch (error) {
        service = null;
      }
      if (service) return service;
      try {
        if (ctx && ctx.reflect && typeof ctx.reflect.get === "function") {
          service = ctx.reflect.get(serviceName) || null;
        }
      } catch (error) {
        service = null;
      }
      if (service) return service;
      try {
        service = (ctx && ctx[serviceName]) || null;
      } catch (error) {
        service = null;
      }
      return service;
    }

    function apply(ctx) {
      if (ctx.locale && typeof ctx.locale.register === "function") {
        if (typeof ctx.effect === "function") {
          ctx.effect(() => ctx.locale.register(NS, LOCALE_STRINGS), "doubao-paint: locale");
          ctx.effect(
            () => ctx.locale.register("plugin-config.doubao-paint", CONFIG_LOCALE_STRINGS),
            "doubao-paint: plugin-config locale"
          );
        } else {
          ctx.locale.register(NS, LOCALE_STRINGS);
          ctx.locale.register("plugin-config.doubao-paint", CONFIG_LOCALE_STRINGS);
        }
      }

      const slots = lookupService(ctx, "slots");
      if (slots && typeof slots.inject === "function" && typeof slots.register === "function") {
        const DoubaoStudioChip = createDoubaoStudioChipComponent(ctx);
        slots.inject("conversation.input.left", () =>
          slots.register(
            {
              name: "conversation.input.left",
              id: "doubao-paint-studio-chip",
              order: 20,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            },
            DoubaoStudioChip
          )
        );
        const DoubaoStudioDock = createDoubaoStudioDockComponent(ctx);
        slots.inject("conversation.input.dock", () =>
          slots.register(
            {
              name: "conversation.input.dock",
              id: "doubao-paint-studio-dock",
              order: -5,
              locale: NS,
              inject: (sessionId) => ({ sessionId }),
            },
            DoubaoStudioDock
          )
        );

        // 工具图卡：doubao_generate_image 的结果在会话里单独出图，详情自动折叠
        const DoubaoImageView = createDoubaoImageViewComponent(ctx);
        slots.inject("tool.call.toolview", () =>
          slots.register(
            {
              name: "tool.call.toolview",
              key: "doubao_generate_image",
              locale: NS,
            },
            DoubaoImageView
          )
        );
      }
    }

    return {
      name,
      inject,
      apply,
      getSessionStore,
      createDoubaoStudioStore,
      createDoubaoImageViewComponent,
              emitGenerated,
      collectBlockText,
      parseToolPayload,
        GENERATED_EVENT,
      formatAgentCommandPrompt,
      insertIntoComposerDraft,
      normalizeHistoryGroups,
      workspaceOfSession,
      ASPECT_RATIOS,
      STYLE_PRESETS,
      STATUS_TTL_MS,
    };
  }

  if (
    typeof window !== "undefined" &&
    window.__ModuleLoader__ &&
    typeof window.__ModuleLoader__.load === "function"
  ) {
    window.__ModuleLoader__.load({
      id: MODULE_ID,
      factory: buildModule,
    });
  }

  if (typeof globalThis !== "undefined") {
    globalThis.__DSH_DOUBAO_PAINT_BUILD__ = buildModule;
  }
})();
