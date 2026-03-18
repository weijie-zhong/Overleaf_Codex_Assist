// ==UserScript==
// @name         Overleaf Assist Demo (Codex CLI)
// @namespace    https://overleaf.com/
// @version      0.3.1
// @description  Demo assistant UI for Overleaf with a local Codex CLI proxy backend.
// @match        https://www.overleaf.com/*
// @match        https://overleaf.com/*
// @run-at       document-end
// @inject-into  content
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  const ASSIST_STORAGE_KEY = 'overleafAssistDemoConfig';
  const SCRIPT_VERSION = '0.3.1';
  const DEFAULT_CONFIG = {
    proxyUrl: 'http://localhost:8787/assist',
    scope: 'auto',
    applyMode: 'smart_replace',
    layoutMode: 'dock-left',
    activeTab: 'chat',
    floatingX: 36,
    floatingY: 84,
    floatingWidth: 560,
    floatingHeight: 680,
    dockWidth: 500,
    consoleHeight: 320,
    chatMemoryTurns: 12,
    showContextPane: true,
    tokenLimitOverride: '',
    timeoutSecondsOverride: '',
    modelMode: 'preset',
    presetModel: '',
    customModel: '',
    reasoningEffort: 'default',
  };
  const MODEL_MODE_OPTIONS = ['preset', 'custom'];
  const LAYOUT_MODE_OPTIONS = ['dock-left', 'dock-right', 'floating', 'bottom-console'];
  const APPLY_MODE_OPTIONS = ['smart_replace', 'replace', 'insert', 'copy'];
  const ACTIVE_TAB_OPTIONS = ['chat', 'settings'];
  const ALLOWED_REASONING_EFFORTS = ['default', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const FALLBACK_REASONING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh'];
  const DEFAULT_MODEL_CONTEXT_LIMIT = 1000000;
  const MODEL_CONTEXT_LIMITS = {
    'gpt-4.1': 128000,
    'gpt-5': 200000,
    'gpt-5.1': 200000,
    'gpt-5.2': 200000,
    'gpt-5.3': 200000,
    'gpt-5-codex': 200000,
    'gpt-5.1-codex': 200000,
    'gpt-5.2-codex': 200000,
    'gpt-5.3-codex': 200000,
    'gpt-5.3-codex-spark': 200000,
  };

  const HAS_GM_GET = typeof GM_getValue === 'function';
  const HAS_GM_SET = typeof GM_setValue === 'function';
  const HAS_GM_MENU = typeof GM_registerMenuCommand === 'function';
  const HAS_GM_STYLE = typeof GM_addStyle === 'function';

  const state = {
    config: null,
    ui: null,
    lastResponseText: '',
    chatTurns: [],
    sessionUsage: {
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      estimated_total_tokens: 0,
    },
    lastContextSnapshot: {
      content: '',
      scope: 'auto',
      usedSelection: false,
      sourceLabel: '-',
      estimatedTokens: 0,
      updatedAt: 0,
    },
    previewTimer: null,
    smartReplace: {
      rawResponse: '',
      blocks: [],
      planItems: [],
      parseError: '',
    },
    modelsMeta: {
      source: 'fallback',
      default_model: null,
      default_reasoning_effort: null,
      models: [],
    },
    modelsMetaError: '',
    modelsUrl: '',
    bridgeVersion: '',
    versionMismatchMessage: '',
    versionPromptedKey: '',
    hiddenForNoEditor: false,
    currentProjectId: '',
    currentSessionId: '',
    currentSessionSeq: 0,
    currentSessionStatus: 'idle',
    currentSessionStatusMessage: '',
    currentRunId: '',
    sessionStreamAbort: null,
    sessionReconnectTimer: null,
    sessionStreamActiveFor: '',
  };

  function normalizeReasoningEffort(value) {
    if (typeof value !== 'string') {
      return 'default';
    }
    const normalized = value.trim().toLowerCase();
    if (!ALLOWED_REASONING_EFFORTS.includes(normalized)) {
      return 'default';
    }
    return normalized;
  }

  function normalizeModelMode(value) {
    if (typeof value !== 'string') {
      return 'preset';
    }
    return MODEL_MODE_OPTIONS.includes(value) ? value : 'preset';
  }

  function normalizeLayoutMode(value) {
    if (typeof value !== 'string') {
      return 'dock-left';
    }
    return LAYOUT_MODE_OPTIONS.includes(value) ? value : 'dock-left';
  }

  function normalizeApplyMode(value) {
    if (typeof value !== 'string') {
      return 'smart_replace';
    }
    return APPLY_MODE_OPTIONS.includes(value) ? value : 'smart_replace';
  }

  function normalizeActiveTab(value) {
    if (typeof value !== 'string') {
      return 'chat';
    }
    return ACTIVE_TAB_OPTIONS.includes(value) ? value : 'chat';
  }

  function createFallbackModelsMeta() {
    return {
      source: 'fallback',
      default_model: null,
      default_reasoning_effort: null,
      models: [],
    };
  }

  function deriveServiceUrl(proxyUrl, endpoint) {
    const safeEndpoint = String(endpoint || '').trim().replace(/^\/+/, '');
    if (!safeEndpoint) {
      return 'http://localhost:8787/';
    }
    if (typeof proxyUrl !== 'string' || !proxyUrl.trim()) {
      return `http://localhost:8787/${safeEndpoint}`;
    }
    const value = proxyUrl.trim();
    try {
      const url = new URL(value);
      if (/\/assist$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/assist$/i, `/${safeEndpoint}`);
      } else {
        url.pathname = url.pathname.replace(/\/+$/, '') + `/${safeEndpoint}`;
      }
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (err) {
      if (/\/assist$/i.test(value)) {
        return value.replace(/\/assist$/i, `/${safeEndpoint}`);
      }
      return value.replace(/\/+$/, '') + `/${safeEndpoint}`;
    }
  }

  function deriveModelsUrl(proxyUrl) {
    return deriveServiceUrl(proxyUrl, 'models');
  }

  function deriveAssistStreamUrl(proxyUrl) {
    return deriveServiceUrl(proxyUrl, 'assist-stream');
  }

  function deriveHealthUrl(proxyUrl) {
    return deriveServiceUrl(proxyUrl, 'health');
  }

  function deriveDoctorUrl(proxyUrl) {
    return deriveServiceUrl(proxyUrl, 'doctor');
  }

  function deriveProjectSessionUrl(proxyUrl, projectId) {
    return deriveServiceUrl(proxyUrl, `session/project/${encodeURIComponent(String(projectId || '').trim())}`);
  }

  function deriveProjectRunUrl(proxyUrl, projectId) {
    return deriveServiceUrl(proxyUrl, `session/project/${encodeURIComponent(String(projectId || '').trim())}/run`);
  }

  function deriveSessionEventsUrl(proxyUrl, sessionId, afterSeq) {
    const base = deriveServiceUrl(proxyUrl, `session/${encodeURIComponent(String(sessionId || '').trim())}/events`);
    const url = new URL(base);
    url.searchParams.set('after', String(Number.isFinite(Number(afterSeq)) ? Math.max(0, Math.floor(Number(afterSeq))) : 0));
    return url.toString();
  }

  function deriveSessionCancelUrl(proxyUrl, sessionId) {
    return deriveServiceUrl(proxyUrl, `session/${encodeURIComponent(String(sessionId || '').trim())}/cancel`);
  }

  function deriveCurrentProjectId() {
    const pathname = window.location && typeof window.location.pathname === 'string'
      ? window.location.pathname
      : '';
    const match = pathname.match(/\/project\/([^/?#]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    const normalizedPath = pathname.replace(/\/+$/, '') || '/';
    return `page:${normalizedPath}`;
  }

  function normalizeModelsMeta(raw) {
    if (!raw || typeof raw !== 'object') {
      return createFallbackModelsMeta();
    }

    const source = raw.source === 'models_cache' ? 'models_cache' : 'fallback';
    const defaultModel =
      typeof raw.default_model === 'string' && raw.default_model.trim() ? raw.default_model.trim() : null;
    const defaultReasoning = normalizeReasoningEffort(raw.default_reasoning_effort);
    const modelsRaw = Array.isArray(raw.models) ? raw.models : [];
    const models = [];
    const seenIds = new Set();

    for (const model of modelsRaw) {
      if (!model || typeof model !== 'object' || typeof model.id !== 'string') {
        continue;
      }
      const id = model.id.trim();
      if (!id || seenIds.has(id)) {
        continue;
      }
      seenIds.add(id);
      const description =
        typeof model.description === 'string' && model.description.trim() ? model.description.trim() : '';
      const defaultReasoningLevel = normalizeReasoningEffort(model.default_reasoning_level);
      const supportedRaw = Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : [];
      const supportedSet = new Set();
      const supported = [];
      for (const effortValue of supportedRaw) {
        const normalized = normalizeReasoningEffort(effortValue);
        if (normalized === 'default' || supportedSet.has(normalized)) {
          continue;
        }
        supportedSet.add(normalized);
        supported.push(normalized);
      }
      if (defaultReasoningLevel !== 'default' && !supportedSet.has(defaultReasoningLevel)) {
        supported.push(defaultReasoningLevel);
      }

      models.push({
        id,
        description: description || undefined,
        default_reasoning_level: defaultReasoningLevel === 'default' ? undefined : defaultReasoningLevel,
        supported_reasoning_levels: supported,
      });
    }

    return {
      source,
      default_model: defaultModel,
      default_reasoning_effort: defaultReasoning === 'default' ? null : defaultReasoning,
      models,
    };
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function readStoredConfig() {
    let raw = null;
    if (HAS_GM_GET) {
      try {
        raw = GM_getValue(ASSIST_STORAGE_KEY);
      } catch (err) {
        raw = null;
      }
    }

    if (raw == null) {
      try {
        raw = localStorage.getItem(ASSIST_STORAGE_KEY);
      } catch (err) {
        raw = null;
      }
    }

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (err) {
        return null;
      }
    }

    if (raw && typeof raw === 'object') {
      return raw;
    }

    return null;
  }

  function writeStoredConfig(config) {
    const serialized = JSON.stringify(config);
    if (HAS_GM_SET) {
      try {
        GM_setValue(ASSIST_STORAGE_KEY, serialized);
        return;
      } catch (err) {
        // fall through
      }
    }

    try {
      localStorage.setItem(ASSIST_STORAGE_KEY, serialized);
    } catch (err) {
      // ignore
    }
  }

  function createEmptySessionUsage() {
    return {
      estimated_input_tokens: 0,
      estimated_output_tokens: 0,
      estimated_total_tokens: 0,
    };
  }

  function normalizeSessionUsage(rawUsage) {
    const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
    return {
      estimated_input_tokens: Number.isFinite(Number(usage.estimated_input_tokens))
        ? Math.max(0, Math.floor(Number(usage.estimated_input_tokens)))
        : 0,
      estimated_output_tokens: Number.isFinite(Number(usage.estimated_output_tokens))
        ? Math.max(0, Math.floor(Number(usage.estimated_output_tokens)))
        : 0,
      estimated_total_tokens: Number.isFinite(Number(usage.estimated_total_tokens))
        ? Math.max(0, Math.floor(Number(usage.estimated_total_tokens)))
        : 0,
    };
  }

  function normalizeStoredChatTurns(rawTurns) {
    if (!Array.isArray(rawTurns)) {
      return [];
    }
    return rawTurns
      .map((turn) => {
        if (!turn || typeof turn !== 'object') {
          return null;
        }
        const role =
          typeof turn.role === 'string' && ['user', 'assistant', 'system'].includes(turn.role.trim())
            ? turn.role.trim()
            : '';
        const text = typeof turn.text === 'string' ? turn.text.trim() : '';
        if (!role || !text) {
          return null;
        }
        const normalized = {
          role,
          text,
          ts: Number.isFinite(Number(turn.ts)) ? Math.max(0, Math.floor(Number(turn.ts))) : Date.now(),
        };
        if (typeof turn.tag === 'string' && turn.tag.trim()) {
          normalized.tag = turn.tag.trim();
        }
        return normalized;
      })
      .filter(Boolean)
      .slice(-120);
  }

  function loadConfig() {
    const stored = readStoredConfig();
    if (stored) {
      state.config = { ...deepClone(DEFAULT_CONFIG), ...stored };
    } else {
      state.config = deepClone(DEFAULT_CONFIG);
    }

    if (typeof state.config.model === 'string' && state.config.model.trim()) {
      if (!state.config.customModel && !state.config.presetModel) {
        state.config.customModel = state.config.model.trim();
        state.config.modelMode = 'custom';
      }
    }

    state.config.modelMode = normalizeModelMode(state.config.modelMode);
    state.config.layoutMode = normalizeLayoutMode(state.config.layoutMode);
    state.config.applyMode = normalizeApplyMode(state.config.applyMode);
    state.config.activeTab = normalizeActiveTab(state.config.activeTab);
    state.config.floatingX = Number.isFinite(Number(state.config.floatingX)) ? Number(state.config.floatingX) : DEFAULT_CONFIG.floatingX;
    state.config.floatingY = Number.isFinite(Number(state.config.floatingY)) ? Number(state.config.floatingY) : DEFAULT_CONFIG.floatingY;
    state.config.floatingWidth = Number.isFinite(Number(state.config.floatingWidth)) ? Number(state.config.floatingWidth) : DEFAULT_CONFIG.floatingWidth;
    state.config.floatingHeight = Number.isFinite(Number(state.config.floatingHeight)) ? Number(state.config.floatingHeight) : DEFAULT_CONFIG.floatingHeight;
    state.config.dockWidth = Number.isFinite(Number(state.config.dockWidth)) ? Number(state.config.dockWidth) : DEFAULT_CONFIG.dockWidth;
    state.config.consoleHeight = Number.isFinite(Number(state.config.consoleHeight)) ? Number(state.config.consoleHeight) : DEFAULT_CONFIG.consoleHeight;
    state.config.chatMemoryTurns = Number.isFinite(Number(state.config.chatMemoryTurns))
      ? Math.max(1, Math.floor(Number(state.config.chatMemoryTurns)))
      : DEFAULT_CONFIG.chatMemoryTurns;
    state.config.showContextPane = typeof state.config.showContextPane === 'boolean' ? state.config.showContextPane : true;
    state.config.tokenLimitOverride = typeof state.config.tokenLimitOverride === 'string' ? state.config.tokenLimitOverride.trim() : '';
    const timeoutSecondsRaw =
      typeof state.config.timeoutSecondsOverride === 'string'
        ? state.config.timeoutSecondsOverride.trim()
        : '';
    if (timeoutSecondsRaw) {
      const parsed = Number(timeoutSecondsRaw);
      state.config.timeoutSecondsOverride =
        Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed)
          ? String(parsed)
          : '';
    } else {
      const legacyTimeoutMsRaw =
        typeof state.config.timeoutMsOverride === 'string'
          ? state.config.timeoutMsOverride.trim()
          : '';
      if (legacyTimeoutMsRaw) {
        const parsedLegacyMs = Number(legacyTimeoutMsRaw);
        state.config.timeoutSecondsOverride =
          Number.isFinite(parsedLegacyMs) && parsedLegacyMs > 0
            ? String(Math.max(1, Math.round(parsedLegacyMs / 1000)))
            : '';
      } else {
        state.config.timeoutSecondsOverride = '';
      }
    }
    if (Object.prototype.hasOwnProperty.call(state.config, 'timeoutMsOverride')) {
      delete state.config.timeoutMsOverride;
    }
    state.config.presetModel = typeof state.config.presetModel === 'string' ? state.config.presetModel.trim() : '';
    state.config.customModel = typeof state.config.customModel === 'string' ? state.config.customModel.trim() : '';
    state.config.reasoningEffort = normalizeReasoningEffort(state.config.reasoningEffort);
    writeStoredConfig(state.config);
  }

  function installStyles() {
    const css = `
      #ola-overlay {
        position: fixed;
        display: none;
        min-width: 320px;
        min-height: 220px;
        z-index: 999999;
        font-family: "JetBrains Mono", "Consolas", "Menlo", monospace;
      }
      #ola-overlay.open {
        display: block;
      }
      #ola-overlay.layout-dock-left {
        top: 72px;
        left: 16px;
        bottom: 16px;
        width: min(500px, calc(100vw - 24px));
      }
      #ola-overlay.layout-dock-right {
        top: 72px;
        right: 16px;
        bottom: 16px;
        width: min(500px, calc(100vw - 24px));
      }
      #ola-overlay.layout-floating {
        top: 84px;
        left: 36px;
        width: min(560px, calc(100vw - 24px));
        height: min(680px, calc(100vh - 24px));
      }
      #ola-overlay.layout-bottom-console {
        left: 16px;
        right: 16px;
        bottom: 16px;
        height: min(320px, calc(100vh - 24px));
      }
      #ola-overlay.layout-floating.resizing,
      #ola-overlay.layout-floating.dragging {
        pointer-events: auto;
      }
      #ola-panel {
        height: 100%;
        display: flex;
        flex-direction: column;
        background: #0e131b;
        color: #d4dced;
        border-radius: 12px;
        border: 1px solid #26354a;
        box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
        pointer-events: auto;
        overflow: hidden;
      }
      .ola-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 12px;
        border-bottom: 1px solid #2a3648;
        background: linear-gradient(180deg, #131b27 0%, #111824 100%);
      }
      #ola-overlay.layout-floating .ola-header {
        cursor: move;
      }
      .ola-header-controls {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ola-title-wrap {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }
      .ola-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.2px;
      }
      #ola-status {
        font-size: 11px;
        color: #a8b8d2;
        background: #0a111c;
        border: 1px solid #243347;
        border-radius: 999px;
        padding: 4px 8px;
        max-width: min(56vw, 420px);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #ola-status.error {
        color: #fecaca;
        border-color: #7f1d1d;
        background: rgba(127, 29, 29, 0.28);
      }
      .ola-tab-strip {
        display: flex;
        align-items: center;
        gap: 5px;
      }
      #ola-panel .ola-tab {
        border: 1px solid #334155;
        border-radius: 999px;
        padding: 5px 9px;
        cursor: pointer;
        background: #0c1522;
        color: #a8bad8;
        font-size: 10px;
        line-height: 1;
      }
      #ola-panel .ola-tab.is-active {
        background: #16263a;
        color: #e1ecff;
        border-color: #3b82f6;
      }
      .ola-main-panel {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ola-settings-panel {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        gap: 10px;
        overflow: auto;
        padding-right: 2px;
      }
      .ola-chat-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-start;
      }
      #ola-panel #ola-close {
        width: 28px;
        height: 28px;
        padding: 0;
        line-height: 1;
        border-radius: 6px;
        border: 1px solid #3a4558;
        background: #1a2534;
        color: #c8d2e6;
        cursor: pointer;
      }
      .ola-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px 12px;
        min-height: 0;
      }
      .ola-label {
        display: flex;
        flex-direction: column;
        gap: 5px;
        font-size: 11px;
      }
      .ola-config {
        display: grid;
        grid-template-columns: 1fr;
        gap: 8px;
        border: 1px solid #2f3f58;
        border-radius: 10px;
        background: #0a0f16;
        padding: 8px;
      }
      .ola-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: flex-end;
      }
      .ola-row label {
        font-size: 11px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      #ola-panel select,
      #ola-panel input[type="text"],
      #ola-panel input[type="number"],
      #ola-panel textarea {
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        background: #101722;
        color: #d4dced;
      }
      #ola-prompt {
        min-height: 72px;
        resize: vertical;
      }
      .ola-actions {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      #ola-panel button {
        border: none;
        border-radius: 6px;
        margin: 0;
        padding: 5px 8px;
        cursor: pointer;
        background: #2563eb;
        color: #f8fbff;
        font-size: 11px;
        line-height: 1.2;
      }
      #ola-panel button.secondary {
        background: #172131;
        color: #d0d8ea;
        border: 1px solid #334155;
      }
      #ola-panel button[disabled] {
        opacity: 0.6;
        cursor: not-allowed;
      }
      .ola-workspace {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1.8fr 1fr;
        gap: 10px;
      }
      .ola-workspace.context-hidden {
        grid-template-columns: 1fr;
      }
      #ola-overlay.layout-bottom-console .ola-workspace {
        grid-template-columns: 1fr 0.85fr;
      }
      #ola-overlay.layout-bottom-console .ola-workspace.context-hidden {
        grid-template-columns: 1fr;
      }
      .ola-chat-pane,
      .ola-context-pane {
        min-height: 0;
        border: 1px solid #2f3f58;
        background: #0a0f16;
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        padding: 8px;
        gap: 8px;
      }
      .ola-context-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 11px;
        color: #9bb2d8;
      }
      .ola-plan-pane {
        border: 1px solid #2f3f58;
        background: #0a0f16;
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 8px;
      }
      .ola-plan-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-size: 11px;
        color: #9bb2d8;
      }
      .ola-plan-actions {
        display: flex;
        gap: 4px;
        flex-wrap: wrap;
      }
      .ola-plan-list {
        max-height: 220px;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ola-plan-item {
        border: 1px solid #2a3a4f;
        border-radius: 7px;
        padding: 6px;
        background: #0f1621;
        display: grid;
        gap: 5px;
        font-size: 11px;
      }
      .ola-plan-item-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        font-size: 11px;
      }
      .ola-plan-status {
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid transparent;
      }
      .ola-plan-status.resolved {
        color: #a6f4c5;
        border-color: #2f855a;
      }
      .ola-plan-status.ambiguous {
        color: #fde68a;
        border-color: #d97706;
      }
      .ola-plan-status.missing {
        color: #fecaca;
        border-color: #dc2626;
      }
      .ola-plan-preview {
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 11px;
        line-height: 1.35;
      }
      .ola-plan-diff {
        border: 1px solid #243347;
        border-radius: 6px;
        background: #070b12;
        display: grid;
        gap: 4px;
        padding: 6px;
      }
      .ola-plan-diff-line {
        display: grid;
        grid-template-columns: 16px 1fr;
        gap: 6px;
        align-items: start;
        font-size: 11px;
        line-height: 1.35;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .ola-plan-diff-gutter {
        font-weight: 700;
        text-align: center;
        opacity: 0.9;
      }
      .ola-plan-diff-line.old .ola-plan-diff-gutter {
        color: #ef4444;
      }
      .ola-plan-diff-line.new .ola-plan-diff-gutter {
        color: #22c55e;
      }
      .ola-plan-diff-line.same .ola-plan-diff-gutter {
        color: #93a4c2;
      }
      .ola-plan-diff-text {
        color: #dbe7ff;
      }
      .ola-plan-diff-ctx {
        color: #9fb4d7;
      }
      .ola-plan-diff-del {
        color: #fecaca;
        background: rgba(239, 68, 68, 0.28);
        border-radius: 3px;
        padding: 0 2px;
      }
      .ola-plan-diff-ins {
        color: #bbf7d0;
        background: rgba(34, 197, 94, 0.28);
        border-radius: 3px;
        padding: 0 2px;
      }
      #ola-context-preview {
        flex: 1;
        min-height: 80px;
        resize: none;
        line-height: 1.35;
      }
      .ola-chat-log {
        flex: 1;
        min-height: 120px;
        overflow: auto;
        border: 1px solid #243347;
        background: #05090f;
        border-radius: 8px;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ola-chat-line {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 5px 6px;
        border-radius: 6px;
        font-size: 12px;
        line-height: 1.35;
      }
      .ola-chat-line.user {
        border: 1px solid #294061;
        background: #0d1d32;
      }
      .ola-chat-line.assistant {
        border: 1px solid #36502f;
        background: #101a12;
      }
      .ola-chat-line.system {
        border: 1px solid #5a4427;
        background: #1e1509;
      }
      .ola-chat-line.system.heartbeat {
        border-color: #355176;
        background: #102033;
        animation: ola-heartbeat-pulse 1.2s ease-in-out infinite;
      }
      @keyframes ola-heartbeat-pulse {
        0%, 100% {
          opacity: 0.78;
        }
        50% {
          opacity: 1;
        }
      }
      .ola-meta {
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
        font-size: 11px;
        color: #a8b8d2;
      }
      .ola-meta-main {
        border: 1px solid #2f3f58;
        border-radius: 10px;
        background: #0a0f16;
        padding: 8px;
      }
      .ola-usage-bar {
        height: 8px;
        border-radius: 999px;
        background: #1f2a3a;
        overflow: hidden;
      }
      #ola-usage-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #16a34a 0%, #84cc16 100%);
        transition: width 140ms ease, background-color 140ms ease;
      }
      #ola-usage-fill.warn {
        background: linear-gradient(90deg, #d97706 0%, #f59e0b 100%);
      }
      #ola-usage-fill.danger {
        background: linear-gradient(90deg, #b91c1c 0%, #ef4444 100%);
      }
      .ola-hidden {
        display: none !important;
      }
      #ola-version-warning {
        display: none;
        margin-top: 8px;
        padding: 8px 10px;
        border: 1px solid #7f1d1d;
        border-radius: 8px;
        background: #2b1013;
        color: #ffd7d7;
      }
      #ola-version-warning.show {
        display: block;
      }
      #ola-model-status.error {
        color: #b00020;
      }
      @media (max-width: 980px) {
        #ola-overlay.layout-dock-left,
        #ola-overlay.layout-dock-right {
          left: 12px;
          right: 12px;
          width: auto;
        }
        #ola-overlay.layout-floating {
          left: 12px !important;
          top: 64px !important;
          width: calc(100vw - 24px) !important;
          height: calc(100vh - 76px) !important;
        }
        .ola-workspace {
          grid-template-columns: 1fr;
        }
      }
    `;

    if (HAS_GM_STYLE) {
      GM_addStyle(css);
      return;
    }

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildUI() {
    const overlay = document.createElement('div');
    overlay.id = 'ola-overlay';
    overlay.innerHTML = `
      <div id="ola-panel" role="dialog" aria-label="Overleaf Assist (Codex CLI)">
        <div class="ola-header" id="ola-drag-handle">
          <div class="ola-title-wrap">
            <div class="ola-title">Overleaf Assist Terminal</div>
            <div id="ola-status">Idle</div>
          </div>
          <div class="ola-header-controls">
            <button type="button" id="ola-close" aria-label="Close">x</button>
          </div>
        </div>
        <div class="ola-body">
          <div class="ola-tab-strip" role="tablist" aria-label="Assist Terminal Views">
            <button type="button" id="ola-tab-chat" class="ola-tab is-active" role="tab" aria-selected="true" aria-controls="ola-tab-chat-panel">Chat</button>
            <button type="button" id="ola-tab-settings" class="ola-tab" role="tab" aria-selected="false" aria-controls="ola-tab-settings-panel">Settings</button>
          </div>
          <div id="ola-tab-chat-panel" class="ola-main-panel" role="tabpanel" aria-labelledby="ola-tab-chat" aria-hidden="false">
            <div class="ola-chat-toolbar">
              <button type="button" id="ola-toggle-context" class="secondary">Hide Context</button>
            </div>
            <div class="ola-meta ola-meta-main">
              <div id="ola-model-status"></div>
              <div id="ola-version-warning"></div>
              <div id="ola-usage">Estimated usage: -</div>
              <div class="ola-usage-bar">
                <div id="ola-usage-fill"></div>
              </div>
            </div>
            <div class="ola-workspace">
              <div class="ola-chat-pane">
                <div id="ola-chat-log" class="ola-chat-log"></div>
                <div id="ola-plan-pane" class="ola-plan-pane">
                  <div class="ola-plan-head">
                    <span id="ola-plan-summary">Replace plan: -</span>
                    <div class="ola-plan-actions">
                      <button type="button" id="ola-plan-recompute" class="secondary">Recompute Plan</button>
                      <button type="button" id="ola-plan-apply">Apply Selected</button>
                      <button type="button" id="ola-plan-legacy" class="secondary">Use Legacy Replace</button>
                    </div>
                  </div>
                  <div id="ola-plan-list" class="ola-plan-list"></div>
                </div>
                <label class="ola-label">
                  Message
                  <textarea id="ola-prompt" rows="3" placeholder="Ask Codex to transform or analyze your LaTeX..."></textarea>
                </label>
                <div class="ola-actions">
                  <button type="button" id="ola-run">Run</button>
                  <button type="button" id="ola-clear" class="secondary">Clear Chat</button>
                  <button type="button" id="ola-apply-btn" disabled>Apply Last</button>
                </div>
              </div>
              <div id="ola-context-pane" class="ola-context-pane">
                <div class="ola-context-head">
                  <span>Content Snapshot</span>
                  <button type="button" id="ola-refresh-context" class="secondary">Refresh</button>
                </div>
                <textarea id="ola-context-preview" readonly></textarea>
              </div>
            </div>
          </div>
          <div id="ola-tab-settings-panel" class="ola-settings-panel ola-hidden" role="tabpanel" aria-labelledby="ola-tab-settings" aria-hidden="true">
            <div class="ola-config">
              <div class="ola-row">
                <label>
                  Scope
                  <select id="ola-scope">
                    <option value="auto">Selection else full doc</option>
                    <option value="selection">Selection only</option>
                    <option value="full">Full document</option>
                  </select>
                </label>
                <label>
                  Apply
                  <select id="ola-apply">
                    <option value="smart_replace">Smart Replace (default)</option>
                    <option value="replace">Replace</option>
                    <option value="insert">Insert at cursor</option>
                    <option value="copy">Copy to clipboard</option>
                  </select>
                </label>
                <label>
                  Layout
                  <select id="ola-layout">
                    <option value="dock-left">Dock Left</option>
                    <option value="dock-right">Dock Right</option>
                    <option value="floating">Floating</option>
                    <option value="bottom-console">Bottom Console</option>
                  </select>
                </label>
              </div>
              <div class="ola-row">
                <label style="flex:1; min-width: 220px;">
                  Proxy URL
                  <input id="ola-proxy" type="text" />
                </label>
                <label style="min-width: 150px;">
                  Token Limit
                  <input id="ola-token-limit" type="number" min="1" placeholder="Auto" />
                </label>
                <label style="min-width: 170px;">
                  Timeout (s)
                  <input id="ola-timeout-s" type="number" min="1" step="1" placeholder="Default (180)" />
                </label>
                <div class="ola-actions">
                  <button type="button" id="ola-refresh-models" class="secondary">Refresh Models</button>
                </div>
              </div>
              <div class="ola-row">
                <label style="min-width: 140px;">
                  Model Source
                  <select id="ola-model-mode">
                    <option value="preset">Preset</option>
                    <option value="custom">Custom</option>
                  </select>
                </label>
                <label id="ola-model-preset-wrap" style="flex:1; min-width: 220px;">
                  Model
                  <select id="ola-model-preset">
                    <option value="">Loading models...</option>
                  </select>
                </label>
                <label id="ola-model-custom-wrap" style="flex:1; min-width: 220px;">
                  Custom Model
                  <input id="ola-model-custom" type="text" placeholder="e.g. gpt-5.3-codex" />
                </label>
                <label style="min-width: 180px;">
                  Reasoning Effort
                  <select id="ola-reasoning-effort">
                    <option value="default">Use Codex Default</option>
                  </select>
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const dragHandle = overlay.querySelector('#ola-drag-handle');
    const layoutSelect = overlay.querySelector('#ola-layout');
    const toggleContextBtn = overlay.querySelector('#ola-toggle-context');
    const promptInput = overlay.querySelector('#ola-prompt');
    const chatLog = overlay.querySelector('#ola-chat-log');
    const scopeSelect = overlay.querySelector('#ola-scope');
    const applySelect = overlay.querySelector('#ola-apply');
    const proxyInput = overlay.querySelector('#ola-proxy');
    const tokenLimitInput = overlay.querySelector('#ola-token-limit');
    const timeoutSecondsInput = overlay.querySelector('#ola-timeout-s');
    const refreshModelsBtn = overlay.querySelector('#ola-refresh-models');
    const modelModeSelect = overlay.querySelector('#ola-model-mode');
    const modelPresetWrap = overlay.querySelector('#ola-model-preset-wrap');
    const modelCustomWrap = overlay.querySelector('#ola-model-custom-wrap');
    const modelPresetSelect = overlay.querySelector('#ola-model-preset');
    const modelCustomInput = overlay.querySelector('#ola-model-custom');
    const reasoningEffortSelect = overlay.querySelector('#ola-reasoning-effort');
    const workspaceEl = overlay.querySelector('.ola-workspace');
    const contextPane = overlay.querySelector('#ola-context-pane');
    const contextPreview = overlay.querySelector('#ola-context-preview');
    const refreshContextBtn = overlay.querySelector('#ola-refresh-context');
    const planPane = overlay.querySelector('#ola-plan-pane');
    const planSummary = overlay.querySelector('#ola-plan-summary');
    const planList = overlay.querySelector('#ola-plan-list');
    const planRecomputeBtn = overlay.querySelector('#ola-plan-recompute');
    const planApplyBtn = overlay.querySelector('#ola-plan-apply');
    const planLegacyBtn = overlay.querySelector('#ola-plan-legacy');
    const runBtn = overlay.querySelector('#ola-run');
    const applyBtn = overlay.querySelector('#ola-apply-btn');
    const clearBtn = overlay.querySelector('#ola-clear');
    const tabChatBtn = overlay.querySelector('#ola-tab-chat');
    const tabSettingsBtn = overlay.querySelector('#ola-tab-settings');
    const tabChatPanel = overlay.querySelector('#ola-tab-chat-panel');
    const tabSettingsPanel = overlay.querySelector('#ola-tab-settings-panel');
    const closeBtn = overlay.querySelector('#ola-close');
    const statusEl = overlay.querySelector('#ola-status');
    const modelStatusEl = overlay.querySelector('#ola-model-status');
    const versionWarningEl = overlay.querySelector('#ola-version-warning');
    const usageEl = overlay.querySelector('#ola-usage');
    const usageFill = overlay.querySelector('#ola-usage-fill');

    let isDragging = false;
    let dragStart = null;
    let resizeObserver = null;
    let isRunInFlight = false;
    let activeRunAbort = null;
    let stopRequested = false;

    function syncRunControlButtons() {
      if (isRunInFlight) {
        runBtn.textContent = 'Stop';
        runBtn.classList.add('secondary');
        runBtn.disabled = typeof activeRunAbort !== 'function';
        return;
      }
      runBtn.textContent = 'Run';
      runBtn.classList.remove('secondary');
      runBtn.disabled = false;
    }

    function setActiveRunAbort(abortFn) {
      activeRunAbort = typeof abortFn === 'function' ? abortFn : null;
      syncRunControlButtons();
    }

    function clearActiveRunControl() {
      isRunInFlight = false;
      activeRunAbort = null;
      stopRequested = false;
      syncRunControlButtons();
    }

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.classList.toggle('error', Boolean(isError));
    }

    function setModelStatus(text, isError) {
      modelStatusEl.textContent = text || '';
      modelStatusEl.classList.toggle('error', Boolean(isError));
    }

    function renderVersionWarning() {
      versionWarningEl.textContent = state.versionMismatchMessage || '';
      versionWarningEl.classList.toggle('show', Boolean(state.versionMismatchMessage));
    }

    function promptVersionMismatchIfNeeded() {
      if (!state.versionMismatchMessage || !overlay.classList.contains('open')) {
        return;
      }
      const promptKey = `${SCRIPT_VERSION}::${state.bridgeVersion || ''}`;
      if (!promptKey || state.versionPromptedKey === promptKey) {
        return;
      }
      state.versionPromptedKey = promptKey;
      window.setTimeout(() => {
        window.alert(
          [
            'Overleaf Assist version mismatch detected.',
            '',
            `Desktop bridge version: ${state.bridgeVersion || 'unknown'}`,
            `Userscript version: ${SCRIPT_VERSION}`,
            '',
            'Please update the userscript to match the desktop app.',
          ].join('\n')
        );
      }, 0);
    }

    function syncBridgeVersion(bridgeVersion) {
      const nextBridgeVersion =
        typeof bridgeVersion === 'string' && bridgeVersion.trim() ? bridgeVersion.trim() : '';
      state.bridgeVersion = nextBridgeVersion;
      if (nextBridgeVersion && nextBridgeVersion !== SCRIPT_VERSION) {
        state.versionMismatchMessage = `Update the userscript: desktop bridge is v${nextBridgeVersion}, current script is v${SCRIPT_VERSION}.`;
      } else {
        state.versionMismatchMessage = '';
      }
      renderVersionWarning();
      promptVersionMismatchIfNeeded();
    }

    function clearSessionReconnectTimer() {
      if (state.sessionReconnectTimer) {
        clearTimeout(state.sessionReconnectTimer);
        state.sessionReconnectTimer = null;
      }
    }

    function closeSessionStream() {
      clearSessionReconnectTimer();
      if (state.sessionStreamAbort && typeof state.sessionStreamAbort.close === 'function') {
        try {
          state.sessionStreamAbort.close();
        } catch (err) {
          // ignore subscription close failures
        }
      }
      state.sessionStreamAbort = null;
      state.sessionStreamActiveFor = '';
    }

    function getCurrentProjectIdForUI() {
      const projectId = deriveCurrentProjectId();
      state.currentProjectId = projectId;
      return projectId;
    }

    function setSessionRunningState(isRunning) {
      isRunInFlight = Boolean(isRunning);
      if (isRunInFlight && state.currentSessionId) {
        setActiveRunAbort(() => {
          cancelProjectRun(state.config.proxyUrl, state.currentSessionId).catch(() => {});
        });
        return;
      }
      activeRunAbort = null;
      syncRunControlButtons();
    }

    function applyLastResponseState() {
      if (state.currentSessionStatus === 'running') {
        applyBtn.disabled = true;
      }

      if (state.config.applyMode === 'smart_replace') {
        state.smartReplace.rawResponse = state.lastResponseText;
        const looksLikeEditResponse = hasEditBlockMarkers(state.lastResponseText);
        if (looksLikeEditResponse) {
          const parsed = parseEditBlocks(state.lastResponseText);
          state.smartReplace.blocks = parsed.blocks;
          state.smartReplace.planItems = [];
          state.smartReplace.parseError = parsed.parseError;
          if (!parsed.parseError) {
            recomputeSmartReplacePlan();
          } else {
            renderSmartReplacePlan();
            applyBtn.disabled = true;
          }
          return;
        }
        state.smartReplace.blocks = [];
        state.smartReplace.planItems = [];
        state.smartReplace.parseError = '';
        renderSmartReplacePlan();
        applyBtn.disabled = true;
        return;
      }

      resetSmartReplaceState();
      applyBtn.disabled = state.currentSessionStatus === 'running' || !state.lastResponseText;
    }

    function applySessionSnapshot(snapshot, options) {
      const nextSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;
      const preserveStatus = options && options.preserveStatus;
      if (!nextSnapshot) {
        state.currentSessionId = '';
        state.currentSessionSeq = 0;
        state.currentSessionStatus = 'idle';
        state.currentSessionStatusMessage = '';
        state.currentRunId = '';
        state.chatTurns = [];
        state.lastResponseText = '';
        state.sessionUsage = createEmptySessionUsage();
        renderChat();
        updateUsageUI();
        applyLastResponseState();
        setSessionRunningState(false);
        if (!preserveStatus) {
          setStatus('No stored session for this project.');
        }
        return;
      }

      state.currentSessionId =
        typeof nextSnapshot.session_id === 'string' ? nextSnapshot.session_id : '';
      state.currentSessionSeq = Number.isFinite(Number(nextSnapshot.last_seq))
        ? Math.max(0, Math.floor(Number(nextSnapshot.last_seq)))
        : state.currentSessionSeq;
      state.currentSessionStatus =
        typeof nextSnapshot.status === 'string' && nextSnapshot.status.trim()
          ? nextSnapshot.status.trim()
          : 'idle';
      state.currentSessionStatusMessage =
        typeof nextSnapshot.status_message === 'string' ? nextSnapshot.status_message.trim() : '';
      state.currentRunId =
        typeof nextSnapshot.active_run_id === 'string' ? nextSnapshot.active_run_id : '';
      state.chatTurns = normalizeStoredChatTurns(nextSnapshot.chat_turns);
      state.lastResponseText =
        typeof nextSnapshot.last_response_text === 'string' ? nextSnapshot.last_response_text : '';
      state.sessionUsage = normalizeSessionUsage(nextSnapshot.session_usage);
      renderChat();
      updateUsageUI();
      applyLastResponseState();
      setSessionRunningState(state.currentSessionStatus === 'running');

      if (preserveStatus) {
        return;
      }
      if (state.currentSessionStatus === 'running') {
        setStatus(state.currentSessionStatusMessage || 'Attached to active run.');
      } else if (state.currentSessionStatus === 'completed') {
        setStatus('Restored last run from bridge.');
      } else if (state.currentSessionStatus === 'error') {
        setStatus(state.currentSessionStatusMessage || 'Last run failed.', true);
      } else if (state.currentSessionStatus === 'cancelled') {
        setStatus('Last run was stopped.');
      } else {
        setStatus('Ready');
      }
    }

    function handleSessionEvent(event) {
      if (!event || typeof event !== 'object') {
        return;
      }
      if (event.event === 'session_snapshot') {
        applySessionSnapshot(event.session || null, {
          preserveStatus: false,
        });
        return;
      }
      if (Number.isFinite(Number(event.seq))) {
        const seq = Math.max(0, Math.floor(Number(event.seq)));
        if (seq <= state.currentSessionSeq) {
          return;
        }
        state.currentSessionSeq = seq;
      }
      if (event.session_id && typeof event.session_id === 'string') {
        state.currentSessionId = event.session_id;
      }
      if (event.project_id && typeof event.project_id === 'string') {
        state.currentProjectId = event.project_id;
      }
      if (event.run_id && typeof event.run_id === 'string') {
        state.currentRunId = event.run_id;
      }

      if (event.event === 'run_started') {
        state.currentSessionStatus = 'running';
        state.currentSessionStatusMessage = 'Running Codex...';
        if (typeof event.user_prompt === 'string' && event.user_prompt.trim()) {
          appendChatTurn('user', event.user_prompt);
        }
        setSessionRunningState(true);
        applyBtn.disabled = true;
        setStatus('Running Codex...');
        return;
      }

      if (event.event === 'progress') {
        const stage =
          typeof event.stage === 'string' && event.stage.trim() ? event.stage.trim() : 'progress';
        const message =
          typeof event.message === 'string' && event.message.trim() ? event.message.trim() : stage;
        state.currentSessionStatus = 'running';
        state.currentSessionStatusMessage = message;
        setSessionRunningState(true);
        if (stage === 'running') {
          upsertSystemTurnByTag('heartbeat_running', `[running] ${message}`);
        } else {
          removeSystemTurnByTag('heartbeat_running');
          appendChatTurn('system', `[${stage}] ${message}`);
        }
        setStatus(message);
        return;
      }

      if (event.event === 'summary') {
        removeSystemTurnByTag('heartbeat_running');
        const elapsedMs = Number.isFinite(Number(event.elapsed_ms))
          ? Math.max(0, Math.floor(Number(event.elapsed_ms)))
          : null;
        const usageSummary = event.usage && typeof event.usage === 'object' ? event.usage : null;
        const warningsCount = Number.isFinite(Number(event.warnings_count))
          ? Math.max(0, Math.floor(Number(event.warnings_count)))
          : 0;
        if (usageSummary) {
          const inputTokens = Number.isFinite(Number(usageSummary.input_tokens))
            ? Math.max(0, Math.floor(Number(usageSummary.input_tokens)))
            : 0;
          const cachedInputTokens = Number.isFinite(Number(usageSummary.cached_input_tokens))
            ? Math.max(0, Math.floor(Number(usageSummary.cached_input_tokens)))
            : 0;
          const outputTokens = Number.isFinite(Number(usageSummary.output_tokens))
            ? Math.max(0, Math.floor(Number(usageSummary.output_tokens)))
            : 0;
          const totalTokens = Number.isFinite(Number(usageSummary.total_tokens))
            ? Math.max(0, Math.floor(Number(usageSummary.total_tokens)))
            : inputTokens + outputTokens;
          let summaryText =
            `Run summary: in ${formatNumber(inputTokens)} / cached ${formatNumber(cachedInputTokens)} / out ${formatNumber(outputTokens)} / total ${formatNumber(totalTokens)}`;
          if (warningsCount > 0) {
            summaryText += ` | warnings ${warningsCount}`;
          }
          appendChatTurn('system', summaryText);
        } else if (warningsCount > 0) {
          appendChatTurn('system', `Run summary: warnings ${warningsCount}`);
        }
        if (elapsedMs != null) {
          upsertSystemTurnByTag('heartbeat_done', `[run] Run finished in ${(elapsedMs < 10000 ? (elapsedMs / 1000).toFixed(1) : Math.round(elapsedMs / 1000))}s.`);
        } else {
          upsertSystemTurnByTag('heartbeat_done', '[run] Run finished.');
        }
        return;
      }

      if (event.event === 'result') {
        removeSystemTurnByTag('heartbeat_running');
        state.currentSessionStatus = 'completed';
        state.currentSessionStatusMessage = 'Run completed.';
        state.lastResponseText = typeof event.output_text === 'string' ? event.output_text : '';
        appendChatTurn('assistant', state.lastResponseText || '(empty response)');
        applyLastResponseState();
        setSessionRunningState(false);
        const elapsedMs = Number.isFinite(Number(event.elapsed_ms))
          ? Math.max(0, Math.floor(Number(event.elapsed_ms)))
          : null;
        setStatus(elapsedMs != null ? `Done (${elapsedMs}ms)` : 'Done');
        return;
      }

      if (event.event === 'cancelled') {
        removeSystemTurnByTag('heartbeat_running');
        upsertSystemTurnByTag('heartbeat_done', '[run] Run stopped.');
        state.currentSessionStatus = 'cancelled';
        state.currentSessionStatusMessage = 'Run stopped.';
        appendChatTurn('system', 'Run stopped.');
        applyBtn.disabled = true;
        setSessionRunningState(false);
        setStatus('Stopped');
        return;
      }

      if (event.event === 'error') {
        removeSystemTurnByTag('heartbeat_running');
        upsertSystemTurnByTag('heartbeat_done', '[run] Run failed.');
        state.currentSessionStatus = 'error';
        state.currentSessionStatusMessage =
          typeof event.message === 'string' && event.message.trim()
            ? event.message.trim()
            : 'Request failed';
        appendChatTurn('system', `ERROR: ${state.currentSessionStatusMessage}`);
        applyBtn.disabled = true;
        setSessionRunningState(false);
        setStatus(state.currentSessionStatusMessage, true);
      }
    }

    function ensureSessionStream(sessionId, afterSeq) {
      if (!sessionId) {
        closeSessionStream();
        return;
      }
      if (state.sessionStreamActiveFor === sessionId && state.sessionStreamAbort) {
        return;
      }
      closeSessionStream();
      state.sessionStreamActiveFor = sessionId;
      state.sessionStreamAbort = openNdjsonSubscription(
        deriveSessionEventsUrl(state.config.proxyUrl, sessionId, afterSeq),
        {
          method: 'GET',
          onEvent: handleSessionEvent,
          onError: (error) => {
            if (state.sessionStreamActiveFor !== sessionId) {
              return;
            }
            setStatus(error && error.message ? error.message : 'Session stream disconnected', true);
            closeSessionStream();
            state.sessionReconnectTimer = window.setTimeout(() => {
              if (state.currentSessionId === sessionId) {
                ensureSessionStream(sessionId, state.currentSessionSeq);
              }
            }, 1200);
          },
          onClose: () => {
            if (state.sessionStreamActiveFor !== sessionId) {
              return;
            }
            state.sessionStreamAbort = null;
            state.sessionStreamActiveFor = '';
          },
        }
      );
    }

    async function loadCurrentProjectSession(options) {
      const projectId = getCurrentProjectIdForUI();
      const force = Boolean(options && options.force);
      if (!projectId) {
        return;
      }
      if (!force && state.currentProjectId === projectId && state.currentSessionId) {
        return;
      }
      closeSessionStream();
      state.currentProjectId = projectId;
      try {
        const snapshot = await callProjectSession(state.config.proxyUrl, projectId);
        applySessionSnapshot(snapshot, {
          preserveStatus: Boolean(options && options.preserveStatus),
        });
        if (state.currentSessionId) {
          ensureSessionStream(state.currentSessionId, state.currentSessionSeq);
        }
      } catch (err) {
        if (Number(err && err.status) === 404) {
          applySessionSnapshot(null, {
            preserveStatus: Boolean(options && options.preserveStatus),
          });
          return;
        }
        throw err;
      }
    }

    function setActiveTab(nextTab) {
      const resolvedTab = normalizeActiveTab(nextTab);
      const showSettings = resolvedTab === 'settings';
      tabChatPanel.classList.toggle('ola-hidden', showSettings);
      tabSettingsPanel.classList.toggle('ola-hidden', !showSettings);
      tabChatPanel.setAttribute('aria-hidden', showSettings ? 'true' : 'false');
      tabSettingsPanel.setAttribute('aria-hidden', showSettings ? 'false' : 'true');
      tabChatBtn.classList.toggle('is-active', !showSettings);
      tabSettingsBtn.classList.toggle('is-active', showSettings);
      tabChatBtn.setAttribute('aria-selected', showSettings ? 'false' : 'true');
      tabSettingsBtn.setAttribute('aria-selected', showSettings ? 'true' : 'false');
      state.config.activeTab = resolvedTab;
      writeStoredConfig(state.config);
    }

    function getModelCapabilities(modelId) {
      if (!modelId) {
        return null;
      }
      return state.modelsMeta.models.find((model) => model.id === modelId) || null;
    }

    function estimateTokens(value) {
      if (typeof value !== 'string' || !value) {
        return 0;
      }
      return Math.max(1, Math.ceil(value.length / 4));
    }

    function formatNumber(value) {
      return Number(value || 0).toLocaleString('en-US');
    }

    function getSelectedModel() {
      if (state.config.modelMode === 'custom' || state.modelsMeta.models.length === 0) {
        return modelCustomInput.value.trim();
      }
      const preset = modelPresetSelect.value.trim();
      if (preset) {
        return preset;
      }
      return modelCustomInput.value.trim();
    }

    function getContextLimitTokens() {
      const override = tokenLimitInput.value.trim();
      if (override) {
        const parsed = Number(override);
        if (Number.isFinite(parsed) && parsed > 0) {
          return Math.floor(parsed);
        }
      }
      const model = (getSelectedModel() || state.modelsMeta.default_model || '').toLowerCase();
      if (!model) {
        return DEFAULT_MODEL_CONTEXT_LIMIT;
      }
      if (Object.prototype.hasOwnProperty.call(MODEL_CONTEXT_LIMITS, model)) {
        return MODEL_CONTEXT_LIMITS[model];
      }
      if (model.startsWith('gpt-5')) {
        return 200000;
      }
      return DEFAULT_MODEL_CONTEXT_LIMIT;
    }

    function resolveTimeoutOverrideMs() {
      const raw = timeoutSecondsInput.value.trim();
      if (!raw) {
        return null;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        return null;
      }
      return parsed * 1000;
    }

    function updateUsageUI() {
      const total = state.sessionUsage.estimated_total_tokens;
      const limit = getContextLimitTokens();
      const percent = limit > 0 ? (total / limit) * 100 : 0;
      usageEl.textContent = `Estimated usage: in ${formatNumber(state.sessionUsage.estimated_input_tokens)} / out ${formatNumber(state.sessionUsage.estimated_output_tokens)} / total ${formatNumber(total)} of ${formatNumber(limit)} (${percent.toFixed(1)}%)`;
      usageFill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
      usageFill.classList.toggle('warn', percent >= 85 && percent < 100);
      usageFill.classList.toggle('danger', percent >= 100);
    }

    function renderChat() {
      chatLog.innerHTML = '';
      if (state.chatTurns.length === 0) {
        const emptyLine = document.createElement('div');
        emptyLine.className = 'ola-chat-line system';
        emptyLine.textContent = 'No messages yet. Type a request and run.';
        chatLog.appendChild(emptyLine);
      } else {
        for (const turn of state.chatTurns) {
          const line = document.createElement('div');
          line.className = `ola-chat-line ${turn.role}`;
          if (turn.tag === 'heartbeat_running') {
            line.classList.add('heartbeat');
          }
          const prefix = turn.role === 'assistant' ? '[assistant]' : turn.role === 'user' ? '[user]' : '[system]';
          line.textContent = `${prefix} ${turn.text}`;
          chatLog.appendChild(line);
        }
      }
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function appendChatTurn(role, text) {
      if (typeof text !== 'string' || !text.trim()) {
        return;
      }
      state.chatTurns.push({
        role,
        text: text.trim(),
        ts: Date.now(),
      });
      if (state.chatTurns.length > 120) {
        state.chatTurns.splice(0, state.chatTurns.length - 120);
      }
      renderChat();
    }

    function upsertSystemTurnByTag(tag, text) {
      if (typeof tag !== 'string' || !tag.trim()) {
        return;
      }
      if (typeof text !== 'string' || !text.trim()) {
        return;
      }
      const normalizedTag = tag.trim();
      const normalizedText = text.trim();
      const existingIndex = state.chatTurns.findIndex(
        (turn) => turn.role === 'system' && turn.tag === normalizedTag
      );
      if (existingIndex >= 0) {
        state.chatTurns[existingIndex].text = normalizedText;
        state.chatTurns[existingIndex].ts = Date.now();
      } else {
        state.chatTurns.push({
          role: 'system',
          text: normalizedText,
          tag: normalizedTag,
          ts: Date.now(),
        });
      }
      if (state.chatTurns.length > 120) {
        state.chatTurns.splice(0, state.chatTurns.length - 120);
      }
      renderChat();
    }

    function removeSystemTurnByTag(tag) {
      if (typeof tag !== 'string' || !tag.trim()) {
        return;
      }
      const normalizedTag = tag.trim();
      const index = state.chatTurns.findIndex(
        (turn) => turn.role === 'system' && turn.tag === normalizedTag
      );
      if (index >= 0) {
        state.chatTurns.splice(index, 1);
        renderChat();
      }
    }

    function visualizeCompactText(value, maxLen) {
      if (typeof value !== 'string') {
        return '';
      }
      const flat = value
        .replace(/\r\n/g, '\n')
        .replace(/\t/g, '    ')
        .replace(/\n/g, '⏎');
      if (flat.length <= maxLen) {
        return flat;
      }
      return `${flat.slice(0, Math.max(1, maxLen - 1))}…`;
    }

    function commonPrefixLength(a, b) {
      const max = Math.min(a.length, b.length);
      let i = 0;
      while (i < max && a[i] === b[i]) {
        i += 1;
      }
      return i;
    }

    function commonSuffixLength(a, b, prefixLen) {
      const max = Math.min(a.length, b.length) - prefixLen;
      let i = 0;
      while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) {
        i += 1;
      }
      return i;
    }

    function appendDiffTextSegment(parent, className, text) {
      if (!text) {
        return;
      }
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      parent.appendChild(span);
    }

    function createDiffLine(gutterText, lineClass, prefix, focus, suffix, focusClass) {
      const line = document.createElement('div');
      line.className = `ola-plan-diff-line ${lineClass}`;

      const gutter = document.createElement('span');
      gutter.className = 'ola-plan-diff-gutter';
      gutter.textContent = gutterText;
      line.appendChild(gutter);

      const text = document.createElement('span');
      text.className = 'ola-plan-diff-text';
      appendDiffTextSegment(text, 'ola-plan-diff-ctx', prefix);
      if (focusClass) {
        appendDiffTextSegment(text, focusClass, focus || '∅');
      } else {
        appendDiffTextSegment(text, 'ola-plan-diff-ctx', focus || '∅');
      }
      appendDiffTextSegment(text, 'ola-plan-diff-ctx', suffix);
      line.appendChild(text);
      return line;
    }

    function createCompactDiffPreview(searchText, replaceText) {
      const before = typeof searchText === 'string' ? searchText.replace(/\r\n/g, '\n') : '';
      const after = typeof replaceText === 'string' ? replaceText.replace(/\r\n/g, '\n') : '';
      const preview = document.createElement('div');
      preview.className = 'ola-plan-diff';

      if (before === after) {
        preview.appendChild(
          createDiffLine('=', 'same', '', visualizeCompactText(before, 180), '', '')
        );
        return preview;
      }

      const prefixLen = commonPrefixLength(before, after);
      const suffixLen = commonSuffixLength(before, after, prefixLen);
      const beforeChanged = before.slice(prefixLen, before.length - suffixLen);
      const afterChanged = after.slice(prefixLen, after.length - suffixLen);
      let prefix = before.slice(0, prefixLen);
      let suffix = before.slice(before.length - suffixLen);

      const contextLimit = 36;
      if (prefix.length > contextLimit) {
        prefix = `…${prefix.slice(prefix.length - contextLimit)}`;
      }
      if (suffix.length > contextLimit) {
        suffix = `${suffix.slice(0, contextLimit)}…`;
      }

      const compactPrefix = visualizeCompactText(prefix, 64);
      const compactSuffix = visualizeCompactText(suffix, 64);
      const compactBeforeChanged = visualizeCompactText(beforeChanged, 140);
      const compactAfterChanged = visualizeCompactText(afterChanged, 140);

      preview.appendChild(
        createDiffLine('-', 'old', compactPrefix, compactBeforeChanged, compactSuffix, 'ola-plan-diff-del')
      );
      preview.appendChild(
        createDiffLine('+', 'new', compactPrefix, compactAfterChanged, compactSuffix, 'ola-plan-diff-ins')
      );

      return preview;
    }

    function normalizeBlockBody(value) {
      if (typeof value !== 'string') {
        return '';
      }
      let result = value.replace(/\r\n/g, '\n');
      if (result.startsWith('\n')) {
        result = result.slice(1);
      }
      if (result.endsWith('\n')) {
        result = result.slice(0, -1);
      }
      return result;
    }

  function parseEditBlocks(rawText) {
      const raw = typeof rawText === 'string' ? rawText : '';
      const startMarker = '<<<OVERLEAF_EDIT_BLOCKS>>>';
      const endMarker = '<<<END_OVERLEAF_EDIT_BLOCKS>>>';
      const searchMarker = '<<<SEARCH>>>';
      const replaceMarker = '<<<REPLACE>>>';

      const startIndex = raw.indexOf(startMarker);
      const endIndex = raw.indexOf(endMarker);
      if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
        return {
          blocks: [],
          parseError: 'Smart Replace expected edit blocks but markers were not found.',
        };
      }

      const prefix = raw.slice(0, startIndex).trim();
      const suffix = raw.slice(endIndex + endMarker.length).trim();
      if (prefix || suffix) {
        return {
          blocks: [],
          parseError: 'Smart Replace requires the response to contain only edit blocks.',
        };
      }

      const body = raw
        .slice(startIndex + startMarker.length, endIndex)
        .replace(/\r\n/g, '\n');

      const blocks = [];
      let cursor = 0;
      let blockNumber = 0;

      while (cursor < body.length) {
        while (cursor < body.length && /\s/.test(body[cursor])) {
          cursor += 1;
        }
        if (cursor >= body.length) {
          break;
        }

        if (!body.startsWith(searchMarker, cursor)) {
          return {
            blocks: [],
            parseError: `Unexpected content in edit block section near block ${blockNumber + 1}.`,
          };
        }

        const searchStart = cursor + searchMarker.length;
        const replacePos = body.indexOf(replaceMarker, searchStart);
        if (replacePos === -1) {
          return {
            blocks: [],
            parseError: `Missing <<<REPLACE>>> marker for block ${blockNumber + 1}.`,
          };
        }

        const nextSearchPos = body.indexOf(searchMarker, replacePos + replaceMarker.length);
        const replaceEnd = nextSearchPos === -1 ? body.length : nextSearchPos;

        const searchText = normalizeBlockBody(body.slice(searchStart, replacePos));
        const replaceText = normalizeBlockBody(body.slice(replacePos + replaceMarker.length, replaceEnd));

        if (!searchText.trim()) {
          return {
            blocks: [],
            parseError: `Block ${blockNumber + 1} has empty SEARCH content.`,
          };
        }

        blocks.push({
          id: `block_${blockNumber + 1}`,
          search: searchText,
          replace: replaceText,
        });

        blockNumber += 1;
        cursor = replaceEnd;
      }

      if (blocks.length === 0) {
        return {
          blocks: [],
          parseError: 'No valid edit blocks were found.',
        };
      }

      return {
        blocks,
        parseError: '',
      };
    }

    function hasEditBlockMarkers(rawText) {
      const raw = typeof rawText === 'string' ? rawText : '';
      if (!raw) {
        return false;
      }
      return (
        raw.includes('<<<OVERLEAF_EDIT_BLOCKS>>>') ||
        raw.includes('<<<END_OVERLEAF_EDIT_BLOCKS>>>') ||
        raw.includes('<<<SEARCH>>>') ||
        raw.includes('<<<REPLACE>>>')
      );
    }

    function buildLineIndex(text) {
      const starts = [0];
      for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '\n') {
          starts.push(i + 1);
        }
      }
      return starts;
    }

    function offsetToLine(lineStarts, offset) {
      let low = 0;
      let high = lineStarts.length - 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        if (lineStarts[mid] <= offset) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return high + 1;
    }

    function collectCandidates(docText, search) {
      const candidates = [];
      if (!search) {
        return candidates;
      }
      const lineStarts = buildLineIndex(docText);
      let index = docText.indexOf(search);
      while (index !== -1) {
        const from = index;
        const to = index + search.length;
        const startLine = offsetToLine(lineStarts, from);
        const endLine = offsetToLine(lineStarts, Math.max(from, to - 1));
        candidates.push({
          from,
          to,
          startLine,
          endLine,
          matchedText: docText.slice(from, to),
        });
        index = docText.indexOf(search, index + 1);
      }
      return candidates;
    }

    function createPlanItems(blocks, docText, previousPlanItems) {
      const previousById = new Map();
      if (Array.isArray(previousPlanItems)) {
        for (const prev of previousPlanItems) {
          previousById.set(prev.blockId, prev);
        }
      }

      const items = [];
      for (const block of blocks) {
        const candidates = collectCandidates(docText, block.search);
        let status = 'missing';
        if (candidates.length === 1) {
          status = 'resolved';
        } else if (candidates.length > 1) {
          status = 'ambiguous';
        }

        const prev = previousById.get(block.id);
        let selectedCandidateIndex = status === 'resolved' ? 0 : -1;
        if (prev && Number.isInteger(prev.selectedCandidateIndex) && prev.selectedCandidateIndex >= 0 && prev.selectedCandidateIndex < candidates.length) {
          selectedCandidateIndex = prev.selectedCandidateIndex;
        }

        let enabled = status !== 'missing';
        if (prev && typeof prev.enabled === 'boolean') {
          enabled = prev.enabled && status !== 'missing';
        }

        items.push({
          blockId: block.id,
          status,
          candidates,
          selectedCandidateIndex,
          enabled,
        });
      }
      return items;
    }

    function summarizePlanItems(planItems) {
      const summary = {
        resolved: 0,
        ambiguous: 0,
        missing: 0,
        enabled: 0,
      };
      for (const item of planItems) {
        if (item.status === 'resolved') {
          summary.resolved += 1;
        } else if (item.status === 'ambiguous') {
          summary.ambiguous += 1;
        } else {
          summary.missing += 1;
        }
        if (item.enabled) {
          summary.enabled += 1;
        }
      }
      return summary;
    }

    function getSelectedPlanCandidates(planItems, blocks) {
      const blockById = new Map(blocks.map((block) => [block.id, block]));
      const selected = [];
      for (const item of planItems) {
        if (!item.enabled) {
          continue;
        }
        if (item.status === 'missing') {
          return { error: `Block ${item.blockId} has no match in current document.` };
        }
        if (!Number.isInteger(item.selectedCandidateIndex) || item.selectedCandidateIndex < 0 || item.selectedCandidateIndex >= item.candidates.length) {
          return { error: `Block ${item.blockId} has no selected candidate.` };
        }
        const candidate = item.candidates[item.selectedCandidateIndex];
        if (!candidate) {
          return { error: `Block ${item.blockId} has invalid selected candidate.` };
        }
        const block = blockById.get(item.blockId);
        if (!block) {
          return { error: `Block ${item.blockId} definition was not found.` };
        }
        selected.push({
          blockId: item.blockId,
          block,
          candidate,
        });
      }
      selected.sort((a, b) => a.candidate.from - b.candidate.from);
      for (let i = 1; i < selected.length; i += 1) {
        const prev = selected[i - 1].candidate;
        const cur = selected[i].candidate;
        if (cur.from < prev.to) {
          return { error: 'Selected replacement ranges overlap. Disable one conflicting block or choose different candidates.' };
        }
      }
      return { selected };
    }

    function renderSmartReplacePlan() {
      const applyMode = state.config.applyMode;
      const isSmart = applyMode === 'smart_replace';
      const hasBlocks =
        Array.isArray(state.smartReplace.blocks) && state.smartReplace.blocks.length > 0;
      const showPlan = isSmart && hasBlocks;
      planPane.classList.toggle('ola-hidden', !showPlan);
      if (!isSmart) {
        applyBtn.disabled = !state.lastResponseText;
        return;
      }

      if (!hasBlocks) {
        applyBtn.disabled = true;
        planApplyBtn.disabled = true;
        planRecomputeBtn.disabled = true;
        planLegacyBtn.disabled = true;
        return;
      }

      let canApply = true;
      let blockingReason = '';

      planApplyBtn.disabled = false;
      planRecomputeBtn.disabled = false;
      planLegacyBtn.disabled = false;

      if (state.smartReplace.parseError) {
        planSummary.textContent = `Replace plan: parse error - ${state.smartReplace.parseError}`;
        planApplyBtn.disabled = true;
        canApply = false;
        blockingReason = state.smartReplace.parseError;
      } else {
        const summary = summarizePlanItems(state.smartReplace.planItems);
        planSummary.textContent = `Replace plan: ${summary.resolved} resolved / ${summary.ambiguous} ambiguous / ${summary.missing} missing (enabled ${summary.enabled})`;
        if (summary.enabled === 0) {
          planApplyBtn.disabled = true;
          canApply = false;
          blockingReason = 'No enabled blocks.';
        } else {
          const selectedResult = getSelectedPlanCandidates(
            state.smartReplace.planItems,
            state.smartReplace.blocks
          );
          if (selectedResult.error) {
            planApplyBtn.disabled = true;
            canApply = false;
            blockingReason = selectedResult.error;
          }
        }
      }
      applyBtn.disabled = !canApply;

      planList.innerHTML = '';

      if (state.smartReplace.parseError) {
        const row = document.createElement('div');
        row.className = 'ola-plan-item';
        row.textContent = state.smartReplace.parseError;
        planList.appendChild(row);
        return;
      }

      const blockById = new Map(state.smartReplace.blocks.map((block) => [block.id, block]));
      for (const item of state.smartReplace.planItems) {
        const block = blockById.get(item.blockId);
        const row = document.createElement('div');
        row.className = 'ola-plan-item';

        const head = document.createElement('div');
        head.className = 'ola-plan-item-head';
        const left = document.createElement('label');
        left.style.display = 'flex';
        left.style.alignItems = 'center';
        left.style.gap = '6px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = Boolean(item.enabled);
        checkbox.disabled = item.status === 'missing';
        checkbox.addEventListener('change', () => {
          item.enabled = checkbox.checked;
          syncConfigFromUI();
          renderSmartReplacePlan();
        });
        left.appendChild(checkbox);
        const blockTitle = document.createElement('span');
        blockTitle.textContent = item.blockId;
        left.appendChild(blockTitle);
        head.appendChild(left);

        const status = document.createElement('span');
        status.className = `ola-plan-status ${item.status}`;
        if (item.status === 'resolved') {
          const candidate = item.candidates[item.selectedCandidateIndex];
          status.textContent = candidate
            ? `resolved L${candidate.startLine}-${candidate.endLine}`
            : 'resolved';
        } else if (item.status === 'ambiguous') {
          status.textContent = `ambiguous (${item.candidates.length} matches)`;
        } else {
          status.textContent = 'missing';
        }
        head.appendChild(status);
        row.appendChild(head);

        if (item.status === 'ambiguous' && item.candidates.length > 0) {
          const selectorWrap = document.createElement('label');
          selectorWrap.textContent = 'Candidate';
          selectorWrap.style.display = 'flex';
          selectorWrap.style.flexDirection = 'column';
          selectorWrap.style.gap = '4px';
          const candidateSelect = document.createElement('select');
          const placeholder = document.createElement('option');
          placeholder.value = '-1';
          placeholder.textContent = 'Select candidate';
          candidateSelect.appendChild(placeholder);
          item.candidates.forEach((candidate, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = `L${candidate.startLine}-${candidate.endLine}`;
            candidateSelect.appendChild(option);
          });
          candidateSelect.value = String(
            Number.isInteger(item.selectedCandidateIndex) ? item.selectedCandidateIndex : -1
          );
          candidateSelect.addEventListener('change', () => {
            item.selectedCandidateIndex = Number(candidateSelect.value);
            renderSmartReplacePlan();
          });
          selectorWrap.appendChild(candidateSelect);
          row.appendChild(selectorWrap);
        }

        const preview = document.createElement('div');
        preview.className = 'ola-plan-preview';
        const searchPreview = block ? block.search : '';
        const replacePreview = block ? block.replace : '';
        const diffTitle = document.createElement('div');
        diffTitle.textContent = `Diff preview (${searchPreview.length} -> ${replacePreview.length} chars)`;
        preview.appendChild(diffTitle);
        preview.appendChild(createCompactDiffPreview(searchPreview, replacePreview));
        row.appendChild(preview);
        planList.appendChild(row);
      }

      if (!canApply && blockingReason) {
        planSummary.textContent = `${planSummary.textContent} | blocked: ${blockingReason}`;
      }
    }

    function recomputeSmartReplacePlan() {
      if (state.smartReplace.parseError) {
        renderSmartReplacePlan();
        return false;
      }
      const view = findFocusedView();
      if (!view || !view.state) {
        setStatus('Editor not found', true);
        return false;
      }
      const docText = view.state.doc.toString();
      state.smartReplace.planItems = createPlanItems(
        state.smartReplace.blocks,
        docText,
        state.smartReplace.planItems
      );
      renderSmartReplacePlan();
      return true;
    }

    function refreshApplyModeUI() {
      const isSmart = state.config.applyMode === 'smart_replace';
      applyBtn.textContent = isSmart ? 'Apply Selected' : 'Apply Last';
      planApplyBtn.disabled = !isSmart;
      planRecomputeBtn.disabled = !isSmart;
      planLegacyBtn.disabled = !isSmart;
      if (!isSmart) {
        applyBtn.disabled = !state.lastResponseText;
      }
      renderSmartReplacePlan();
    }

    function resetSmartReplaceState() {
      state.smartReplace = {
        rawResponse: '',
        blocks: [],
        planItems: [],
        parseError: '',
      };
      renderSmartReplacePlan();
    }

    function buildPromptWithHistory(userPrompt) {
      const maxTurns = Math.max(1, state.config.chatMemoryTurns || 12);
      const history = state.chatTurns
        .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
        .slice(-maxTurns);
      const lines = [];

      if (history.length > 0) {
        lines.push('Conversation history:');
        for (const turn of history) {
          lines.push(`${turn.role === 'assistant' ? 'Assistant' : 'User'}: ${turn.text}`);
        }
        lines.push('');
      }

      lines.push(`User: ${userPrompt}`);
      if (state.config.applyMode === 'smart_replace') {
        lines.push('If the user asks for explanation, Q&A, or planning, reply normally in plain text.');
        lines.push('If the user asks to change document content, return ONLY structured edit blocks in this exact format:');
        lines.push('<<<OVERLEAF_EDIT_BLOCKS>>>');
        lines.push('<<<SEARCH>>>');
        lines.push('<exact snippet from provided content>');
        lines.push('<<<REPLACE>>>');
        lines.push('<replacement snippet>');
        lines.push('<<<SEARCH>>>');
        lines.push('<exact snippet from provided content>');
        lines.push('<<<REPLACE>>>');
        lines.push('<replacement snippet>');
        lines.push('<<<END_OVERLEAF_EDIT_BLOCKS>>>');
        lines.push('Rules for edit blocks: no prose outside markers, no markdown fences; SEARCH must be exact; REPLACE may be empty to delete.');
      } else {
        lines.push('Return only the final text to apply. Do not include markdown fences or explanations.');
      }

      let composed = lines.join('\n');
      if (composed.length > 24000) {
        composed = composed.slice(composed.length - 24000);
      }
      return composed;
    }

    function applyLayout() {
      overlay.classList.remove('layout-dock-left', 'layout-dock-right', 'layout-floating', 'layout-bottom-console');
      overlay.classList.add(`layout-${state.config.layoutMode}`);

      overlay.style.left = '';
      overlay.style.top = '';
      overlay.style.right = '';
      overlay.style.bottom = '';
      overlay.style.width = '';
      overlay.style.height = '';
      overlay.style.resize = 'none';
      overlay.style.overflow = 'visible';

      if (state.config.layoutMode === 'floating') {
        overlay.style.left = `${Math.max(8, state.config.floatingX)}px`;
        overlay.style.top = `${Math.max(8, state.config.floatingY)}px`;
        overlay.style.width = `${Math.max(380, state.config.floatingWidth)}px`;
        overlay.style.height = `${Math.max(320, state.config.floatingHeight)}px`;
        overlay.style.resize = 'both';
        overlay.style.overflow = 'hidden';
      } else if (state.config.layoutMode === 'dock-left') {
        overlay.style.top = '72px';
        overlay.style.left = '16px';
        overlay.style.bottom = '16px';
        overlay.style.width = `${Math.max(360, state.config.dockWidth)}px`;
      } else if (state.config.layoutMode === 'dock-right') {
        overlay.style.top = '72px';
        overlay.style.right = '16px';
        overlay.style.bottom = '16px';
        overlay.style.width = `${Math.max(360, state.config.dockWidth)}px`;
      } else {
        overlay.style.left = '16px';
        overlay.style.right = '16px';
        overlay.style.bottom = '16px';
        overlay.style.height = `${Math.max(220, state.config.consoleHeight)}px`;
      }
    }

    function persistGeometryFromElement() {
      if (!overlay.classList.contains('open')) {
        return;
      }
      const rect = overlay.getBoundingClientRect();
      if (state.config.layoutMode === 'floating') {
        state.config.floatingX = Math.round(rect.left);
        state.config.floatingY = Math.round(rect.top);
        state.config.floatingWidth = Math.round(rect.width);
        state.config.floatingHeight = Math.round(rect.height);
      } else if (state.config.layoutMode === 'dock-left' || state.config.layoutMode === 'dock-right') {
        state.config.dockWidth = Math.round(rect.width);
      } else if (state.config.layoutMode === 'bottom-console') {
        state.config.consoleHeight = Math.round(rect.height);
      }
      writeStoredConfig(state.config);
    }

    function setContextPaneVisibility() {
      contextPane.classList.toggle('ola-hidden', !state.config.showContextPane);
      workspaceEl.classList.toggle('context-hidden', !state.config.showContextPane);
      toggleContextBtn.textContent = state.config.showContextPane ? 'Hide Context' : 'Show Context';
    }

    function resolveContentSnapshot() {
      const view = findFocusedView();
      if (!view || !view.state) {
        throw new Error('Editor not found');
      }

      const selection = view.state.selection.main;
      const selectionText = selection.empty ? '' : view.state.sliceDoc(selection.from, selection.to);
      const scope = state.config.scope;
      let content = '';
      let usedSelection = false;
      let sourceLabel = 'Full document';

      if (scope === 'auto') {
        if (!selection.empty) {
          content = selectionText;
          usedSelection = true;
          sourceLabel = 'Auto -> Selection';
        } else {
          content = view.state.doc.toString();
          sourceLabel = 'Auto -> Full document';
        }
      } else if (scope === 'selection') {
        content = selectionText;
        usedSelection = !selection.empty;
        sourceLabel = 'Selection only';
      } else {
        content = view.state.doc.toString();
        sourceLabel = 'Full document';
      }

      return {
        content,
        usedSelection,
        scope,
        sourceLabel,
        estimatedTokens: estimateTokens(content),
        updatedAt: Date.now(),
      };
    }

    function renderContextSnapshot(snapshot) {
      const updated = new Date(snapshot.updatedAt || Date.now()).toLocaleTimeString();
      const prefix = [
        `Source: ${snapshot.sourceLabel}`,
        `Estimated tokens: ${formatNumber(snapshot.estimatedTokens)}`,
        `Updated: ${updated}`,
        '',
      ].join('\n');
      contextPreview.value = `${prefix}${snapshot.content || ''}`;
    }

    function refreshContextSnapshot() {
      try {
        const snapshot = resolveContentSnapshot();
        state.lastContextSnapshot = snapshot;
        renderContextSnapshot(snapshot);
      } catch (err) {
        contextPreview.value = `Context unavailable: ${err.message || 'Editor not found'}`;
      }
    }

    function scheduleContextPreviewRefresh() {
      if (state.previewTimer) {
        clearTimeout(state.previewTimer);
      }
      state.previewTimer = window.setTimeout(() => {
        refreshContextSnapshot();
      }, 250);
    }

    function refreshModelModeVisibility() {
      const hasPresetOptions = state.modelsMeta.models.length > 0;
      modelModeSelect.value = state.config.modelMode;
      const usePreset = state.config.modelMode === 'preset' && hasPresetOptions;
      modelPresetWrap.classList.toggle('ola-hidden', !usePreset);
      modelCustomWrap.classList.toggle('ola-hidden', usePreset);
    }

    function refreshReasoningEffortOptions() {
      const mode = state.config.modelMode;
      const selectedModelId = mode === 'preset' ? modelPresetSelect.value.trim() : '';
      const modelCapabilities = getModelCapabilities(selectedModelId);
      const available = ['default'];

      if (modelCapabilities && Array.isArray(modelCapabilities.supported_reasoning_levels) && modelCapabilities.supported_reasoning_levels.length > 0) {
        for (const effort of modelCapabilities.supported_reasoning_levels) {
          if (!available.includes(effort)) {
            available.push(effort);
          }
        }
      } else {
        for (const effort of FALLBACK_REASONING_EFFORTS) {
          if (!available.includes(effort)) {
            available.push(effort);
          }
        }
      }

      const previousValue = normalizeReasoningEffort(state.config.reasoningEffort);
      reasoningEffortSelect.innerHTML = '';
      for (const effort of available) {
        const opt = document.createElement('option');
        opt.value = effort;
        if (effort === 'default') {
          opt.textContent = 'Use Codex Default';
        } else {
          opt.textContent = effort;
        }
        reasoningEffortSelect.appendChild(opt);
      }

      state.config.reasoningEffort = available.includes(previousValue) ? previousValue : 'default';
      reasoningEffortSelect.value = state.config.reasoningEffort;
    }

    function refreshModelPresetOptions() {
      const previousValue = state.config.presetModel || '';
      modelPresetSelect.innerHTML = '';

      if (state.modelsMeta.models.length === 0) {
        const opt = document.createElement('option');
        opt.value = previousValue;
        opt.textContent = 'No models available';
        modelPresetSelect.appendChild(opt);
        modelPresetSelect.value = previousValue;
        return;
      }

      for (const model of state.modelsMeta.models) {
        const opt = document.createElement('option');
        opt.value = model.id;
        opt.textContent = model.description ? `${model.id} - ${model.description}` : model.id;
        modelPresetSelect.appendChild(opt);
      }

      const hasExplicitSelection = Boolean(state.config.presetModel || state.config.customModel);
      let selectedValue = previousValue;

      if (!selectedValue && !hasExplicitSelection && state.modelsMeta.default_model) {
        selectedValue = state.modelsMeta.default_model;
      }

      if (!state.modelsMeta.models.some((model) => model.id === selectedValue)) {
        selectedValue = state.modelsMeta.default_model && state.modelsMeta.models.some((model) => model.id === state.modelsMeta.default_model)
          ? state.modelsMeta.default_model
          : state.modelsMeta.models[0].id;
      }

      modelPresetSelect.value = selectedValue;
      state.config.presetModel = selectedValue;
    }

    function syncConfigFromUI() {
      state.config.scope = scopeSelect.value;
      state.config.applyMode = normalizeApplyMode(applySelect.value);
      state.config.proxyUrl = proxyInput.value.trim() || DEFAULT_CONFIG.proxyUrl;
      state.config.layoutMode = normalizeLayoutMode(layoutSelect.value);
      state.config.activeTab = tabSettingsPanel.classList.contains('ola-hidden')
        ? 'chat'
        : 'settings';
      state.config.modelMode = normalizeModelMode(modelModeSelect.value);
      const presetModelValue = modelPresetSelect.value.trim();
      if (state.modelsMeta.models.length > 0) {
        state.config.presetModel = presetModelValue;
      } else if (presetModelValue) {
        state.config.presetModel = presetModelValue;
      }
      state.config.customModel = modelCustomInput.value.trim();
      state.config.reasoningEffort = normalizeReasoningEffort(reasoningEffortSelect.value);
      state.config.showContextPane = !contextPane.classList.contains('ola-hidden');
      state.config.tokenLimitOverride = tokenLimitInput.value.trim();
      state.config.timeoutSecondsOverride = timeoutSecondsInput.value.trim();
      writeStoredConfig(state.config);
    }

    function summarizeDoctorIssues(doctor) {
      const issueMap = {
        codex_missing: 'Codex CLI not found',
        codex_not_logged_in: 'Codex login required',
        network_blocked: 'Network blocked to api.openai.com',
        port_in_use: 'Port 8787 already in use',
      };
      const issues = doctor && Array.isArray(doctor.issues) ? doctor.issues : [];
      if (issues.length === 0) {
        return '';
      }
      return issues.map((issue) => issueMap[issue] || issue).join('; ');
    }

    async function probeBridgeReadiness(showSuccessStatus) {
      const currentProxyUrl = proxyInput.value.trim() || state.config.proxyUrl || DEFAULT_CONFIG.proxyUrl;
      const healthUrl = deriveHealthUrl(currentProxyUrl);
      const doctorUrl = deriveDoctorUrl(currentProxyUrl);
      try {
        const health = await callHealth(healthUrl);
        if (!health || health.ok !== true) {
          throw new Error('Bridge health probe failed');
        }
        syncBridgeVersion(health.version);

        if (health.codex_ready !== true) {
          let detail = '';
          try {
            const doctor = await callDoctor(doctorUrl);
            detail = summarizeDoctorIssues(doctor);
          } catch (err) {
            detail = '';
          }
          setStatus(
            detail
              ? `Install/start Overleaf Assist App: ${detail}`
              : 'Install/start Overleaf Assist App and complete Codex setup',
            true
          );
          return false;
        }

        if (showSuccessStatus) {
          setStatus(
            typeof GM_xmlhttpRequest === 'function'
              ? 'Ready (GM request)'
              : 'Ready (fetch fallback)'
          );
        }
        return true;
      } catch (err) {
        setStatus('Overleaf Assist App not running on http://localhost:8787', true);
        return false;
      }
    }

    async function refreshModelsMetadata(quiet) {
      const currentProxyUrl = proxyInput.value.trim() || state.config.proxyUrl || DEFAULT_CONFIG.proxyUrl;
      const modelsUrl = deriveModelsUrl(currentProxyUrl);
      state.modelsUrl = modelsUrl;

      if (!quiet) {
        setStatus('Loading models...');
      }

      try {
        const meta = normalizeModelsMeta(await callModels(modelsUrl));
        state.modelsMeta = meta;
        state.modelsMetaError = '';
        if (meta.source === 'models_cache') {
          setModelStatus(`Model capabilities loaded (${meta.models.length})`);
        } else {
          setModelStatus('model capabilities unavailable', true);
        }
      } catch (err) {
        state.modelsMeta = createFallbackModelsMeta();
        state.modelsMetaError = err.message || 'Failed to load model metadata';
        setModelStatus('model capabilities unavailable', true);
      }

      refreshModelPresetOptions();
      refreshModelModeVisibility();
      refreshReasoningEffortOptions();
      syncConfigFromUI();
      await probeBridgeReadiness(!quiet);
      updateUsageUI();
    }

    function open() {
      if (!findFocusedView()) {
        overlay.classList.remove('open');
        return false;
      }
      scopeSelect.value = state.config.scope || DEFAULT_CONFIG.scope;
      applySelect.value = normalizeApplyMode(state.config.applyMode || DEFAULT_CONFIG.applyMode);
      layoutSelect.value = state.config.layoutMode || DEFAULT_CONFIG.layoutMode;
      proxyInput.value = state.config.proxyUrl || DEFAULT_CONFIG.proxyUrl;
      modelModeSelect.value = state.config.modelMode || DEFAULT_CONFIG.modelMode;
      modelCustomInput.value = state.config.customModel || '';
      tokenLimitInput.value = state.config.tokenLimitOverride || '';
      timeoutSecondsInput.value = state.config.timeoutSecondsOverride || '';
      overlay.classList.add('open');
      setActiveTab(state.config.activeTab || 'chat');
      applyLayout();
      setContextPaneVisibility();
      promptInput.focus();
      renderChat();
      refreshModelPresetOptions();
      refreshModelModeVisibility();
      refreshReasoningEffortOptions();
      refreshApplyModeUI();
      setStatus('Checking local app...');
      renderVersionWarning();
      promptVersionMismatchIfNeeded();
      updateUsageUI();
      refreshContextSnapshot();
      refreshModelsMetadata(true);
      loadCurrentProjectSession({
        force: true,
        preserveStatus: true,
      }).catch((err) => {
        setStatus(err.message || 'Failed to load project session', true);
      });
      return true;
    }

    function close() {
      overlay.classList.remove('open');
      syncConfigFromUI();
    }

    tabChatBtn.addEventListener('click', () => {
      setActiveTab('chat');
      syncConfigFromUI();
    });

    tabSettingsBtn.addEventListener('click', () => {
      setActiveTab('settings');
      syncConfigFromUI();
    });

    closeBtn.addEventListener('click', close);

    clearBtn.addEventListener('click', () => {
      promptInput.value = '';
      state.chatTurns = [];
      state.lastResponseText = '';
      resetSmartReplaceState();
      state.sessionUsage = createEmptySessionUsage();
      renderChat();
      updateUsageUI();
      applyBtn.disabled = true;
      setStatus('Cleared local view. Stored bridge session can still be restored.');
    });

    function requestStopCurrentRun() {
      if (!isRunInFlight || typeof activeRunAbort !== 'function') {
        return;
      }
      removeSystemTurnByTag('heartbeat_running');
      upsertSystemTurnByTag('heartbeat_done', '[run] Stopping...');
      setStatus('Stopping...');
      try {
        activeRunAbort();
      } catch (err) {
        // ignore abort handler failures
      }
      activeRunAbort = null;
      syncRunControlButtons();
    }

    applySelect.addEventListener('change', () => {
      state.config.applyMode = normalizeApplyMode(applySelect.value);
      refreshApplyModeUI();
      syncConfigFromUI();
    });

    layoutSelect.addEventListener('change', () => {
      state.config.layoutMode = normalizeLayoutMode(layoutSelect.value);
      applyLayout();
      syncConfigFromUI();
    });

    toggleContextBtn.addEventListener('click', () => {
      state.config.showContextPane = !state.config.showContextPane;
      setContextPaneVisibility();
      syncConfigFromUI();
    });

    modelModeSelect.addEventListener('change', () => {
      state.config.modelMode = normalizeModelMode(modelModeSelect.value);
      refreshModelModeVisibility();
      refreshReasoningEffortOptions();
      updateUsageUI();
      syncConfigFromUI();
    });

    modelPresetSelect.addEventListener('change', () => {
      const nextPreset = modelPresetSelect.value.trim();
      if (state.modelsMeta.models.length > 0 || nextPreset) {
        state.config.presetModel = nextPreset;
      }
      refreshReasoningEffortOptions();
      updateUsageUI();
      syncConfigFromUI();
    });

    modelCustomInput.addEventListener('input', () => {
      syncConfigFromUI();
    });

    reasoningEffortSelect.addEventListener('change', () => {
      syncConfigFromUI();
    });

    scopeSelect.addEventListener('change', () => {
      syncConfigFromUI();
      scheduleContextPreviewRefresh();
    });

    tokenLimitInput.addEventListener('change', () => {
      syncConfigFromUI();
      updateUsageUI();
    });

    timeoutSecondsInput.addEventListener('change', () => {
      syncConfigFromUI();
    });

    proxyInput.addEventListener('change', () => {
      syncConfigFromUI();
      refreshModelsMetadata(true);
      scheduleContextPreviewRefresh();
    });

    refreshModelsBtn.addEventListener('click', () => {
      syncConfigFromUI();
      refreshModelsMetadata(false);
    });

    refreshContextBtn.addEventListener('click', () => {
      refreshContextSnapshot();
    });

    planRecomputeBtn.addEventListener('click', () => {
      if (state.config.applyMode !== 'smart_replace') {
        return;
      }
      if (recomputeSmartReplacePlan()) {
        setStatus('Replace plan recomputed');
      }
    });

    planApplyBtn.addEventListener('click', async () => {
      if (state.config.applyMode !== 'smart_replace') {
        return;
      }
      await handleApply();
    });

    planLegacyBtn.addEventListener('click', () => {
      state.config.applyMode = 'replace';
      applySelect.value = 'replace';
      refreshApplyModeUI();
      syncConfigFromUI();
      setStatus('Switched to legacy Replace mode');
    });

    dragHandle.addEventListener('mousedown', (event) => {
      if (state.config.layoutMode !== 'floating') {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      if (event.target.closest('button,select,input,textarea')) {
        return;
      }
      isDragging = true;
      dragStart = {
        x: event.clientX,
        y: event.clientY,
        left: overlay.offsetLeft,
        top: overlay.offsetTop,
      };
      overlay.classList.add('dragging');
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!isDragging || !dragStart) {
        return;
      }
      const dx = event.clientX - dragStart.x;
      const dy = event.clientY - dragStart.y;
      const nextLeft = Math.max(4, dragStart.left + dx);
      const nextTop = Math.max(4, dragStart.top + dy);
      overlay.style.left = `${nextLeft}px`;
      overlay.style.top = `${nextTop}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) {
        return;
      }
      isDragging = false;
      dragStart = null;
      overlay.classList.remove('dragging');
      persistGeometryFromElement();
    });

    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        persistGeometryFromElement();
      });
      resizeObserver.observe(overlay);
    }

    document.addEventListener('selectionchange', () => {
      if (!overlay.classList.contains('open')) {
        return;
      }
      scheduleContextPreviewRefresh();
    });
    document.addEventListener('keyup', () => {
      if (!overlay.classList.contains('open')) {
        return;
      }
      scheduleContextPreviewRefresh();
    });
    document.addEventListener('mouseup', () => {
      if (!overlay.classList.contains('open')) {
        return;
      }
      scheduleContextPreviewRefresh();
    });

    async function handleRun() {
      if (isRunInFlight) {
        setStatus('Run already in progress');
        return;
      }
      syncConfigFromUI();
      setStatus('Preparing...');

      const prompt = promptInput.value.trim();
      if (!prompt) {
        setStatus('Prompt is required', true);
        return;
      }

      const bridgeReady = await probeBridgeReadiness(false);
      if (!bridgeReady) {
        return;
      }

      let snapshot = null;

      try {
        snapshot = resolveContentSnapshot();
      } catch (err) {
        setStatus(err.message || 'Failed to read editor state', true);
        return;
      }

      if (!snapshot.content) {
        setStatus('No content to send', true);
        return;
      }

      state.lastContextSnapshot = snapshot;
      renderContextSnapshot(snapshot);
      const composedPrompt = buildPromptWithHistory(prompt);
      applyBtn.disabled = true;
      setStatus('Sending...');
      try {
        const projectId = getCurrentProjectIdForUI();
        const payload = {
          prompt: composedPrompt,
          user_prompt: prompt,
          content: snapshot.content,
          scope: snapshot.scope,
          model: getSelectedModel(),
          reasoning_effort: normalizeReasoningEffort(state.config.reasoningEffort),
          used_selection: snapshot.usedSelection,
        };
        const timeoutOverrideMs = resolveTimeoutOverrideMs();
        if (timeoutOverrideMs) {
          payload.timeout_ms = timeoutOverrideMs;
        }
        try {
          const result = await startProjectRun(state.config.proxyUrl, projectId, payload);
          promptInput.value = '';
          removeSystemTurnByTag('heartbeat_done');
          removeSystemTurnByTag('heartbeat_running');
          applySessionSnapshot(result.session || null, {
            preserveStatus: true,
          });
          state.currentSessionStatus = 'running';
          state.currentSessionStatusMessage = 'Running Codex...';
          state.currentSessionId =
            typeof result.session_id === 'string' ? result.session_id : state.currentSessionId;
          state.currentRunId = typeof result.run_id === 'string' ? result.run_id : '';
          state.currentSessionSeq = Number.isFinite(Number(result.last_seq))
            ? Math.max(0, Math.floor(Number(result.last_seq)))
            : state.currentSessionSeq;
          setSessionRunningState(true);
          setStatus('Running Codex...');
          if (state.currentSessionId) {
            ensureSessionStream(state.currentSessionId, state.currentSessionSeq);
          }
        } catch (err) {
          if (Number(err && err.status) === 409 && err && err.payload) {
            const payload409 = err.payload;
            applySessionSnapshot(payload409.session || null, {
              preserveStatus: true,
            });
            state.currentSessionId =
              typeof payload409.session_id === 'string'
                ? payload409.session_id
                : state.currentSessionId;
            state.currentRunId =
              typeof payload409.run_id === 'string' ? payload409.run_id : state.currentRunId;
            state.currentSessionSeq = Number.isFinite(Number(payload409.last_seq))
              ? Math.max(0, Math.floor(Number(payload409.last_seq)))
              : state.currentSessionSeq;
            state.currentSessionStatus = 'running';
            state.currentSessionStatusMessage = 'Attached to existing run.';
            setSessionRunningState(true);
            if (state.currentSessionId) {
              ensureSessionStream(state.currentSessionId, state.currentSessionSeq);
            }
            setStatus('Attached to existing run.');
            return;
          }
          throw err;
        }
      } catch (err) {
        setStatus(err.message || 'Request failed', true);
      }
      scheduleContextPreviewRefresh();
    }

    async function handleApply() {
      const text = state.lastResponseText;
      if (!text) {
        setStatus('No response to apply', true);
        return;
      }

      try {
        const view = findFocusedView();
        if (!view || !view.state || typeof view.dispatch !== 'function') {
          setStatus('Editor not found', true);
          return;
        }

        const selection = view.state.selection.main;
        const scope = state.config.scope;
        const applyMode = state.config.applyMode;

        if (applyMode === 'smart_replace') {
          if (state.smartReplace.parseError) {
            setStatus(`Smart replace unavailable: ${state.smartReplace.parseError}`, true);
            return;
          }
          if (!Array.isArray(state.smartReplace.blocks) || state.smartReplace.blocks.length === 0) {
            setStatus('No smart-replace blocks to apply', true);
            return;
          }
          if (!recomputeSmartReplacePlan()) {
            return;
          }

          const selectedResult = getSelectedPlanCandidates(
            state.smartReplace.planItems,
            state.smartReplace.blocks
          );
          if (selectedResult.error) {
            setStatus(selectedResult.error, true);
            renderSmartReplacePlan();
            return;
          }

          const selected = selectedResult.selected;
          if (!Array.isArray(selected) || selected.length === 0) {
            setStatus('No enabled smart-replace blocks selected', true);
            return;
          }

          const changes = selected
            .map((item) => ({
              from: item.candidate.from,
              to: item.candidate.to,
              insert: item.block.replace,
              lineRange: `L${item.candidate.startLine}-${item.candidate.endLine}`,
            }))
            .sort((a, b) => b.from - a.from);

          view.dispatch({
            changes: changes.map((change) => ({
              from: change.from,
              to: change.to,
              insert: change.insert,
            })),
            scrollIntoView: true,
          });

          const lineRanges = changes.map((change) => change.lineRange).join(', ');
          resetSmartReplaceState();
          setStatus(
            `Applied ${changes.length} block${changes.length === 1 ? '' : 's'} (${lineRanges})`
          );
          return;
        }

        if (applyMode === 'copy') {
          try {
            await navigator.clipboard.writeText(text);
            setStatus('Copied to clipboard');
          } catch (err) {
            setStatus('Clipboard failed', true);
          }
          return;
        }

        let from = selection.to;
        let to = selection.to;

        if (applyMode === 'replace') {
          if (scope === 'full' || (scope === 'auto' && selection.empty)) {
            const ok = window.confirm('Replace the entire document?');
            if (!ok) {
              setStatus('Canceled');
              return;
            }
            from = 0;
            to = view.state.doc.length;
          } else if (!selection.empty) {
            from = selection.from;
            to = selection.to;
          }
        }

        view.dispatch({
          changes: { from, to, insert: text },
          selection: { anchor: from, head: from + text.length },
          scrollIntoView: true,
        });

        setStatus('Applied');
      } catch (err) {
        setStatus('Failed to apply in editor', true);
      }
    }

    runBtn.addEventListener('click', () => {
      if (isRunInFlight) {
        requestStopCurrentRun();
        return;
      }
      handleRun();
    });
    applyBtn.addEventListener('click', handleApply);

    promptInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleRun();
      }
    });

    renderChat();
    updateUsageUI();
    syncRunControlButtons();

    return {
      open,
      close,
      setStatus,
    };
  }

  function parseProxyErrorDetail(text, fallback) {
    if (!text) {
      return fallback;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
    } catch (err) {
      // ignore parse failures
    }
    return text;
  }

  function formatProxyPayloadPreview(text, maxLength) {
    const normalized =
      typeof text === 'string'
        ? text.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
        : '';
    if (!normalized) {
      return '';
    }
    const limit = Number.isFinite(Number(maxLength)) ? Math.max(24, Math.floor(Number(maxLength))) : 200;
    if (normalized.length <= limit) {
      return normalized;
    }
    return `${normalized.slice(0, limit)}...`;
  }

  function parseProxySuccessJson(text, statusCode) {
    const raw = typeof text === 'string' ? text : '';
    const trimmed = raw.trim();
    const numericStatus = Number(statusCode);
    const safeStatus = Number.isFinite(numericStatus) ? Math.max(0, Math.floor(numericStatus)) : 0;
    const statusLabel = safeStatus > 0 ? String(safeStatus) : 'unknown';
    if (!trimmed) {
      throw new Error(`Proxy returned an empty response body (status ${statusLabel}).`);
    }
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      const preview = formatProxyPayloadPreview(trimmed, 200);
      const suffix = preview ? ` Preview: ${preview}` : '';
      throw new Error(`Invalid JSON response from proxy (status ${statusLabel}).${suffix}`);
    }
  }

  function createProxyHttpError(text, fallback, statusCode) {
    const message = parseProxyErrorDetail(text, fallback);
    const err = new Error(message);
    const status = Number(statusCode);
    if (Number.isFinite(status) && status > 0) {
      err.status = Math.floor(status);
    }
    const raw = typeof text === 'string' ? text.trim() : '';
    if (raw) {
      try {
        err.payload = JSON.parse(raw);
      } catch (parseErr) {
        // ignore non-JSON bodies; the message already carries the important detail
      }
    }
    return err;
  }

  function createAbortError(message) {
    const err = new Error(message || 'Request aborted');
    err.aborted = true;
    err.code = 'ABORT_ERR';
    return err;
  }

  function isAbortError(error) {
    if (!error) {
      return false;
    }
    if (error.aborted === true) {
      return true;
    }
    if (error.name === 'AbortError') {
      return true;
    }
    const code = typeof error.code === 'string' ? error.code : '';
    if (code === 'ABORT_ERR' || code === 'ERR_CANCELED') {
      return true;
    }
    const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
    return /aborted|cancelled|canceled/.test(message);
  }

  async function callProxyJson(method, url, payload, control) {
    const isBodyAllowed = method !== 'GET' && method !== 'HEAD';
    const body = isBodyAllowed ? JSON.stringify(payload || {}) : null;

    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        const headers = {};
        if (isBodyAllowed) {
          headers['Content-Type'] = 'application/json';
        }
        const request = GM_xmlhttpRequest({
          method,
          url,
          headers,
          data: body,
          onload: (response) => {
            if (response.status < 200 || response.status >= 300) {
              reject(
                createProxyHttpError(
                  response.responseText,
                  `Proxy error (${response.status})`,
                  response.status
                )
              );
              return;
            }
            try {
              resolve(parseProxySuccessJson(response && response.responseText, response && response.status));
            } catch (err) {
              reject(err instanceof Error ? err : new Error('Invalid JSON response from proxy.'));
            }
          },
          onerror: () => reject(new Error('Request failed')),
          ontimeout: () => reject(new Error('Request timed out')),
          onabort: () => reject(createAbortError('Request aborted')),
        });
        if (control && typeof control.setAbort === 'function' && request && typeof request.abort === 'function') {
          control.setAbort(() => {
            try {
              request.abort();
            } catch (err) {
              // ignore abort failures
            }
          });
        }
      });
    }

    const headers = {};
    if (isBodyAllowed) {
      headers['Content-Type'] = 'application/json';
    }
    const abortController = typeof AbortController === 'function' ? new AbortController() : null;
    if (control && typeof control.setAbort === 'function' && abortController) {
      control.setAbort(() => {
        try {
          abortController.abort();
        } catch (err) {
          // ignore abort failures
        }
      });
    }

    let response = null;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: isBodyAllowed ? body : undefined,
        signal: abortController ? abortController.signal : undefined,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw createAbortError('Request aborted');
      }
      throw err;
    }

    if (!response.ok) {
      let detail = '';
      try {
        detail = await response.text();
      } catch (err) {
        detail = '';
      }
      throw createProxyHttpError(detail, `Proxy error (${response.status})`, response.status);
    }

    let bodyText = '';
    try {
      bodyText = await response.text();
    } catch (err) {
      bodyText = '';
    }
    return parseProxySuccessJson(bodyText, response.status);
  }

  function createStreamEventError(event) {
    const message =
      event && typeof event.message === 'string' && event.message.trim()
        ? event.message.trim()
        : 'Request failed';
    const err = new Error(message);
    err.fromStreamEvent = true;
    const status = Number(event && event.status);
    if (Number.isFinite(status) && status > 0) {
      err.status = Math.floor(status);
    }
    return err;
  }

  function createNdjsonEventParser(onEvent) {
    let buffer = '';
    return {
      push(chunk) {
        buffer += `${chunk || ''}`;
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          newlineIndex = buffer.indexOf('\n');
          if (!line) {
            continue;
          }
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object') {
              onEvent(parsed);
            }
          } catch (err) {
            // ignore malformed stream lines
          }
        }
      },
      flush() {
        const tail = buffer.trim();
        buffer = '';
        if (!tail) {
          return;
        }
        try {
          const parsed = JSON.parse(tail);
          if (parsed && typeof parsed === 'object') {
            onEvent(parsed);
          }
        } catch (err) {
          // ignore malformed trailing line
        }
      },
    };
  }

  async function callAssistStream(proxyUrl, payload, handlers) {
    const streamUrl = deriveAssistStreamUrl(proxyUrl);
    const onEvent = handlers && typeof handlers.onEvent === 'function' ? handlers.onEvent : () => {};
    const setAbort =
      handlers && typeof handlers.setAbort === 'function' ? handlers.setAbort : () => {};
    const body = JSON.stringify(payload || {});

    const callViaGm = () =>
      new Promise((resolve, reject) => {
        let settled = false;
        let latestProgressText = '';
        let resultEvent = null;
        const settleResolve = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        };
        const settleReject = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        };
        const parser = createNdjsonEventParser((event) => {
          if (settled) {
            return;
          }
          if (event.event === 'error') {
            settleReject(createStreamEventError(event));
            return;
          }
          try {
            onEvent(event);
          } catch (err) {
            // ignore UI callback errors
          }
          if (event.event === 'result') {
            resultEvent = event;
            settleResolve(event);
          }
        });
        const pushProgressText = (text) => {
          if (settled || typeof text !== 'string' || !text) {
            return;
          }

          let chunk = '';
          if (!latestProgressText) {
            chunk = text;
          } else if (
            text.length >= latestProgressText.length &&
            text.startsWith(latestProgressText)
          ) {
            // cumulative mode: append only unseen suffix
            chunk = text.slice(latestProgressText.length);
          } else if (
            latestProgressText.length > text.length &&
            latestProgressText.endsWith(text)
          ) {
            // repeated tail; nothing new
            chunk = '';
          } else {
            // delta mode or responseText reset; parse as-is
            chunk = text;
          }

          latestProgressText = text;
          if (chunk) {
            parser.push(chunk);
          }
        };

        const request = GM_xmlhttpRequest({
          method: 'POST',
          url: streamUrl,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson, application/json',
          },
          data: body,
          onprogress: (response) => {
            if (settled) {
              return;
            }
            const text = response && typeof response.responseText === 'string' ? response.responseText : '';
            pushProgressText(text);
          },
          onload: (response) => {
            if (settled) {
              return;
            }
            if (response.status < 200 || response.status >= 300) {
              const detail = parseProxyErrorDetail(
                response.responseText,
                `Proxy error (${response.status})`
              );
              const error = new Error(detail);
              error.status = response.status;
              settleReject(error);
              return;
            }
            const text = response && typeof response.responseText === 'string' ? response.responseText : '';
            if (text) {
              if (!latestProgressText) {
                parser.push(text);
                latestProgressText = text;
              } else if (
                text.length >= latestProgressText.length &&
                text.startsWith(latestProgressText)
              ) {
                const tailChunk = text.slice(latestProgressText.length);
                if (tailChunk) {
                  parser.push(tailChunk);
                }
                latestProgressText = text;
              }
            }
            parser.flush();
            if (resultEvent) {
              settleResolve(resultEvent);
              return;
            }
            const incompleteError = new Error('Stream ended without result');
            incompleteError.streamIncomplete = true;
            settleReject(incompleteError);
          },
          onerror: () => settleReject(new Error('Request failed')),
          ontimeout: () => settleReject(new Error('Request timed out')),
          onabort: () => settleReject(createAbortError('Request aborted')),
        });
        if (request && typeof request.abort === 'function') {
          setAbort(() => {
            try {
              request.abort();
            } catch (err) {
              // ignore abort failures
            }
          });
        }
      });

    const callViaFetch = async () => {
      const abortController = typeof AbortController === 'function' ? new AbortController() : null;
      if (abortController) {
        setAbort(() => {
          try {
            abortController.abort();
          } catch (err) {
            // ignore abort failures
          }
        });
      }
      const response = await fetch(streamUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson, application/json',
        },
        body,
        cache: 'no-store',
        signal: abortController ? abortController.signal : undefined,
      });

      if (!response.ok) {
        let detail = '';
        try {
          detail = await response.text();
        } catch (err) {
          detail = '';
        }
        const error = new Error(parseProxyErrorDetail(detail, `Proxy error (${response.status})`));
        error.status = response.status;
        throw error;
      }

      let resultEvent = null;
      let streamError = null;
      const parser = createNdjsonEventParser((event) => {
        if (streamError || resultEvent) {
          return;
        }
        if (event.event === 'error') {
          streamError = createStreamEventError(event);
          return;
        }
        try {
          onEvent(event);
        } catch (err) {
          // ignore UI callback errors
        }
        if (event.event === 'result') {
          resultEvent = event;
        }
      });

      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          parser.push(decoder.decode(value, { stream: true }));
          if (streamError || resultEvent) {
            try {
              await reader.cancel();
            } catch (err) {
              // ignore cancel failures
            }
            break;
          }
        }
        parser.push(decoder.decode());
        parser.flush();
      } else {
        const text = await response.text();
        parser.push(text);
        parser.flush();
      }

      if (streamError) {
        throw streamError;
      }
      if (resultEvent) {
        return resultEvent;
      }
      const incompleteError = new Error('Stream ended without result');
      incompleteError.streamIncomplete = true;
      throw incompleteError;
    };

    if (typeof fetch === 'function') {
      try {
        return await callViaFetch();
      } catch (fetchErr) {
        if (isAbortError(fetchErr)) {
          throw createAbortError('Request aborted');
        }
        if (typeof GM_xmlhttpRequest !== 'function') {
          throw fetchErr;
        }
      }
    }

    if (typeof GM_xmlhttpRequest === 'function') {
      return callViaGm();
    }

    throw new Error('Streaming unavailable: neither fetch nor GM_xmlhttpRequest is available');
  }

  async function callAssist(proxyUrl, payload, control) {
    return callProxyJson('POST', proxyUrl, payload, control);
  }

  async function callModels(modelsUrl) {
    return callProxyJson('GET', modelsUrl, null);
  }

  async function callHealth(healthUrl) {
    return callProxyJson('GET', healthUrl, null);
  }

  async function callDoctor(doctorUrl) {
    return callProxyJson('GET', doctorUrl, null);
  }

  async function callProjectSession(proxyUrl, projectId) {
    return callProxyJson('GET', deriveProjectSessionUrl(proxyUrl, projectId), null);
  }

  async function startProjectRun(proxyUrl, projectId, payload) {
    return callProxyJson('POST', deriveProjectRunUrl(proxyUrl, projectId), payload);
  }

  async function cancelProjectRun(proxyUrl, sessionId) {
    return callProxyJson('POST', deriveSessionCancelUrl(proxyUrl, sessionId), {});
  }

  function openNdjsonSubscription(url, handlers) {
    const onEvent = handlers && typeof handlers.onEvent === 'function' ? handlers.onEvent : () => {};
    const onError = handlers && typeof handlers.onError === 'function' ? handlers.onError : () => {};
    const onClose = handlers && typeof handlers.onClose === 'function' ? handlers.onClose : () => {};
    const body = handlers && handlers.payload ? JSON.stringify(handlers.payload) : null;
    const method =
      handlers && typeof handlers.method === 'string' && handlers.method.trim()
        ? handlers.method.trim().toUpperCase()
        : body
          ? 'POST'
          : 'GET';
    let closed = false;
    let abortFn = null;

    const finalizeClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      onClose();
    };

    const fail = (error) => {
      if (closed) {
        return;
      }
      if (isAbortError(error)) {
        closed = true;
        return;
      }
      closed = true;
      onError(error);
    };

    const parseWith = (parser, text, latestRef) => {
      if (!text) {
        return;
      }
      let chunk = '';
      if (!latestRef.value) {
        chunk = text;
      } else if (text.length >= latestRef.value.length && text.startsWith(latestRef.value)) {
        chunk = text.slice(latestRef.value.length);
      } else if (latestRef.value.length > text.length && latestRef.value.endsWith(text)) {
        chunk = '';
      } else {
        chunk = text;
      }
      latestRef.value = text;
      if (chunk) {
        parser.push(chunk);
      }
    };

    if (typeof fetch === 'function') {
      const abortController = typeof AbortController === 'function' ? new AbortController() : null;
      abortFn = () => {
        if (!abortController) {
          closed = true;
          return;
        }
        try {
          abortController.abort();
        } catch (err) {
          // ignore abort failures
        }
      };

      (async () => {
        try {
          const response = await fetch(url, {
            method,
            headers: {
              Accept: 'application/x-ndjson, application/json',
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body || undefined,
            cache: 'no-store',
            signal: abortController ? abortController.signal : undefined,
          });
          if (!response.ok) {
            let detail = '';
            try {
              detail = await response.text();
            } catch (err) {
              detail = '';
            }
            fail(createProxyHttpError(detail, `Proxy error (${response.status})`, response.status));
            return;
          }
          const parser = createNdjsonEventParser((event) => {
            if (!closed) {
              onEvent(event);
            }
          });
          if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (!closed) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              parser.push(decoder.decode(value, { stream: true }));
            }
            parser.push(decoder.decode());
            parser.flush();
          } else {
            const text = await response.text();
            parser.push(text);
            parser.flush();
          }
          finalizeClose();
        } catch (err) {
          fail(err);
        }
      })();

      return {
        close() {
          if (closed) {
            return;
          }
          closed = true;
          try {
            abortFn();
          } catch (err) {
            // ignore close failures
          }
        },
      };
    }

    if (typeof GM_xmlhttpRequest === 'function') {
      const parser = createNdjsonEventParser((event) => {
        if (!closed) {
          onEvent(event);
        }
      });
      const latestRef = { value: '' };
      const request = GM_xmlhttpRequest({
        method,
        url,
        headers: {
          Accept: 'application/x-ndjson, application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        data: body,
        onprogress: (response) => {
          if (closed) {
            return;
          }
          const text = response && typeof response.responseText === 'string' ? response.responseText : '';
          parseWith(parser, text, latestRef);
        },
        onload: (response) => {
          if (closed) {
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            fail(
              createProxyHttpError(
                response.responseText,
                `Proxy error (${response.status})`,
                response.status
              )
            );
            return;
          }
          const text = response && typeof response.responseText === 'string' ? response.responseText : '';
          parseWith(parser, text, latestRef);
          parser.flush();
          finalizeClose();
        },
        onerror: () => fail(new Error('Request failed')),
        ontimeout: () => fail(new Error('Request timed out')),
        onabort: () => {
          closed = true;
        },
      });
      abortFn =
        request && typeof request.abort === 'function'
          ? () => {
              try {
                request.abort();
              } catch (err) {
                // ignore abort failures
              }
            }
          : () => {
              closed = true;
            };

      return {
        close() {
          if (closed) {
            return;
          }
          closed = true;
          abortFn();
        },
      };
    }

    throw new Error('Streaming unavailable: neither fetch nor GM_xmlhttpRequest is available');
  }

  function findViewFromTarget(target) {
    if (!target || !(target instanceof Element)) {
      return null;
    }

    if (target.cmView) {
      return normalizeEditorView(target.cmView);
    }

    const editorEl = target.closest('.cm-editor');
    if (editorEl) {
      if (editorEl.cmView) {
        return normalizeEditorView(editorEl.cmView);
      }
      const contentEl = editorEl.querySelector('.cm-content');
      if (contentEl && contentEl.cmView) {
        return normalizeEditorView(contentEl.cmView);
      }
    }

    return null;
  }

  function normalizeEditorView(candidate) {
    if (!candidate) {
      return null;
    }

    if (candidate.state && typeof candidate.dispatch === 'function') {
      return candidate;
    }

    if (candidate.view && candidate.view.state && typeof candidate.view.dispatch === 'function') {
      return candidate.view;
    }

    return null;
  }

  function findFocusedView() {
    const active = document.activeElement;
    if (active) {
      const view = findViewFromTarget(active);
      if (view) {
        return view;
      }
    }

    const selection = document.getSelection ? document.getSelection() : null;
    if (selection && selection.anchorNode) {
      const node = selection.anchorNode;
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (element) {
        const view = findViewFromTarget(element);
        if (view) {
          return view;
        }
      }
    }

    const editorEl = document.querySelector('.cm-editor');
    if (editorEl && editorEl.cmView) {
      return normalizeEditorView(editorEl.cmView);
    }
    const contentEl = editorEl && editorEl.querySelector('.cm-content');
    if (contentEl && contentEl.cmView) {
      return normalizeEditorView(contentEl.cmView);
    }

    return null;
  }

  function init() {
    loadConfig();
    installStyles();
    state.ui = buildUI();
    let editorSyncTimer = null;
    let editorObserver = null;

    function syncEditorWindowVisibility() {
      const hasEditor = Boolean(findFocusedView());
      const overlay = document.querySelector('#ola-overlay');
      if (!overlay) {
        return;
      }

      if (!hasEditor) {
        if (overlay.classList.contains('open')) {
          state.ui.close();
        }
        state.hiddenForNoEditor = true;
        return;
      }

      if (state.hiddenForNoEditor) {
        const opened = state.ui.open();
        if (opened) {
          state.hiddenForNoEditor = false;
        }
      }
    }

    function scheduleEditorWindowVisibilitySync() {
      if (editorSyncTimer) {
        clearTimeout(editorSyncTimer);
      }
      editorSyncTimer = window.setTimeout(() => {
        syncEditorWindowVisibility();
        const latestProjectId = deriveCurrentProjectId();
        if (latestProjectId !== state.currentProjectId) {
          loadCurrentProjectSession({
            force: true,
            preserveStatus: true,
          }).catch(() => {});
        }
      }, 120);
    }

    state.currentProjectId = deriveCurrentProjectId();
    state.hiddenForNoEditor = !findFocusedView();
    scheduleEditorWindowVisibilitySync();

    if (HAS_GM_MENU) {
      GM_registerMenuCommand('Overleaf Assist (Codex CLI)...', () => {
        const overlay = document.querySelector('#ola-overlay');
        if (overlay && overlay.classList.contains('open')) {
          state.ui.close();
        } else {
          const opened = state.ui.open();
          state.hiddenForNoEditor = !opened;
        }
      });
    }

    document.addEventListener(
      'keydown',
      (event) => {
        if (event.code === 'KeyA' && event.ctrlKey && event.altKey && event.shiftKey) {
          event.preventDefault();
          const overlay = document.querySelector('#ola-overlay');
          if (overlay && overlay.classList.contains('open')) {
            state.ui.close();
          } else {
            const opened = state.ui.open();
            state.hiddenForNoEditor = !opened;
          }
        }
        if (event.code === 'Escape') {
          const overlay = document.querySelector('#ola-overlay');
          if (overlay && overlay.classList.contains('open')) {
            event.preventDefault();
            state.ui.close();
          }
        }
      },
      true
    );

    document.addEventListener('focusin', scheduleEditorWindowVisibilitySync, true);
    window.addEventListener('popstate', scheduleEditorWindowVisibilitySync);
    window.addEventListener('hashchange', scheduleEditorWindowVisibilitySync);
    if (typeof MutationObserver === 'function') {
      editorObserver = new MutationObserver(() => {
        scheduleEditorWindowVisibilitySync();
      });
      editorObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }

    window.OverleafAssistDemo = {
      open: () => {
        const opened = state.ui.open();
        state.hiddenForNoEditor = !opened;
      },
      close: () => state.ui.close(),
      toggle: () => {
        const overlay = document.querySelector('#ola-overlay');
        if (overlay && overlay.classList.contains('open')) {
          state.ui.close();
        } else {
          const opened = state.ui.open();
          state.hiddenForNoEditor = !opened;
        }
      },
      getConfig: () => deepClone(state.config),
    };

    window.addEventListener('beforeunload', () => {
      closeSessionStream();
    });
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
