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
    const parts = [`请调用 \`doubao_generate_image\` 工具操控豆包网页版生图：${cleaned}`];
    const meta = [`比例：${ratio}`];
    if (styleLabel) meta.push(`风格：${styleLabel}`);
    if (options.negativePrompt && options.negativePrompt.trim()) {
      meta.push(`负面提示词：${options.negativePrompt.trim()}`);
    }
    return `${parts.join("")}（${meta.join("，")}）`;
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
      .dsh-dbimg-dock-wrap {
        box-sizing: border-box;
        width: 100%;
        display: flex;
        justify-content: center;
        padding: 0 var(--dsh-composer-side-clearance, 16px);
        margin-bottom: 4px;
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
        color: var(--dsw-alias-label-secondary, #4b5563);
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
        background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.06));
      }

      .dsh-dbimg-trigger-chip[data-dsh-doubao-chip="expanded"] {
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(37, 99, 235, 0.12));
        color: var(--dsw-alias-state-business-primary, #2563eb);
      }

      .dsh-dbimg-trigger-chip-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .dsh-dbimg-trigger-chip-badge {
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--dsw-alias-interactive-bg-hover-solid, rgba(37, 99, 235, 0.12));
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
        border-radius: 14px;
        padding: 12px 14px;
        max-height: min(60vh, 560px);
        overflow-y: auto;
        background: var(--dsh-surface-floating, #ffffff);
        color: var(--dsh-text-primary, #0f172a);
        border: 1px solid rgba(15, 23, 42, 0.11);
        box-shadow: 0 10px 28px -6px rgba(15, 23, 42, 0.12);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      @media (prefers-color-scheme: dark) {
        .dsh-dbimg-panel {
          background: var(--dsh-surface-floating, #1e222d);
          color: var(--dsh-text-primary, #f1f5f9);
          border-color: rgba(255, 255, 255, 0.12);
          box-shadow: 0 12px 32px -6px rgba(0, 0, 0, 0.48);
        }
      }

      .dsh-dbimg-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .dsh-dbimg-title {
        display: flex;
        align-items: center;
        gap: 7px;
        font-size: 13.5px;
        font-weight: 600;
      }

      .dsh-dbimg-header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .dsh-dbimg-mini-btn {
        border: 1px solid rgba(15, 23, 42, 0.12);
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
        background: rgba(37, 99, 235, 0.08);
        border-color: rgba(37, 99, 235, 0.3);
      }

      .dsh-dbimg-textarea {
        width: 100%;
        min-height: 58px;
        max-height: 140px;
        resize: vertical;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid rgba(15, 23, 42, 0.14);
        background: rgba(15, 23, 42, 0.02);
        color: inherit;
        padding: 8px 10px;
        font-size: 13px;
        line-height: 1.45;
        outline: none;
        font-family: inherit;
      }

      .dsh-dbimg-textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
      }

      @media (prefers-color-scheme: dark) {
        .dsh-dbimg-textarea {
          border-color: rgba(255, 255, 255, 0.14);
          background: rgba(255, 255, 255, 0.04);
        }
        .dsh-dbimg-mini-btn {
          border-color: rgba(255, 255, 255, 0.15);
        }
      }

      .dsh-dbimg-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 5px;
      }

      .dsh-dbimg-row-label {
        font-size: 11.5px;
        opacity: 0.65;
        margin-right: 4px;
        font-weight: 500;
      }

      .dsh-dbimg-chip {
        border: 1px solid rgba(15, 23, 42, 0.11);
        background: transparent;
        color: inherit;
        font-size: 11.5px;
        padding: 2.5px 9px;
        border-radius: 999px;
        cursor: pointer;
        transition: all 0.14s ease;
      }

      .dsh-dbimg-chip.active {
        background: #2563eb;
        color: #ffffff;
        border-color: #2563eb;
        font-weight: 600;
      }

      @media (prefers-color-scheme: dark) {
        .dsh-dbimg-chip {
          border-color: rgba(255, 255, 255, 0.14);
        }
      }

      .dsh-dbimg-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 2px;
      }

      .dsh-dbimg-btn-group {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .dsh-dbimg-primary-btn {
        background: #2563eb;
        color: #ffffff;
        border: none;
        border-radius: 8px;
        padding: 6px 13px;
        font-size: 12.5px;
        font-weight: 600;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        transition: background 0.15s ease;
      }

      .dsh-dbimg-primary-btn:hover:not(:disabled) {
        background: #1d4ed8;
      }

      .dsh-dbimg-primary-btn:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }

      .dsh-dbimg-secondary-btn {
        background: rgba(37, 99, 235, 0.1);
        color: #1d4ed8;
        border: 1px solid rgba(37, 99, 235, 0.25);
        border-radius: 8px;
        padding: 5.5px 12px;
        font-size: 12.5px;
        font-weight: 500;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }

      @media (prefers-color-scheme: dark) {
        .dsh-dbimg-secondary-btn {
          background: rgba(59, 130, 246, 0.16);
          color: #93c5fd;
          border-color: rgba(59, 130, 246, 0.32);
        }
      }

      .dsh-dbimg-status {
        font-size: 12px;
        padding: 7px 10px;
        border-radius: 8px;
        background: rgba(37, 99, 235, 0.07);
        border: 1px solid rgba(37, 99, 235, 0.18);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      .dsh-dbimg-status.warn {
        background: rgba(245, 158, 11, 0.1);
        border-color: rgba(245, 158, 11, 0.3);
        color: #b45309;
      }

      @media (prefers-color-scheme: dark) {
        .dsh-dbimg-status.warn {
          color: #fcd34d;
        }
      }

      .dsh-dbimg-gallery {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
        gap: 8px;
        margin-top: 4px;
      }

      .dsh-dbimg-card {
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

      .dsh-dbimg-card-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 4px 6px;
        font-size: 11px;
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

  function createDoubaoStudioStore(createSnapshotStoreFn = createFallbackSnapshotStore) {
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
        return update((s) => ({
          ...s,
          loading: Boolean(loading),
          statusMessage,
          statusKind,
        }));
      },
      setLoginRequired(loginRequired, statusMessage = "") {
        return update((s) => ({
          ...s,
          loading: false,
          loginRequired: Boolean(loginRequired),
          statusMessage,
          statusKind: loginRequired ? "warn" : "info",
        }));
      },
      setHistory(history) {
        return update((s) => ({
          ...s,
          history: Array.isArray(history) ? history : [],
        }));
      },
    };
  }

  const LOCALE_STRINGS = {
    zh: {
      studioTitle: "豆包网页生图工坊",
      triggerLabel: "🎨 豆包生图",
      insertAgentBtn: "✨ 插入对话让 Agent 生图",
      directGenBtn: "🚀 立即操控豆包生图",
      openDoubaoBtn: "🌐 打开豆包网页",
    },
    en: {
      studioTitle: "Doubao Web Image Studio",
      triggerLabel: "🎨 Doubao Image",
      insertAgentBtn: "✨ Insert for Agent",
      directGenBtn: "🚀 Generate in Doubao Now",
      openDoubaoBtn: "🌐 Open Doubao Web",
    },
  };

  const CONFIG_LOCALE_STRINGS = {
    zh: {
      _title: "豆包网页生图工坊 (Doubao Web Image Studio)",
      _description:
        "操控豆包网页版（doubao.com）进行 AI 图像生成：注册 doubao_generate_image 原生工具，通过 Tabbit 自动提交提示词、选择比例与风格、下载高清原图并注入对话附件，同时在输入框上方提供「豆包生图工坊」可视化面板。",
      enabled: {
        _title: "启用豆包网页生图插件",
        _description: "开启后将注册 doubao_generate_image / doubao_image_status 工具，并在对话输入框上方挂载「豆包生图工坊」快捷入口。",
      },
      tabbitCliPath: {
        _title: "Tabbit CLI 可执行文件路径",
        _description: "用于操控浏览器的 tabbit-cli 启动器路径（留空则自动解析 ~/.local/bin/tabbit-cli）。",
      },
      doubaoUrl: {
        _title: "豆包网页版入口地址",
        _description: "默认访问的豆包对话与生图页面 URL（默认 https://www.doubao.com/chat/）。",
      },
      taskName: {
        _title: "Tabbit 浏览器任务组名称",
        _description: "在 Tabbit 浏览器中显示的豆包自动化标签组标题（默认 Doubao AI Image Studio）。",
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
        _description: "豆包生成图片下载后的本地保存目录（相对路径基于当前工作区解析，默认 doubao_images）。",
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
        _description: "开启后向 Agent 系统提示词注入豆包网页生图工具使用说明，使模型在收到画图请求时优先自动调用。",
      },
    },
    en: {
      _title: "Doubao Web Image Studio",
      _description:
        "Automate Doubao Web (doubao.com) for AI image generation via Tabbit Browser: registers doubao_generate_image & doubao_image_status tools, downloads lossless images into multimodal chat attachments, and adds a visual Doubao Image Studio dock above the composer.",
      enabled: {
        _title: "Enable Doubao Web Image Plugin",
        _description: "Registers doubao_generate_image / doubao_image_status tools and mounts the Doubao Image Studio quick dock above the chat input box.",
      },
      tabbitCliPath: {
        _title: "Tabbit CLI Executable Path",
        _description: "Path to the tabbit-cli launcher binary (leave empty to auto-resolve ~/.local/bin/tabbit-cli).",
      },
      doubaoUrl: {
        _title: "Doubao Web Entry URL",
        _description: "Target Doubao Web chat URL used for image generation (defaults to https://www.doubao.com/chat/).",
      },
      taskName: {
        _title: "Tabbit Browser Task Group Name",
        _description: "Visible tab-group title created in Tabbit Browser (defaults to Doubao AI Image Studio).",
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
        _description: "Directory where downloaded high-resolution Doubao images are saved (relative paths resolve against the workspace, default: doubao_images).",
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
      return function DoubaoStudioDock({ sessionId, inputActions }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const state = useStore(store, (s) => s);

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        React.useEffect(() => {
          if (!state.expanded) return;
          let cancelled = false;
          fetch("/doubao-paint/status")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (!cancelled && data && Array.isArray(data.history)) {
                store.setHistory(data.history);
              }
            })
            .catch(() => {});
          return () => {
            cancelled = true;
          };
        }, [state.expanded, store]);

        const handleInsertToAgent = () => {
          const text = formatAgentCommandPrompt(state.prompt, {
            aspectRatio: state.aspectRatio,
            style: state.style,
          });
          if (!text) {
            store.setLoading(false, "请先输入生图画面描述词（Prompt）", "warn");
            return;
          }
          const inserted = insertIntoComposerDraft(ctx, sessionId, text, inputActions);
          if (inserted) {
            store.setLoading(false, "已将豆包生图指令插入底部对话输入框，直接发送即可让 Agent 操控生图！", "info");
          } else {
            store.setLoading(false, "插入失败：输入框尚未就绪，请先点一下底部输入框再试。", "warn");
          }
        };

        const handleOpenDoubaoWeb = async () => {
          store.setLoading(true, "正在通过 Tabbit 浏览器打开豆包网页版...", "info");
          try {
            const resp = await fetch("/doubao-paint/open", { method: "POST" });
            const data = await resp.json().catch(() => ({}));
            const outcome = data.outcome || {};
            if (outcome.status === "login_required") {
              store.setLoginRequired(true, outcome.message || "请在已打开的 Tabbit 豆包标签页中扫码或使用飞书登录。");
            } else {
              store.setLoginRequired(false, outcome.message || "已在 Tabbit 浏览器中打开豆包网页版！");
            }
          } catch (err) {
            store.setLoading(false, `打开豆包网页失败：${String(err?.message || err)}`, "warn");
          }
        };

        const handleDirectGenerate = async () => {
          const cleaned = (state.prompt || "").trim();
          if (!cleaned) {
            store.setLoading(false, "请先输入生图画面描述词（Prompt）", "warn");
            return;
          }
          store.setLoading(true, "正在通过 Tabbit 操控豆包网页版生成高清图片（约需 15~40 秒）...", "info");
          try {
            const resp = await fetch("/doubao-paint/generate", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                prompt: cleaned,
                aspectRatio: state.aspectRatio,
                style: state.style,
                maxImages: 4,
              }),
            });
            const data = await resp.json().catch(() => ({}));
            const outcome = data.outcome || {};
            if (Array.isArray(data.history)) {
              store.setHistory(data.history);
            }
            if (outcome.status === "login_required") {
              store.setLoginRequired(
                true,
                outcome.message || "豆包网页版尚未登录，已在 Tabbit 打开登录窗口，请扫码后重试。"
              );
              return;
            }
            if (outcome.status !== "succeeded") {
              store.setLoading(
                false,
                outcome.message || data.error || "生图未完成，请检查 Tabbit 浏览器中的豆包标签页。",
                "warn"
              );
              return;
            }
            store.setLoginRequired(
              false,
              `🎉 成功生成并下载 ${outcome.imageCount || 0} 张高清图片至 ${outcome.outputDir || "doubao_images"}！`
            );
          } catch (err) {
            store.setLoading(false, `请求异常：${String(err?.message || err)}`, "warn");
          }
        };

        if (!state.expanded) return null;

        return jsxRuntime.jsx("div", {
          className: "dsh-dbimg-dock-wrap",
          "data-dsh-doubao-dock": "expanded",
          children: jsxRuntime.jsxs("div", {
            className: "dsh-dbimg-panel",
            children: [
              jsxRuntime.jsxs("div", {
                className: "dsh-dbimg-header",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "dsh-dbimg-title",
                    children: [
                      jsxRuntime.jsx("span", { children: "🎨 豆包网页生图工坊 (Doubao Paint Studio)" }),
                    ],
                  }),
                  jsxRuntime.jsxs("div", {
                    className: "dsh-dbimg-header-actions",
                    children: [
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-dbimg-mini-btn",
                        onClick: handleOpenDoubaoWeb,
                        disabled: state.loading,
                        children: "🌐 唤醒豆包网页 / 检查登录",
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-dbimg-mini-btn",
                        onClick: () => store.setExpanded(false),
                        children: "收起 ✕",
                      }),
                    ],
                  }),
                ],
              }),
              jsxRuntime.jsx("textarea", {
                className: "dsh-dbimg-textarea",
                placeholder:
                  "输入你想让豆包生成的画面描述词（例如：一只戴着宇航员头盔的橘猫在月球表面喝咖啡，电影级光影）...",
                value: state.prompt,
                onChange: (e) => store.setPrompt(e.target.value),
                onKeyDown: (e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    handleInsertToAgent();
                  }
                },
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
              jsxRuntime.jsxs("div", {
                className: "dsh-dbimg-footer",
                children: [
                  jsxRuntime.jsxs("div", {
                    className: "dsh-dbimg-btn-group",
                    children: [
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-dbimg-primary-btn",
                        disabled: state.loading,
                        onClick: handleInsertToAgent,
                        children: "✨ 插入对话让 Agent 生图 (⌘↵)",
                      }),
                      jsxRuntime.jsx("button", {
                        type: "button",
                        className: "dsh-dbimg-secondary-btn",
                        disabled: state.loading,
                        onClick: handleDirectGenerate,
                        children: state.loading ? "⏳ 正在操控豆包生图..." : "🚀 立即操控豆包网页生图",
                      }),
                    ],
                  }),
                ],
              }),
              state.statusMessage
                ? jsxRuntime.jsxs("div", {
                    className: `dsh-dbimg-status${state.statusKind === "warn" ? " warn" : ""}`,
                    children: [
                      jsxRuntime.jsx("span", { children: state.statusMessage }),
                      state.loginRequired
                        ? jsxRuntime.jsx("button", {
                            type: "button",
                            className: "dsh-dbimg-mini-btn",
                            onClick: handleOpenDoubaoWeb,
                            children: "🔑 重新唤起登录框",
                          })
                        : null,
                    ],
                  })
                : null,
              state.history.length > 0
                ? jsxRuntime.jsx("div", {
                    className: "dsh-dbimg-gallery",
                    children: state.history.slice(0, 4).map((item) =>
                      jsxRuntime.jsxs(
                        "div",
                        {
                          className: "dsh-dbimg-card",
                          children: [
                            jsxRuntime.jsx("img", {
                              src: item.previewUrl,
                              alt: item.prompt || item.filename,
                              loading: "lazy",
                            }),
                            jsxRuntime.jsxs("div", {
                              className: "dsh-dbimg-card-bar",
                              children: [
                                jsxRuntime.jsx("span", {
                                  children: item.aspectRatio || "16:9",
                                }),
                                jsxRuntime.jsx("button", {
                                  type: "button",
                                  className: "dsh-dbimg-mini-btn",
                                  onClick: () =>
                                    insertIntoComposerDraft(
                                      ctx,
                                      sessionId,
                                      `@${item.filePath} `,
                                      inputActions
                                    ),
                                  children: "引用路径",
                                }),
                              ],
                            }),
                          ],
                        },
                        item.id || item.filePath
                      )
                    ),
                  })
                : null,
            ],
          }),
        });
      };
    }

    // 紧凑触发条：注册在 conversation.input.left，渲染在「工作区内修改」右侧同一行
    function createDoubaoStudioChipComponent() {
      return function DoubaoStudioChip({ sessionId }) {
        const store = React.useMemo(() => getSessionStore(sessionId), [sessionId]);
        const state = useStore(store, (s) => s);

        React.useEffect(() => {
          ensureStylesInjected();
        }, []);

        return jsxRuntime.jsxs("button", {
          type: "button",
          className: "dsh-dbimg-trigger-chip",
          "data-dsh-doubao-chip": state.expanded ? "expanded" : "collapsed",
          "aria-expanded": state.expanded,
          title: state.expanded
            ? "收起豆包网页生图工坊 (Doubao Paint Studio)"
            : "展开豆包网页生图工坊 (Doubao Paint Studio)",
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => store.toggleExpanded(),
          children: [
            jsxRuntime.jsx("span", { children: "🎨" }),
            jsxRuntime.jsx("span", { className: "dsh-dbimg-trigger-chip-label", children: "豆包网页生图" }),
            jsxRuntime.jsx("span", { className: "dsh-dbimg-trigger-chip-badge", children: state.aspectRatio }),
            state.history.length > 0
              ? jsxRuntime.jsx("span", {
                  className: "dsh-dbimg-trigger-chip-badge",
                  children: `${state.history.length} 张`,
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
        const DoubaoStudioChip = createDoubaoStudioChipComponent();
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
      }
    }

    return {
      name,
      inject,
      apply,
      getSessionStore,
      createDoubaoStudioStore,
      formatAgentCommandPrompt,
      insertIntoComposerDraft,
      ASPECT_RATIOS,
      STYLE_PRESETS,
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
