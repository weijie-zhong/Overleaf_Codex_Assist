const express = require('express');
const cors = require('cors');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const BRIDGE_VERSION = require('../package.json').version || '0.3.1';

const ALLOWED_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const ALLOWED_REASONING_EFFORTS_SET = new Set(ALLOWED_REASONING_EFFORTS);
const DEFAULT_ALLOWED_ORIGINS = [/^https:\/\/(www\.)?overleaf\.com$/];

let activeBridge = null;

function resolveBridgeConfig(overrides = {}) {
  const codexHome = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');

  return {
    port: Number(overrides.port ?? process.env.PORT) || 8787,
    codexBin:
      overrides.codexBin ||
      process.env.CODEX_BIN ||
      (process.platform === 'win32' ? 'codex.cmd' : 'codex'),
    codexModel: overrides.codexModel ?? process.env.CODEX_MODEL ?? '',
    codexSandbox: overrides.codexSandbox ?? process.env.CODEX_SANDBOX ?? 'read-only',
    codexTimeoutMs: Number(overrides.codexTimeoutMs ?? process.env.CODEX_TIMEOUT_MS) || 180000,
    tempDir:
      overrides.tempDir ||
      path.join(os.tmpdir(), 'overleaf-assist-bridge'),
    codexConfigPath: overrides.codexConfigPath || path.join(codexHome, 'config.toml'),
    codexModelsCachePath: overrides.codexModelsCachePath || path.join(codexHome, 'models_cache.json'),
    codexAuthPath: overrides.codexAuthPath || path.join(codexHome, 'auth.json'),
    allowedOrigins: Array.isArray(overrides.allowedOrigins)
      ? overrides.allowedOrigins
      : DEFAULT_ALLOWED_ORIGINS,
    serviceName: overrides.serviceName || 'overleaf-assist-bridge',
  };
}

function looksLikePath(value) {
  if (typeof value !== 'string') {
    return false;
  }
  return /[\\/]/.test(value) || path.isAbsolute(value);
}

function dedupeStringValues(values) {
  const seen = new Set();
  const deduped = [];
  for (const value of values || []) {
    const key = String(value || '').trim();
    if (!key) {
      continue;
    }
    const normalized = process.platform === 'win32' ? key.toLowerCase() : key;
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(key);
  }
  return deduped;
}

function buildCodexBinCandidates(config) {
  const candidates = [];
  const configured = typeof config.codexBin === 'string' ? config.codexBin.trim() : '';
  if (configured) {
    candidates.push(configured);
  }

  if (process.platform === 'win32') {
    candidates.push('codex.cmd');
    candidates.push('codex.exe');
    candidates.push('codex');
    const appData =
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'npm', 'codex.cmd'));
    candidates.push(path.join(appData, 'npm', 'codex.exe'));
    candidates.push(path.join(appData, 'npm', 'codex'));
    candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'));
    candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.exe'));
    candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex'));
    if (process.env.LOCALAPPDATA) {
      candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'codex', 'codex.exe'));
    }
    if (process.env.PNPM_HOME) {
      candidates.push(path.join(process.env.PNPM_HOME, 'codex.cmd'));
      candidates.push(path.join(process.env.PNPM_HOME, 'codex.exe'));
      candidates.push(path.join(process.env.PNPM_HOME, 'codex'));
    }
  } else {
    candidates.push('codex');
  }

  return dedupeStringValues(candidates);
}

async function runWindowsWhereLookup(name) {
  if (process.platform !== 'win32') {
    return [];
  }
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child = null;
    try {
      child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'where', name], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: process.env,
      });
    } catch (err) {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve([]);
    }, 4000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.on('error', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve([]);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        resolve([]);
        return;
      }
      resolve(
        stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      );
    });
  });
}

async function collectCodexBinCandidates(config) {
  const staticCandidates = buildCodexBinCandidates(config);
  if (process.platform !== 'win32') {
    return staticCandidates;
  }
  const fromWhere = [];
  for (const name of ['codex.cmd', 'codex.exe', 'codex']) {
    const found = await runWindowsWhereLookup(name);
    fromWhere.push(...found);
  }
  return dedupeStringValues([...staticCandidates, ...fromWhere]);
}

async function canExecuteCodexBinary(candidate) {
  if (!candidate) {
    return false;
  }

  const cmd = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : candidate;
  const args =
    process.platform === 'win32'
      ? ['/d', '/c', `${quoteCmd(candidate)} --version`]
      : ['--version'];

  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(cmd, args, {
      windowsHide: true,
      stdio: 'ignore',
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve(false);
    }, 7000);

    child.on('error', () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(false);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function resolveCodexBinary(config) {
  const candidates = await collectCodexBinCandidates(config);
  let existingPathCandidate = '';
  for (const candidate of candidates) {
    if (looksLikePath(candidate)) {
      const exists = await fileExists(candidate);
      if (!exists) {
        continue;
      }
      if (!existingPathCandidate) {
        existingPathCandidate = candidate;
      }
    }
    if (await canExecuteCodexBinary(candidate)) {
      return candidate;
    }
  }
  return existingPathCandidate || config.codexBin;
}

async function ensureResolvedCodexBin(config) {
  if (typeof config.resolvedCodexBin === 'string' && config.resolvedCodexBin.trim()) {
    return config.resolvedCodexBin;
  }
  config.resolvedCodexBin = await resolveCodexBinary(config);
  return config.resolvedCodexBin;
}

function buildCodexAuthPathCandidates(config) {
  const candidates = [];
  if (typeof config.codexAuthPath === 'string' && config.codexAuthPath.trim()) {
    candidates.push(config.codexAuthPath.trim());
  }

  const baseDirs = [];
  if (process.env.CODEX_HOME) {
    baseDirs.push(path.resolve(process.env.CODEX_HOME));
  }
  baseDirs.push(path.join(os.homedir(), '.codex'));
  if (process.platform === 'win32') {
    if (process.env.APPDATA) {
      baseDirs.push(path.join(process.env.APPDATA, 'codex'));
    }
    if (process.env.LOCALAPPDATA) {
      baseDirs.push(path.join(process.env.LOCALAPPDATA, 'codex'));
    }
  } else if (process.env.XDG_CONFIG_HOME) {
    baseDirs.push(path.join(process.env.XDG_CONFIG_HOME, 'codex'));
  } else {
    baseDirs.push(path.join(os.homedir(), '.config', 'codex'));
  }

  for (const base of baseDirs) {
    candidates.push(path.join(base, 'auth.json'));
    candidates.push(path.join(base, 'auth.toml'));
  }

  return dedupeStringValues(candidates);
}

async function detectCodexAuthArtifact(config) {
  const candidates = buildCodexAuthPathCandidates(config);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return {
        found: true,
        path: candidate,
      };
    }
  }
  return {
    found: false,
    path: candidates[0] || '',
  };
}

function normalizeReasoningEffort(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (!ALLOWED_REASONING_EFFORTS_SET.has(normalized)) {
    return null;
  }
  return normalized;
}

function resolveRequestTimeoutMs(rawValue) {
  if (rawValue == null) {
    return {
      value: undefined,
      error: null,
    };
  }

  if (typeof rawValue === 'string' && !rawValue.trim()) {
    return {
      value: undefined,
      error: null,
    };
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    return {
      value: undefined,
      error: 'timeout_ms must be a positive integer',
    };
  }

  return {
    value: Math.floor(parsed),
    error: null,
  };
}

function buildCodexPrompt(prompt, content, scope) {
  const currentScope = typeof scope === 'string' && scope.trim() ? scope.trim() : 'auto';
  return [
    'You are assisting with an Overleaf (LaTeX) document.',
    'Follow the user task and return only the final text to apply.',
    'Do not wrap the answer in markdown fences and do not add explanations.',
    '',
    `Scope: ${currentScope}`,
    `Task: ${prompt}`,
    '',
    'Document content begins after this line:',
    '---BEGIN CONTENT---',
    content,
    '---END CONTENT---',
  ].join('\n');
}

function summarizeCliFailure(logText, exitCode, signal) {
  const lines = `${logText || ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('WARNING: proceeding, even though we could not update PATH:'));

  const hasNetworkDisconnect = lines.some((line) =>
    /error sending request for url|stream disconnected before completion|api\.openai\.com/i.test(line)
  );
  const hasSkillsPermissionError = lines.some((line) =>
    /failed to install system skills: .*Access is denied/i.test(line)
  );

  const explicitError = [...lines].reverse().find((line) => /^ERROR:/i.test(line));
  if (explicitError) {
    if (hasNetworkDisconnect) {
      const permissionNote = hasSkillsPermissionError
        ? ' Also fix local permissions: set a writable `CODEX_HOME` before starting the proxy.'
        : '';
      return `Codex could not reach the model API (api.openai.com). Check internet/proxy/firewall access.${permissionNote}`;
    }
    return explicitError.replace(/^ERROR:\s*/i, '').trim();
  }

  if (hasNetworkDisconnect) {
    const permissionNote = hasSkillsPermissionError
      ? ' Also fix local permissions: set a writable `CODEX_HOME` before starting the proxy.'
      : '';
    return `Codex could not reach the model API (api.openai.com). Check internet/proxy/firewall access.${permissionNote}`;
  }

  const authError = [...lines]
    .reverse()
    .find((line) => /(not logged in|unauthorized|forbidden|authentication)/i.test(line));
  if (authError) {
    return `Codex authentication failed. Run \`codex.cmd login\` in a terminal. (${authError})`;
  }

  if (hasSkillsPermissionError) {
    return 'Codex cannot write to its skills directory. Set a writable `CODEX_HOME` and restart the proxy.';
  }

  if (lines.length > 0) {
    return lines.slice(-6).join('\n');
  }

  if (signal) {
    return `codex terminated by signal ${signal}`;
  }

  return `codex exited with code ${String(
    exitCode
  )}. Check Codex auth, network access to api.openai.com, and local file permissions.`;
}

function parseTomlStringValue(text, key) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*${escapedKey}\\s*=\\s*(?:"([^"]*)"|'([^']*)')\\s*$`, 'm');
  const match = text.match(pattern);
  if (!match) {
    return null;
  }
  return (match[1] || match[2] || '').trim() || null;
}

async function readCodexDefaults(config) {
  let raw = '';
  try {
    raw = await fs.readFile(config.codexConfigPath, 'utf8');
  } catch (err) {
    return { defaultModel: null, defaultReasoningEffort: null };
  }

  const defaultModel = parseTomlStringValue(raw, 'model');
  const defaultReasoningEffort = normalizeReasoningEffort(
    parseTomlStringValue(raw, 'model_reasoning_effort')
  );

  return {
    defaultModel: defaultModel || null,
    defaultReasoningEffort: defaultReasoningEffort || null,
  };
}

function normalizeModelRecord(rawModel) {
  if (!rawModel || typeof rawModel !== 'object') {
    return null;
  }

  const idCandidates = [
    typeof rawModel.id === 'string' ? rawModel.id.trim() : '',
    typeof rawModel.slug === 'string' ? rawModel.slug.trim() : '',
    typeof rawModel.display_name === 'string' ? rawModel.display_name.trim() : '',
  ];
  const id = idCandidates.find((candidate) => Boolean(candidate)) || '';
  if (!id) {
    return null;
  }

  const description = typeof rawModel.description === 'string' ? rawModel.description.trim() : '';
  const defaultReasoningLevel = normalizeReasoningEffort(rawModel.default_reasoning_level);
  const supportedRaw = Array.isArray(rawModel.supported_reasoning_levels)
    ? rawModel.supported_reasoning_levels
    : [];

  const seen = new Set();
  const supported = [];
  for (const levelEntry of supportedRaw) {
    let effort = null;
    if (typeof levelEntry === 'string') {
      effort = normalizeReasoningEffort(levelEntry);
    } else if (levelEntry && typeof levelEntry === 'object' && typeof levelEntry.effort === 'string') {
      effort = normalizeReasoningEffort(levelEntry.effort);
    }
    if (!effort || seen.has(effort)) {
      continue;
    }
    seen.add(effort);
    supported.push(effort);
  }

  if (defaultReasoningLevel && !seen.has(defaultReasoningLevel)) {
    supported.push(defaultReasoningLevel);
  }

  return {
    id,
    description: description || undefined,
    default_reasoning_level: defaultReasoningLevel || undefined,
    supported_reasoning_levels: supported,
  };
}

function buildFallbackModels(defaultModel) {
  const fallbackModels = [];

  if (defaultModel) {
    fallbackModels.push({
      id: defaultModel,
      description: 'Default model from Codex config',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    });
  }

  const baselineFallback = ['gpt-5.2-codex', 'gpt-5.3-codex', 'gpt-4.1'];
  for (const modelId of baselineFallback) {
    if (fallbackModels.some((model) => model.id === modelId)) {
      continue;
    }
    fallbackModels.push({
      id: modelId,
      description: 'Fallback model option',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    });
  }

  return fallbackModels;
}

async function loadModelsMetadata(config) {
  const defaults = await readCodexDefaults(config);
  let models = [];
  let source = 'fallback';

  try {
    const raw = await fs.readFile(config.codexModelsCachePath, 'utf8');
    const parsed = JSON.parse(raw);
    const rawModels = Array.isArray(parsed?.models) ? parsed.models : [];
    models = rawModels.map(normalizeModelRecord).filter(Boolean);
    if (models.length > 0) {
      source = 'models_cache';
    } else {
      models = [];
    }
  } catch (err) {
    models = [];
  }

  const effectiveDefaultModel =
    defaults.defaultModel ||
    (typeof config.codexModel === 'string' && config.codexModel.trim() ? config.codexModel.trim() : null);

  if (models.length === 0) {
    models = buildFallbackModels(effectiveDefaultModel);
    source = 'fallback';
  } else if (effectiveDefaultModel && !models.some((model) => model.id === effectiveDefaultModel)) {
    models.unshift({
      id: effectiveDefaultModel,
      description: 'Default model from config/env',
      default_reasoning_level: defaults.defaultReasoningEffort || undefined,
      supported_reasoning_levels: defaults.defaultReasoningEffort ? [defaults.defaultReasoningEffort] : [],
    });
  }

  return {
    source,
    default_model: effectiveDefaultModel || null,
    default_reasoning_effort: defaults.defaultReasoningEffort || null,
    models,
  };
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function buildCodexPosixShellCommand(codexBin, args, promptFile, logFile) {
  const quoted = [quotePosix(codexBin), ...args.map(quotePosix)].join(' ');
  return `${quoted} < ${quotePosix(promptFile)} > ${quotePosix(logFile)} 2>&1`;
}

function buildCodexWindowsRunnerScript(codexBin, args, promptFile, logFile) {
  const quoted = [quoteCmd(codexBin), ...args.map(quoteCmd)].join(' ');
  return [
    '@echo off',
    `${quoted} < ${quoteCmd(promptFile)} > ${quoteCmd(logFile)} 2>&1`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

function buildCodexWindowsCommandString(codexBin, args) {
  return [quoteCmd(codexBin), ...args.map(quoteCmd)].join(' ');
}

function buildCodexWindowsExecScript(codexBin, args) {
  return [
    '@echo off',
    buildCodexWindowsCommandString(codexBin, args),
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

function pushTailLine(lines, value, maxLines) {
  const text = `${value || ''}`.trim();
  if (!text) {
    return;
  }
  lines.push(text);
  if (lines.length > maxLines) {
    lines.splice(0, lines.length - maxLines);
  }
}

function normalizeCodexUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') {
    return null;
  }
  const inputTokens = Number(rawUsage.input_tokens);
  const cachedInputTokens = Number(rawUsage.cached_input_tokens);
  const outputTokens = Number(rawUsage.output_tokens);
  const totalTokens = Number(rawUsage.total_tokens);

  const safeInput = Number.isFinite(inputTokens) ? Math.max(0, Math.floor(inputTokens)) : 0;
  const safeCached = Number.isFinite(cachedInputTokens)
    ? Math.max(0, Math.floor(cachedInputTokens))
    : 0;
  const safeOutput = Number.isFinite(outputTokens) ? Math.max(0, Math.floor(outputTokens)) : 0;
  const safeTotal = Number.isFinite(totalTokens)
    ? Math.max(0, Math.floor(totalTokens))
    : safeInput + safeOutput;

  return {
    input_tokens: safeInput,
    cached_input_tokens: safeCached,
    output_tokens: safeOutput,
    total_tokens: safeTotal,
  };
}

function normalizeRateLimitWindow(rawWindow) {
  if (!rawWindow || typeof rawWindow !== 'object') {
    return null;
  }

  const usedPercentValue = Number(rawWindow.used_percent);
  const windowMinutesValue = Number(rawWindow.window_minutes);
  const resetsAtValue = Number(rawWindow.resets_at);

  const usedPercent = Number.isFinite(usedPercentValue)
    ? Math.max(0, usedPercentValue)
    : null;
  const windowMinutes = Number.isFinite(windowMinutesValue)
    ? Math.max(0, Math.floor(windowMinutesValue))
    : null;
  const resetsAt = Number.isFinite(resetsAtValue)
    ? Math.max(0, Math.floor(resetsAtValue))
    : null;

  if (usedPercent === null && windowMinutes === null && resetsAt === null) {
    return null;
  }

  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes,
    resets_at: resetsAt,
  };
}

function normalizeRateLimitCredits(rawCredits) {
  if (!rawCredits || typeof rawCredits !== 'object') {
    return null;
  }

  const hasCredits =
    typeof rawCredits.has_credits === 'boolean' ? rawCredits.has_credits : null;
  const unlimited = typeof rawCredits.unlimited === 'boolean' ? rawCredits.unlimited : null;
  const balanceValue = Number(rawCredits.balance);
  const balance = Number.isFinite(balanceValue) ? balanceValue : null;

  if (hasCredits === null && unlimited === null && balance === null) {
    return null;
  }

  return {
    has_credits: hasCredits,
    unlimited,
    balance,
  };
}

function normalizeRateLimits(rawRateLimits) {
  if (!rawRateLimits || typeof rawRateLimits !== 'object') {
    return null;
  }

  const limitId =
    typeof rawRateLimits.limit_id === 'string' && rawRateLimits.limit_id.trim()
      ? rawRateLimits.limit_id.trim()
      : null;
  const limitName =
    typeof rawRateLimits.limit_name === 'string' && rawRateLimits.limit_name.trim()
      ? rawRateLimits.limit_name.trim()
      : null;
  const planType =
    typeof rawRateLimits.plan_type === 'string' && rawRateLimits.plan_type.trim()
      ? rawRateLimits.plan_type.trim()
      : null;

  const primary = normalizeRateLimitWindow(rawRateLimits.primary);
  const secondary = normalizeRateLimitWindow(rawRateLimits.secondary);
  const credits = normalizeRateLimitCredits(rawRateLimits.credits);

  if (!limitId && !limitName && !planType && !primary && !secondary && !credits) {
    return null;
  }

  return {
    limit_id: limitId,
    limit_name: limitName,
    primary,
    secondary,
    credits,
    plan_type: planType,
  };
}

function normalizeTokenCountInfo(rawInfo) {
  if (!rawInfo || typeof rawInfo !== 'object') {
    return null;
  }

  const totalUsage = normalizeCodexUsage(rawInfo.total_token_usage);
  const lastUsage = normalizeCodexUsage(rawInfo.last_token_usage);
  const modelContextWindowValue = Number(rawInfo.model_context_window);
  const modelContextWindow = Number.isFinite(modelContextWindowValue)
    ? Math.max(0, Math.floor(modelContextWindowValue))
    : null;

  if (!totalUsage && !lastUsage && modelContextWindow === null) {
    return null;
  }

  return {
    total_usage: totalUsage,
    last_usage: lastUsage,
    model_context_window: modelContextWindow,
  };
}

function createEmptyTokenMetrics() {
  return {
    usage: null,
    total_usage: null,
    last_usage: null,
    model_context_window: null,
    rate_limits: null,
    updated_at: 0,
  };
}

function hasTokenMetricsData(metrics) {
  if (!metrics || typeof metrics !== 'object') {
    return false;
  }
  if (metrics.usage || metrics.total_usage || metrics.last_usage || metrics.rate_limits) {
    return true;
  }
  return Number.isFinite(Number(metrics.model_context_window));
}

function mergeTokenMetrics(previous, next) {
  const current = previous && typeof previous === 'object' ? previous : createEmptyTokenMetrics();
  const incoming = next && typeof next === 'object' ? next : {};

  const nextContextWindowValue = Number(incoming.model_context_window);
  const previousContextWindowValue = Number(current.model_context_window);
  const modelContextWindow = Number.isFinite(nextContextWindowValue)
    ? Math.max(0, Math.floor(nextContextWindowValue))
    : Number.isFinite(previousContextWindowValue)
      ? Math.max(0, Math.floor(previousContextWindowValue))
      : null;

  return {
    usage: incoming.usage || current.usage || null,
    total_usage: incoming.total_usage || current.total_usage || null,
    last_usage: incoming.last_usage || current.last_usage || null,
    model_context_window: modelContextWindow,
    rate_limits: incoming.rate_limits || current.rate_limits || null,
    updated_at: hasTokenMetricsData(incoming)
      ? Date.now()
      : Number.isFinite(Number(current.updated_at))
        ? Math.max(0, Math.floor(Number(current.updated_at)))
        : 0,
  };
}

function safeEmitProgressEvent(onEvent, stage, message) {
  if (typeof onEvent !== 'function') {
    return;
  }
  try {
    onEvent({ stage, message });
  } catch (err) {
    // swallow callback errors so codex execution is not interrupted
  }
}

function safeEmitRawOutput(onRawOutput, stream, text) {
  if (typeof onRawOutput !== 'function') {
    return;
  }
  if (stream !== 'stdout' && stream !== 'stderr') {
    return;
  }
  if (typeof text !== 'string' || !text) {
    return;
  }
  try {
    onRawOutput({ stream, text, ts: Date.now() });
  } catch (err) {
    // swallow callback errors so codex execution is not interrupted
  }
}

function createClientCancelledError() {
  const error = new Error('request cancelled by client');
  error.status = 499;
  error.cancelled = true;
  return error;
}

function estimateTokens(value) {
  if (typeof value !== 'string' || !value) {
    return 0;
  }
  return Math.max(1, Math.ceil(value.length / 4));
}

function createEmptySessionUsage() {
  return {
    estimated_input_tokens: 0,
    estimated_output_tokens: 0,
    estimated_total_tokens: 0,
    last_usage: null,
    total_usage: null,
    warnings_count: 0,
  };
}

function cloneSessionUsage(usage) {
  const value = usage && typeof usage === 'object' ? usage : {};
  return {
    estimated_input_tokens: Number.isFinite(Number(value.estimated_input_tokens))
      ? Math.max(0, Math.floor(Number(value.estimated_input_tokens)))
      : 0,
    estimated_output_tokens: Number.isFinite(Number(value.estimated_output_tokens))
      ? Math.max(0, Math.floor(Number(value.estimated_output_tokens)))
      : 0,
    estimated_total_tokens: Number.isFinite(Number(value.estimated_total_tokens))
      ? Math.max(0, Math.floor(Number(value.estimated_total_tokens)))
      : 0,
    last_usage: normalizeCodexUsage(value.last_usage),
    total_usage: normalizeCodexUsage(value.total_usage),
    warnings_count: Number.isFinite(Number(value.warnings_count))
      ? Math.max(0, Math.floor(Number(value.warnings_count)))
      : 0,
  };
}

function mergeUsageTotals(previous, next) {
  const current = normalizeCodexUsage(previous) || {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
  const incoming = normalizeCodexUsage(next);
  if (!incoming) {
    return current;
  }
  return normalizeCodexUsage({
    input_tokens: current.input_tokens + incoming.input_tokens,
    cached_input_tokens: current.cached_input_tokens + incoming.cached_input_tokens,
    output_tokens: current.output_tokens + incoming.output_tokens,
    total_tokens:
      current.total_tokens + incoming.total_tokens ||
      current.input_tokens +
        incoming.input_tokens +
        current.output_tokens +
        incoming.output_tokens,
  });
}

function normalizeChatTurn(rawTurn) {
  if (!rawTurn || typeof rawTurn !== 'object') {
    return null;
  }
  const role =
    typeof rawTurn.role === 'string' && ['user', 'assistant', 'system'].includes(rawTurn.role.trim())
      ? rawTurn.role.trim()
      : '';
  const text = typeof rawTurn.text === 'string' ? rawTurn.text.trim() : '';
  if (!role || !text) {
    return null;
  }
  const turn = {
    role,
    text,
    ts: Number.isFinite(Number(rawTurn.ts)) ? Math.max(0, Math.floor(Number(rawTurn.ts))) : Date.now(),
  };
  if (typeof rawTurn.tag === 'string' && rawTurn.tag.trim()) {
    turn.tag = rawTurn.tag.trim();
  }
  return turn;
}

function buildRunSummaryText(usageSummary, warningsCount) {
  const warnings = Number.isFinite(Number(warningsCount))
    ? Math.max(0, Math.floor(Number(warningsCount)))
    : 0;
  const usage = normalizeCodexUsage(usageSummary);
  if (usage) {
    let summaryText =
      `Run summary: in ${usage.input_tokens.toLocaleString('en-US')} / cached ${usage.cached_input_tokens.toLocaleString('en-US')} / out ${usage.output_tokens.toLocaleString('en-US')} / total ${usage.total_tokens.toLocaleString('en-US')}`;
    if (warnings > 0) {
      summaryText += ` | warnings ${warnings}`;
    }
    return summaryText;
  }
  if (warnings > 0) {
    return `Run summary: warnings ${warnings}`;
  }
  return '';
}

async function runCodex(
  config,
  promptText,
  requestedModel,
  requestedReasoningEffort,
  timeoutOverrideMs,
  abortSignal
) {
  if (abortSignal && abortSignal.aborted) {
    throw createClientCancelledError();
  }
  const codexBin = await ensureResolvedCodexBin(config);
  await fs.mkdir(config.tempDir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const promptFile = path.join(config.tempDir, `overleaf-assist-${id}.prompt.txt`);
  const outputFile = path.join(config.tempDir, `overleaf-assist-${id}.output.txt`);
  const logFile = path.join(config.tempDir, `overleaf-assist-${id}.log.txt`);
  const runFile = path.join(config.tempDir, `overleaf-assist-${id}.run.cmd`);

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    config.codexSandbox,
    '--color',
    'never',
    '--output-last-message',
    outputFile,
  ];

  const model =
    typeof requestedModel === 'string' && requestedModel.trim()
      ? requestedModel.trim()
      : config.codexModel;
  if (model) {
    args.push('--model', model);
  }

  if (requestedReasoningEffort && requestedReasoningEffort !== 'default') {
    args.push('--config', `model_reasoning_effort="${requestedReasoningEffort}"`);
  }

  args.push('-');
  await fs.writeFile(promptFile, promptText, 'utf8');
  if (process.platform === 'win32') {
    await fs.writeFile(
      runFile,
      buildCodexWindowsRunnerScript(codexBin, args, promptFile, logFile),
      'ascii'
    );
  }

  const startTime = Date.now();
  let timedOut = false;
  const timeoutMs = Number(timeoutOverrideMs) > 0 ? Number(timeoutOverrideMs) : config.codexTimeoutMs;

  const result = await new Promise((resolve) => {
    let child = null;
    let aborted = false;
    let abortHandler = null;
    const cleanupAbortListener = () => {
      if (!abortSignal || !abortHandler || typeof abortSignal.removeEventListener !== 'function') {
        return;
      }
      try {
        abortSignal.removeEventListener('abort', abortHandler);
      } catch (err) {
        // ignore listener cleanup failures
      }
    };
    try {
      child =
        process.platform === 'win32'
          ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', runFile], {
              windowsHide: true,
              stdio: 'ignore',
              env: process.env,
            })
          : spawn(
              'sh',
              ['-lc', buildCodexPosixShellCommand(codexBin, args, promptFile, logFile)],
              {
                windowsHide: true,
                stdio: 'ignore',
                env: process.env,
              }
            );
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        spawnError: err,
        aborted,
      });
      return;
    }

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortHandler = () => {
        aborted = true;
        try {
          child.kill();
        } catch (err) {
          // ignore kill failures while cancelling
        }
      };
      if (abortSignal.aborted) {
        abortHandler();
      } else {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    child.on('error', (err) => {
      cleanupAbortListener();
      resolve({
        exitCode: null,
        signal: null,
        spawnError: err,
        aborted,
      });
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      cleanupAbortListener();
      resolve({
        exitCode,
        signal,
        spawnError: null,
        aborted,
      });
    });
  });

  let outputText = '';
  let logText = '';
  try {
    outputText = (await fs.readFile(outputFile, 'utf8')).trim();
  } catch (err) {
    outputText = '';
  }

  try {
    logText = await fs.readFile(logFile, 'utf8');
  } catch (err) {
    logText = '';
  }

  if (timedOut) {
    const timeoutError = new Error(`codex timed out after ${timeoutMs}ms`);
    timeoutError.status = 504;
    await Promise.allSettled([
      fs.unlink(promptFile),
      fs.unlink(outputFile),
      fs.unlink(logFile),
      fs.unlink(runFile),
    ]);
    throw timeoutError;
  }

  if (result.aborted) {
    await Promise.allSettled([
      fs.unlink(promptFile),
      fs.unlink(outputFile),
      fs.unlink(logFile),
      fs.unlink(runFile),
    ]);
    throw createClientCancelledError();
  }

  if (result.spawnError) {
    const spawnError = new Error(
      `Failed to launch codex CLI (${codexBin}): ${result.spawnError.message}`
    );
    spawnError.status = 500;
    await Promise.allSettled([
      fs.unlink(promptFile),
      fs.unlink(outputFile),
      fs.unlink(logFile),
      fs.unlink(runFile),
    ]);
    throw spawnError;
  }

  if (result.exitCode !== 0) {
    const detail = summarizeCliFailure(logText, result.exitCode, result.signal);
    const cliError = new Error(detail || 'codex request failed');
    cliError.status = 502;
    await Promise.allSettled([
      fs.unlink(promptFile),
      fs.unlink(outputFile),
      fs.unlink(logFile),
      fs.unlink(runFile),
    ]);
    throw cliError;
  }

  if (!outputText) {
    const emptyError = new Error('codex returned an empty response');
    emptyError.status = 502;
    await Promise.allSettled([
      fs.unlink(promptFile),
      fs.unlink(outputFile),
      fs.unlink(logFile),
      fs.unlink(runFile),
    ]);
    throw emptyError;
  }

  await Promise.allSettled([
    fs.unlink(promptFile),
    fs.unlink(outputFile),
    fs.unlink(logFile),
    fs.unlink(runFile),
  ]);

  return {
    outputText,
    elapsedMs: Date.now() - startTime,
  };
}

async function runCodexStream(
  config,
  promptText,
  requestedModel,
  requestedReasoningEffort,
  timeoutOverrideMs,
  onEvent,
  onRawOutput,
  abortSignal
) {
  if (abortSignal && abortSignal.aborted) {
    throw createClientCancelledError();
  }
  const codexBin = await ensureResolvedCodexBin(config);
  await fs.mkdir(config.tempDir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const outputFile = path.join(config.tempDir, `overleaf-assist-${id}.output.txt`);
  const runFile = path.join(config.tempDir, `overleaf-assist-${id}.stream.cmd`);

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    config.codexSandbox,
    '--color',
    'never',
    '--json',
    '--output-last-message',
    outputFile,
  ];

  const model =
    typeof requestedModel === 'string' && requestedModel.trim()
      ? requestedModel.trim()
      : config.codexModel;
  if (model) {
    args.push('--model', model);
  }

  if (requestedReasoningEffort && requestedReasoningEffort !== 'default') {
    args.push('--config', `model_reasoning_effort="${requestedReasoningEffort}"`);
  }

  args.push('-');

  if (process.platform === 'win32') {
    await fs.writeFile(runFile, buildCodexWindowsExecScript(codexBin, args), 'ascii');
  }

  const startTime = Date.now();
  const timeoutMs = Number(timeoutOverrideMs) > 0 ? Number(timeoutOverrideMs) : config.codexTimeoutMs;
  let timedOut = false;
  let usage = null;
  let totalUsage = null;
  let lastUsage = null;
  let modelContextWindow = null;
  let rateLimits = null;
  let spawnError = null;
  const stdoutTail = [];
  const stderrTail = [];
  let warningsCount = 0;
  let stdoutBuffer = '';
  let stderrBuffer = '';
  let emittedGeneratingProgress = false;
  let sawTurnCompleted = false;

  const processStdoutLine = (line) => {
    const trimmed = `${line || ''}`.trim();
    if (!trimmed) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed.type !== 'string') {
        return;
      }

      if (parsed.type === 'thread.started') {
        safeEmitProgressEvent(onEvent, 'thread_started', 'Session started');
        return;
      }
      if (parsed.type === 'turn.started') {
        safeEmitProgressEvent(onEvent, 'turn_started', 'Running Codex...');
        return;
      }
      if (parsed.type === 'token_count') {
        const tokenInfo = normalizeTokenCountInfo(parsed.info);
        const parsedRateLimits = normalizeRateLimits(parsed.rate_limits);
        if (tokenInfo) {
          if (tokenInfo.total_usage) {
            totalUsage = tokenInfo.total_usage;
          }
          if (tokenInfo.last_usage) {
            lastUsage = tokenInfo.last_usage;
            if (!usage) {
              usage = tokenInfo.last_usage;
            }
          }
          if (Number.isFinite(Number(tokenInfo.model_context_window))) {
            modelContextWindow = Math.max(0, Math.floor(Number(tokenInfo.model_context_window)));
          }
        }
        if (parsedRateLimits) {
          rateLimits = parsedRateLimits;
        }
        return;
      }
      if (parsed.type === 'item.completed') {
        const itemType = parsed.item && typeof parsed.item.type === 'string' ? parsed.item.type : '';
        if (!emittedGeneratingProgress && itemType === 'agent_message') {
          emittedGeneratingProgress = true;
          safeEmitProgressEvent(onEvent, 'generating', 'Generating final response...');
        }
        return;
      }
      if (parsed.type === 'turn.completed') {
        usage = normalizeCodexUsage(parsed.usage);
        sawTurnCompleted = true;
        safeEmitProgressEvent(onEvent, 'turn_completed', 'Run completed');
      }
      return;
    } catch (err) {
      pushTailLine(stdoutTail, trimmed, 24);
    }
  };

  const processBufferedLines = (bufferValue, onLine, flushTail) => {
    let buffer = bufferValue;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, '');
      onLine(rawLine);
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf('\n');
    }
    if (flushTail) {
      const tail = buffer.replace(/\r$/, '');
      if (tail) {
        onLine(tail);
      }
      buffer = '';
    }
    return buffer;
  };

  const result = await new Promise((resolve) => {
    let settled = false;
    let child = null;
    let heartbeatTimer = null;
    let aborted = false;
    let abortHandler = null;
    const cleanupAbortListener = () => {
      if (!abortSignal || !abortHandler || typeof abortSignal.removeEventListener !== 'function') {
        return;
      }
      try {
        abortSignal.removeEventListener('abort', abortHandler);
      } catch (err) {
        // ignore listener cleanup failures
      }
    };

    try {
      if (process.platform === 'win32') {
        child = spawn(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/c', runFile],
          {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
          }
        );
      } else {
        child = spawn(codexBin, args, {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
      }
    } catch (err) {
      spawnError = err;
      resolve({
        exitCode: null,
        signal: null,
        aborted,
      });
      return;
    }

    if (abortSignal && typeof abortSignal.addEventListener === 'function') {
      abortHandler = () => {
        aborted = true;
        try {
          child.kill();
        } catch (err) {
          // ignore kill failures while cancelling
        }
      };
      if (abortSignal.aborted) {
        abortHandler();
      } else {
        abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch (err) {
        // ignore kill failures on timeout
      }
    }, timeoutMs);

    heartbeatTimer = setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
      safeEmitProgressEvent(onEvent, 'running', `Still running (${elapsedSeconds}s)...`);
    }, 20000);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      safeEmitRawOutput(onRawOutput, 'stdout', text);
      stdoutBuffer += text;
      stdoutBuffer = processBufferedLines(stdoutBuffer, processStdoutLine, false);
    });

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      safeEmitRawOutput(onRawOutput, 'stderr', text);
      stderrBuffer += text;
      stderrBuffer = processBufferedLines(
        stderrBuffer,
        (line) => {
          const trimmed = `${line || ''}`.trim();
          if (!trimmed) {
            return;
          }
          warningsCount += 1;
          pushTailLine(stderrTail, trimmed, 24);
        },
        false
      );
    });

    child.stdin.on('error', () => {
      // ignore stdin write errors; child close handler will report failure
    });

    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      cleanupAbortListener();
      spawnError = err;
      resolve({
        exitCode: null,
        signal: null,
        aborted,
      });
    });

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
      cleanupAbortListener();
      resolve({
        exitCode,
        signal,
        aborted,
      });
    });

    try {
      child.stdin.end(promptText, 'utf8');
    } catch (err) {
      try {
        child.stdin.end();
      } catch (endErr) {
        // ignore
      }
    }
  });

  stdoutBuffer = processBufferedLines(stdoutBuffer, processStdoutLine, true);
  stderrBuffer = processBufferedLines(
    stderrBuffer,
    (line) => {
      const trimmed = `${line || ''}`.trim();
      if (!trimmed) {
        return;
      }
      warningsCount += 1;
      pushTailLine(stderrTail, trimmed, 24);
    },
    true
  );

  let outputText = '';
  try {
    outputText = (await fs.readFile(outputFile, 'utf8')).trim();
  } catch (err) {
    outputText = '';
  }

  await Promise.allSettled([fs.unlink(outputFile), fs.unlink(runFile)]);

  if (result.aborted) {
    throw createClientCancelledError();
  }

  const normalizedUsage = usage || lastUsage || totalUsage || null;
  const tokenMetrics = {
    usage: normalizedUsage,
    total_usage: totalUsage,
    last_usage: lastUsage,
    model_context_window: modelContextWindow,
    rate_limits: rateLimits,
  };

  if (timedOut && sawTurnCompleted && outputText) {
    safeEmitProgressEvent(
      onEvent,
      'finalizing',
      'Codex completed before timeout; using captured result.'
    );
    return {
      outputText,
      elapsedMs: Date.now() - startTime,
      usage: normalizedUsage,
      warningsCount,
      token_metrics: tokenMetrics,
    };
  }

  if (timedOut) {
    const timeoutError = new Error(`codex timed out after ${timeoutMs}ms`);
    timeoutError.status = 504;
    throw timeoutError;
  }

  if (spawnError) {
    const processError = new Error(
      `Failed to launch codex CLI (${codexBin}): ${spawnError.message}`
    );
    processError.status = 500;
    throw processError;
  }

  if (result.exitCode !== 0) {
    const combinedLog = [...stdoutTail, ...stderrTail].join('\n');
    const detail = summarizeCliFailure(combinedLog, result.exitCode, result.signal);
    const cliError = new Error(detail || 'codex request failed');
    cliError.status = 502;
    throw cliError;
  }

  if (!outputText) {
    const emptyError = new Error('codex returned an empty response');
    emptyError.status = 502;
    throw emptyError;
  }

  return {
    outputText,
    elapsedMs: Date.now() - startTime,
    usage: normalizedUsage,
    warningsCount,
    token_metrics: tokenMetrics,
  };
}

function createProjectSessionManager(config, runtime) {
  const sessionsById = new Map();
  const sessionsByProjectId = new Map();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const CHAT_TURN_LIMIT = 120;
  const EVENT_BUFFER_LIMIT = 256;

  function createSession(projectId) {
    return {
      session_id: crypto.randomUUID(),
      project_id: projectId,
      status: 'idle',
      status_message: '',
      seq: 0,
      updated_at: Date.now(),
      active_run_id: null,
      active_abort_controller: null,
      current_progress_key: '',
      last_response_text: '',
      last_result: null,
      chat_turns: [],
      session_usage: createEmptySessionUsage(),
      raw_cli_log: [],
      raw_cli_entry_seq: 0,
      events: [],
      subscribers: new Map(),
      active_run_promise: null,
    };
  }

  function cloneLastResult(result) {
    if (!result || typeof result !== 'object') {
      return null;
    }
    return {
      status:
        typeof result.status === 'string' && result.status.trim()
          ? result.status.trim()
          : 'completed',
      output_text: typeof result.output_text === 'string' ? result.output_text : '',
      elapsed_ms: Number.isFinite(Number(result.elapsed_ms))
        ? Math.max(0, Math.floor(Number(result.elapsed_ms)))
        : null,
      usage: normalizeCodexUsage(result.usage),
      warnings_count: Number.isFinite(Number(result.warnings_count))
        ? Math.max(0, Math.floor(Number(result.warnings_count)))
        : 0,
      response_id:
        typeof result.response_id === 'string' && result.response_id.trim()
          ? result.response_id.trim()
          : null,
      error:
        typeof result.error === 'string' && result.error.trim() ? result.error.trim() : null,
      error_status: Number.isFinite(Number(result.error_status))
        ? Math.max(0, Math.floor(Number(result.error_status)))
        : null,
      completed_at:
        typeof result.completed_at === 'string' && result.completed_at.trim()
          ? result.completed_at.trim()
          : null,
    };
  }

  function buildSessionSnapshot(session) {
    return {
      session_id: session.session_id,
      project_id: session.project_id,
      status: session.status,
      status_message: session.status_message || '',
      updated_at: session.updated_at,
      active_run_id: session.active_run_id,
      chat_turns: session.chat_turns
        .map((turn) => normalizeChatTurn(turn))
        .filter(Boolean),
      last_response_text: session.last_response_text || '',
      last_result: cloneLastResult(session.last_result),
      session_usage: cloneSessionUsage(session.session_usage),
      last_seq: session.seq,
    };
  }

  function cloneRawCliEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    const stream =
      entry.stream === 'stderr' || entry.stream === 'stdout' ? entry.stream : 'stdout';
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text) {
      return null;
    }
    return {
      seq: Number.isFinite(Number(entry.seq))
        ? Math.max(0, Math.floor(Number(entry.seq)))
        : 0,
      stream,
      text,
      ts: Number.isFinite(Number(entry.ts)) ? Math.max(0, Math.floor(Number(entry.ts))) : Date.now(),
    };
  }

  function cloneRawCliLog(rawCliLog) {
    if (!Array.isArray(rawCliLog)) {
      return [];
    }
    return rawCliLog.map((entry) => cloneRawCliEntry(entry)).filter(Boolean);
  }

  function buildSessionSummary(session) {
    return {
      session_id: session.session_id,
      project_id: session.project_id,
      status: session.status,
      status_message: session.status_message || '',
      updated_at: session.updated_at,
      active_run_id: session.active_run_id,
      session_usage: cloneSessionUsage(session.session_usage),
      last_seq: session.seq,
    };
  }

  function buildDesktopSessionDetail(session) {
    return {
      ...buildSessionSnapshot(session),
      raw_cli_log: cloneRawCliLog(session.raw_cli_log),
    };
  }

  function notifySessionUpdate(session, eventPayload, options = {}) {
    try {
      emitter.emit('session:update', {
        session: buildSessionSummary(session),
        event: eventPayload || null,
        raw_cli_entry: cloneRawCliEntry(options.rawCliEntry),
      });
    } catch (err) {
      // ignore listener errors so bridge state remains stable
    }
  }

  function notifySessionDeleted(session) {
    try {
      emitter.emit('session:update', {
        deleted: true,
        session_id: session.session_id,
        project_id: session.project_id,
      });
    } catch (err) {
      // ignore listener errors so bridge state remains stable
    }
  }

  function appendChatTurn(session, role, text, options = {}) {
    const normalizedText = typeof text === 'string' ? text.trim() : '';
    if (!normalizedText) {
      return null;
    }
    const turn = {
      role,
      text: normalizedText,
      ts: Date.now(),
    };
    if (typeof options.tag === 'string' && options.tag.trim()) {
      turn.tag = options.tag.trim();
    }
    const normalizedTurn = normalizeChatTurn(turn);
    if (!normalizedTurn) {
      return null;
    }
    session.chat_turns.push(normalizedTurn);
    if (session.chat_turns.length > CHAT_TURN_LIMIT) {
      session.chat_turns.splice(0, session.chat_turns.length - CHAT_TURN_LIMIT);
    }
    session.updated_at = Date.now();
    notifySessionUpdate(session, null);
    return normalizedTurn;
  }

  function emitSessionEvent(session, eventName, payload = {}) {
    session.seq += 1;
    session.updated_at = Date.now();
    const eventPayload = {
      seq: session.seq,
      session_id: session.session_id,
      project_id: session.project_id,
      run_id:
        typeof payload.run_id === 'string' && payload.run_id.trim()
          ? payload.run_id.trim()
          : session.active_run_id,
      event: eventName,
      timestamp: new Date(session.updated_at).toISOString(),
      ...payload,
    };
    session.events.push(eventPayload);
    if (session.events.length > EVENT_BUFFER_LIMIT) {
      session.events.splice(0, session.events.length - EVENT_BUFFER_LIMIT);
    }
    for (const send of session.subscribers.values()) {
      try {
        send(eventPayload);
      } catch (err) {
        // ignore dead subscribers; HTTP disconnect cleanup handles removal
      }
    }
    notifySessionUpdate(session, eventPayload);
    return eventPayload;
  }

  function appendRawCliOutput(session, rawOutput) {
    const normalized = cloneRawCliEntry({
      seq: session.raw_cli_entry_seq + 1,
      stream: rawOutput && rawOutput.stream,
      text: rawOutput && rawOutput.text,
      ts: rawOutput && rawOutput.ts,
    });
    if (!normalized) {
      return null;
    }
    session.raw_cli_entry_seq = normalized.seq;
    session.raw_cli_log.push(normalized);
    session.updated_at = Date.now();
    notifySessionUpdate(session, null, {
      rawCliEntry: normalized,
    });
    return normalized;
  }

  function ensureSession(projectId) {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    if (!normalizedProjectId) {
      const error = new Error('projectId is required');
      error.status = 400;
      throw error;
    }
    const existing = sessionsByProjectId.get(normalizedProjectId);
    if (existing) {
      return existing;
    }
    const session = createSession(normalizedProjectId);
    sessionsByProjectId.set(normalizedProjectId, session);
    sessionsById.set(session.session_id, session);
    notifySessionUpdate(session, null);
    return session;
  }

  function getSessionByProjectId(projectId) {
    const normalizedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
    if (!normalizedProjectId) {
      return null;
    }
    return sessionsByProjectId.get(normalizedProjectId) || null;
  }

  function getSessionById(sessionId) {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!normalizedSessionId) {
      return null;
    }
    return sessionsById.get(normalizedSessionId) || null;
  }

  function listSessions() {
    return [...sessionsByProjectId.values()]
      .sort((a, b) => b.updated_at - a.updated_at)
      .map((session) => buildSessionSummary(session));
  }

  function createBusyError(session) {
    const error = new Error('project session already has an active run');
    error.status = 409;
    error.payload = {
      error: 'project session already has an active run',
      session_id: session.session_id,
      run_id: session.active_run_id,
      status: session.status,
      last_seq: session.seq,
      session: buildSessionSnapshot(session),
    };
    return error;
  }

  function validateStartRunBody(body) {
    const payload = body && typeof body === 'object' ? body : {};
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    const content = typeof payload.content === 'string' ? payload.content : '';
    const scope = typeof payload.scope === 'string' ? payload.scope : 'auto';
    const model = typeof payload.model === 'string' ? payload.model.trim() : '';
    const userPromptRaw =
      typeof payload.user_prompt === 'string' && payload.user_prompt.trim()
        ? payload.user_prompt.trim()
        : prompt;
    const timeoutResult = resolveRequestTimeoutMs(payload.timeout_ms);
    if (timeoutResult.error) {
      const error = new Error(timeoutResult.error);
      error.status = 400;
      throw error;
    }
    const requestedReasoningEffortRaw =
      typeof payload.reasoning_effort === 'string'
        ? payload.reasoning_effort.trim().toLowerCase() || 'default'
        : 'default';
    if (
      requestedReasoningEffortRaw !== 'default' &&
      !normalizeReasoningEffort(requestedReasoningEffortRaw)
    ) {
      const error = new Error(
        'reasoning_effort must be one of: default, minimal, low, medium, high, xhigh'
      );
      error.status = 400;
      throw error;
    }
    if (!prompt || !content) {
      const error = new Error('prompt and content are required');
      error.status = 400;
      throw error;
    }
    return {
      prompt,
      content,
      scope,
      model,
      userPrompt: userPromptRaw,
      timeoutMs: timeoutResult.value,
      requestedReasoningEffortRaw,
      reasoningEffort:
        requestedReasoningEffortRaw === 'default'
          ? 'default'
          : normalizeReasoningEffort(requestedReasoningEffortRaw) || 'default',
      usedSelection: Boolean(payload.used_selection),
    };
  }

  async function startProjectRun(projectId, body) {
    const session = ensureSession(projectId);
    if (session.active_run_id) {
      throw createBusyError(session);
    }

    const request = validateStartRunBody(body);
    const runId = crypto.randomUUID();
    const estimatedInputTokens =
      estimateTokens(request.prompt) + estimateTokens(request.content);
    const selectedModel =
      request.model ||
      (typeof config.codexModel === 'string' && config.codexModel.trim()
        ? config.codexModel.trim()
        : null);
    const codexPrompt = buildCodexPrompt(request.prompt, request.content, request.scope);

    appendChatTurn(session, 'user', request.userPrompt);
    session.active_run_id = runId;
    session.active_abort_controller = new AbortController();
    session.status = 'running';
    session.status_message = 'Running Codex...';
    session.current_progress_key = '';
    session.updated_at = Date.now();

    emitSessionEvent(session, 'run_started', {
      run_id: runId,
      model: selectedModel,
      reasoning_effort: request.reasoningEffort,
      used_selection: request.usedSelection,
      user_prompt: request.userPrompt,
    });

    const runPromise = (async () => {
      try {
        const result = await runCodexStream(
          config,
          codexPrompt,
          request.model,
          request.requestedReasoningEffortRaw,
          request.timeoutMs,
          (progress) => {
            if (session.active_run_id !== runId) {
              return;
            }
            const stage =
              progress && typeof progress.stage === 'string' && progress.stage.trim()
                ? progress.stage.trim()
                : 'progress';
            const message =
              progress && typeof progress.message === 'string' && progress.message.trim()
                ? progress.message.trim()
                : stage;
            session.status_message = message;
            if (stage !== 'running') {
              const progressKey = `${stage}::${message}`;
              if (progressKey !== session.current_progress_key) {
                session.current_progress_key = progressKey;
                appendChatTurn(session, 'system', `[${stage}] ${message}`);
              }
            }
            emitSessionEvent(session, 'progress', {
              run_id: runId,
              stage,
              message,
            });
          },
          (rawOutput) => {
            if (session.active_run_id !== runId) {
              return;
            }
            appendRawCliOutput(session, rawOutput);
          },
          session.active_abort_controller.signal
        );

        if (result && hasTokenMetricsData(result.token_metrics)) {
          runtime.tokenMetrics = mergeTokenMetrics(runtime.tokenMetrics, result.token_metrics);
        }

        session.status = 'completed';
        session.status_message = 'Run completed.';
        session.last_response_text = result.outputText || '';
        session.last_result = {
          status: 'completed',
          output_text: session.last_response_text,
          elapsed_ms: result.elapsedMs,
          usage: result.usage,
          warnings_count: result.warningsCount,
          response_id: null,
          completed_at: new Date().toISOString(),
        };
        session.session_usage.estimated_input_tokens += estimatedInputTokens;
        session.session_usage.estimated_output_tokens += estimateTokens(session.last_response_text);
        session.session_usage.estimated_total_tokens =
          session.session_usage.estimated_input_tokens +
          session.session_usage.estimated_output_tokens;
        session.session_usage.last_usage = normalizeCodexUsage(result.usage);
        session.session_usage.total_usage = mergeUsageTotals(
          session.session_usage.total_usage,
          result.usage
        );
        session.session_usage.warnings_count += Number.isFinite(Number(result.warningsCount))
          ? Math.max(0, Math.floor(Number(result.warningsCount)))
          : 0;

        const summaryText = buildRunSummaryText(result.usage, result.warningsCount);
        if (summaryText) {
          appendChatTurn(session, 'system', summaryText);
        }
        appendChatTurn(session, 'assistant', session.last_response_text || '(empty response)');

        emitSessionEvent(session, 'summary', {
          run_id: runId,
          elapsed_ms: result.elapsedMs,
          usage: normalizeCodexUsage(result.usage),
          warnings_count: Number.isFinite(Number(result.warningsCount))
            ? Math.max(0, Math.floor(Number(result.warningsCount)))
            : 0,
        });

        emitSessionEvent(session, 'result', {
          run_id: runId,
          output_text: session.last_response_text,
          elapsed_ms: result.elapsedMs,
          usage: normalizeCodexUsage(result.usage),
          response_id: null,
        });
      } catch (err) {
        const cancelled = err && (err.cancelled === true || Number(err.status) === 499);
        session.status = cancelled ? 'cancelled' : 'error';
        session.status_message = cancelled
          ? 'Run stopped.'
          : err && err.message
            ? err.message
            : 'Request failed';
        session.last_result = {
          status: cancelled ? 'cancelled' : 'error',
          output_text: session.last_response_text || '',
          elapsed_ms: null,
          usage: null,
          warnings_count: 0,
          response_id: null,
          error: session.status_message,
          error_status: err && Number.isFinite(Number(err.status))
            ? Math.max(0, Math.floor(Number(err.status)))
            : cancelled
              ? 499
              : 500,
          completed_at: new Date().toISOString(),
        };
        if (cancelled) {
          appendChatTurn(session, 'system', 'Run stopped.');
          emitSessionEvent(session, 'cancelled', {
            run_id: runId,
            message: 'Run stopped.',
            status: 499,
          });
        } else {
          appendChatTurn(session, 'system', `ERROR: ${session.status_message}`);
          emitSessionEvent(session, 'error', {
            run_id: runId,
            message: session.status_message,
            status: err && Number.isFinite(Number(err.status))
              ? Math.max(0, Math.floor(Number(err.status)))
              : 500,
          });
        }
      } finally {
        session.active_run_id = null;
        session.active_abort_controller = null;
        session.current_progress_key = '';
        session.active_run_promise = null;
        session.updated_at = Date.now();
        notifySessionUpdate(session, null);
      }
    })();
    session.active_run_promise = runPromise;

    return {
      session_id: session.session_id,
      run_id: runId,
      status: 'running',
      last_seq: session.seq,
      session: buildSessionSnapshot(session),
    };
  }

  function cancelSession(sessionId) {
    const session = getSessionById(sessionId);
    if (!session) {
      const error = new Error('session not found');
      error.status = 404;
      throw error;
    }
    if (session.active_abort_controller) {
      session.status_message = 'Stopping...';
      try {
        session.active_abort_controller.abort();
      } catch (err) {
        // ignore abort failures; the run close path will settle state
      }
    }
    notifySessionUpdate(session, null);
    return buildSessionSnapshot(session);
  }

  async function deleteSession(sessionId, options = {}) {
    const session = getSessionById(sessionId);
    if (!session) {
      const error = new Error('session not found');
      error.status = 404;
      throw error;
    }

    const cancelActive = options.cancelActive !== false;
    if (session.active_run_promise) {
      if (!cancelActive) {
        const error = new Error('session has an active run');
        error.status = 409;
        throw error;
      }
      if (session.active_abort_controller) {
        session.status_message = 'Stopping before delete...';
        notifySessionUpdate(session, null);
        try {
          session.active_abort_controller.abort();
        } catch (err) {
          // ignore abort failures; the active run promise will settle state
        }
      }
      try {
        await session.active_run_promise;
      } catch (err) {
        // ignore run failures while deleting the stored session
      }
    }

    session.subscribers.clear();
    sessionsById.delete(session.session_id);
    sessionsByProjectId.delete(session.project_id);
    notifySessionDeleted(session);
    return {
      deleted: true,
      session_id: session.session_id,
      project_id: session.project_id,
    };
  }

  function subscribeToSessionEvents(sessionId, onEvent, afterSeq) {
    const session = getSessionById(sessionId);
    if (!session) {
      const error = new Error('session not found');
      error.status = 404;
      throw error;
    }
    const send =
      typeof onEvent === 'function'
        ? onEvent
        : () => {};
    send({
      seq: session.seq,
      session_id: session.session_id,
      project_id: session.project_id,
      run_id: session.active_run_id,
      event: 'session_snapshot',
      timestamp: new Date(session.updated_at).toISOString(),
      session: buildSessionSnapshot(session),
    });
    const cursor = Number.isFinite(Number(afterSeq))
      ? Math.max(0, Math.floor(Number(afterSeq)))
      : 0;
    for (const eventPayload of session.events) {
      if (eventPayload.seq > cursor) {
        send(eventPayload);
      }
    }
    const subscriberId = crypto.randomUUID();
    session.subscribers.set(subscriberId, send);
    return () => {
      session.subscribers.delete(subscriberId);
    };
  }

  function onUpdate(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    emitter.on('session:update', listener);
    return () => {
      emitter.removeListener('session:update', listener);
    };
  }

  return {
    ensureSession,
    getSessionById,
    getSessionByProjectId,
    listSessions,
    buildSessionSnapshot,
    buildDesktopSessionDetail,
    startProjectRun,
    cancelSession,
    deleteSession,
    subscribeToSessionEvents,
    onUpdate,
  };
}

function inferDoctorIssues(text) {
  const value = `${text || ''}`.toLowerCase();
  const issues = [];
  if (
    /failed to launch codex cli|command not found|is not recognized as an internal or external command|enoent|no such file or directory/.test(
      value
    )
  ) {
    issues.push('codex_missing');
  }
  if (/authentication failed|not logged in|unauthorized|forbidden/.test(value)) {
    issues.push('codex_not_logged_in');
  }
  if (
    /could not reach the model api|api\.openai\.com|stream disconnected|error sending request|network|timed out/.test(
      value
    )
  ) {
    issues.push('network_blocked');
  }
  return [...new Set(issues)];
}

async function fileExists(filepath) {
  try {
    await fs.access(filepath);
    return true;
  } catch (err) {
    return false;
  }
}

async function detectCodexBinary(config) {
  const probeBinary = async (candidate) => {
    if (!candidate) {
      return false;
    }
    if (looksLikePath(candidate)) {
      const exists = await fileExists(candidate);
      if (!exists) {
        return false;
      }
      if (process.platform === 'win32') {
        return true;
      }
      return canExecuteCodexBinary(candidate);
    }
    return canExecuteCodexBinary(candidate);
  };

  let codexBin = await ensureResolvedCodexBin(config);
  if (await probeBinary(codexBin)) {
    return true;
  }

  const refreshed = await resolveCodexBinary(config);
  if (refreshed && refreshed !== codexBin) {
    config.resolvedCodexBin = refreshed;
    codexBin = refreshed;
  }
  return probeBinary(codexBin);
}

async function runDoctorProbe(config, timeoutOverrideMs) {
  const probePrompt =
    'You are performing a system readiness probe. Reply with exactly OK and no additional text.';
  const timeoutMs = Number(timeoutOverrideMs) > 0
    ? Number(timeoutOverrideMs)
    : Math.min(config.codexTimeoutMs, 25000);
  try {
    await runCodex(config, probePrompt, '', 'default', timeoutMs);
    return {
      ok: true,
      issues: [],
    };
  } catch (err) {
    const issues = inferDoctorIssues(err.message || '');
    return {
      ok: false,
      issues,
      detail: err.message || 'Codex probe failed',
    };
  }
}

async function computeDoctorDiagnostics(config, shouldProbe) {
  const issues = new Set();
  const codexInstalled = await detectCodexBinary(config);
  const authArtifact = await detectCodexAuthArtifact(config);
  let codexLoggedIn = false;
  let networkOk = false;
  let probe = null;

  if (!codexInstalled) {
    issues.add('codex_missing');
  } else {
    codexLoggedIn = authArtifact.found;

    if (shouldProbe || !codexLoggedIn) {
      probe = await runDoctorProbe(
        config,
        shouldProbe ? Math.min(config.codexTimeoutMs, 25000) : Math.min(config.codexTimeoutMs, 8000)
      );
      if (probe.ok) {
        codexLoggedIn = true;
        networkOk = true;
      } else {
        for (const issue of probe.issues) {
          issues.add(issue);
        }
        if (probe.issues.includes('codex_not_logged_in')) {
          codexLoggedIn = false;
        }
      }
    }

    if (!probe) {
      networkOk = codexLoggedIn;
    }

    if (!codexLoggedIn) {
      issues.add('codex_not_logged_in');
    }
  }

  if (!codexInstalled || !codexLoggedIn) {
    networkOk = false;
  }

  return {
    codex_installed: codexInstalled,
    codex_logged_in: codexLoggedIn,
    network_ok: networkOk,
    issues: [...issues],
    codex_bin: config.resolvedCodexBin || config.codexBin,
    codex_auth_artifact_found: authArtifact.found,
    codex_auth_artifact_path: authArtifact.path || null,
    probe_detail: probe && !probe.ok ? probe.detail || null : null,
  };
}

function createBridgeApp(config) {
  const app = express();
  const runtime = {
    doctorCache: {
      at: 0,
      value: null,
      probe: false,
    },
    tokenMetrics: createEmptyTokenMetrics(),
  };
  runtime.sessionController = createProjectSessionManager(config, runtime);

  async function getDoctorDiagnostics(options = {}) {
    const probe = Boolean(options.probe);
    const maxAgeMs = Number(options.maxAgeMs) || 0;
    const now = Date.now();
    const hasCache = runtime.doctorCache.value && now - runtime.doctorCache.at <= maxAgeMs;
    const probeSatisfied = !probe || runtime.doctorCache.probe;
    if (hasCache && probeSatisfied) {
      return runtime.doctorCache.value;
    }

    const result = await computeDoctorDiagnostics(config, probe);
    runtime.doctorCache = {
      at: now,
      value: result,
      probe,
    };
    return result;
  }

  app.use(express.json({ limit: '4mb' }));
  app.use(
    cors({
      origin: config.allowedOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type'],
    })
  );

  app.get('/', (req, res) => {
    res.json({
      ok: true,
      message: 'Overleaf Assist Demo Proxy (Codex CLI)',
      codex_bin: config.resolvedCodexBin || config.codexBin,
      codex_model: config.codexModel || null,
      codex_sandbox: config.codexSandbox,
      codex_timeout_ms: config.codexTimeoutMs,
    });
  });

  app.get('/health', async (req, res) => {
    try {
      const doctor = await getDoctorDiagnostics({ probe: false, maxAgeMs: 5000 });
      res.json({
        ok: true,
        service: config.serviceName,
        version: BRIDGE_VERSION,
        port: config.port,
        codex_bin_detected: doctor.codex_installed,
        codex_ready: doctor.codex_installed && doctor.codex_logged_in,
        token_metrics: runtime.tokenMetrics,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        service: config.serviceName,
        version: BRIDGE_VERSION,
        port: config.port,
        codex_bin_detected: false,
        codex_ready: false,
        token_metrics: runtime.tokenMetrics,
        error: err.message || 'Health check failed',
      });
    }
  });

  app.get('/doctor', async (req, res) => {
    try {
      const probeRaw =
        typeof req.query.probe === 'string' ? req.query.probe.trim().toLowerCase() : '';
      const shouldProbe = probeRaw
        ? ['1', 'true', 'yes', 'on'].includes(probeRaw)
        : true;
      const doctor = await getDoctorDiagnostics({
        probe: shouldProbe,
        maxAgeMs: shouldProbe ? 10000 : 5000,
      });
      res.json(doctor);
    } catch (err) {
      res.status(500).json({
        codex_installed: false,
        codex_logged_in: false,
        network_ok: false,
        issues: ['doctor_failed'],
        error: err.message || 'Diagnostics failed',
      });
    }
  });

  app.get('/models', async (req, res) => {
    try {
      const metadata = await loadModelsMetadata(config);
      res.json(metadata);
    } catch (err) {
      res.status(500).json({ error: err.message || 'Failed to load model metadata' });
    }
  });

  app.get('/session/project/:projectId', async (req, res) => {
    try {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const session = runtime.sessionController.getSessionByProjectId(projectId);
      if (!session) {
        res.status(404).json({ error: 'session not found' });
        return;
      }
      res.json(runtime.sessionController.buildSessionSnapshot(session));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to load session' });
    }
  });

  app.post('/session/project/:projectId/run', async (req, res) => {
    try {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const result = await runtime.sessionController.startProjectRun(projectId, req.body || {});
      res.json(result);
    } catch (err) {
      if (Number(err && err.status) === 409 && err && err.payload) {
        res.status(409).json(err.payload);
        return;
      }
      res.status(err.status || 500).json({ error: err.message || 'Failed to start session run' });
    }
  });

  app.get('/session/:sessionId/events', async (req, res) => {
    let unsubscribe = null;
    try {
      const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
      const afterSeq =
        typeof req.query.after === 'string' && req.query.after.trim()
          ? Number(req.query.after)
          : 0;

      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      const send = (payload) => {
        if (res.writableEnded) {
          return;
        }
        try {
          res.write(`${JSON.stringify(payload)}\n`);
          if (typeof res.flush === 'function') {
            res.flush();
          }
        } catch (err) {
          // ignore socket write errors; close handler removes subscription
        }
      };

      unsubscribe = runtime.sessionController.subscribeToSessionEvents(
        sessionId,
        send,
        afterSeq
      );

      const heartbeatTimer = setInterval(() => {
        if (res.writableEnded) {
          return;
        }
        try {
          res.write('\n');
        } catch (err) {
          // ignore keepalive write failures
        }
      }, 15000);

      const cleanup = () => {
        clearInterval(heartbeatTimer);
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe();
          } catch (err) {
            // ignore cleanup failures
          }
        }
        unsubscribe = null;
      };

      req.on('aborted', cleanup);
      res.on('close', cleanup);
    } catch (err) {
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch (unsubscribeErr) {
          // ignore cleanup failures
        }
      }
      if (!res.headersSent) {
        res.status(err.status || 500).json({ error: err.message || 'Failed to stream session events' });
      } else if (!res.writableEnded) {
        try {
          res.end();
        } catch (endErr) {
          // ignore close failures after headers have been sent
        }
      }
    }
  });

  app.post('/session/:sessionId/cancel', async (req, res) => {
    try {
      const sessionId = typeof req.params.sessionId === 'string' ? req.params.sessionId : '';
      const snapshot = runtime.sessionController.cancelSession(sessionId);
      res.json(snapshot);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message || 'Failed to cancel session run' });
    }
  });

  app.post('/assist-stream', async (req, res) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    const scope = typeof body.scope === 'string' ? body.scope : 'auto';
    const model = typeof body.model === 'string' ? body.model : '';
    const timeoutResult = resolveRequestTimeoutMs(body.timeout_ms);
    const requestedReasoningEffortRaw =
      typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort.trim().toLowerCase() || 'default'
        : 'default';

    if (timeoutResult.error) {
      res.status(400).json({ error: timeoutResult.error });
      return;
    }

    if (
      requestedReasoningEffortRaw !== 'default' &&
      !normalizeReasoningEffort(requestedReasoningEffortRaw)
    ) {
      res.status(400).json({
        error: 'reasoning_effort must be one of: default, minimal, low, medium, high, xhigh',
      });
      return;
    }

    if (!prompt || !content) {
      res.status(400).json({ error: 'prompt and content are required' });
      return;
    }

    const requestId = crypto.randomUUID();
    const selectedModel =
      typeof model === 'string' && model.trim()
        ? model.trim()
        : typeof config.codexModel === 'string' && config.codexModel.trim()
          ? config.codexModel.trim()
          : null;
    const selectedReasoningEffort =
      requestedReasoningEffortRaw === 'default'
        ? 'default'
        : normalizeReasoningEffort(requestedReasoningEffortRaw) || 'default';
    const codexPrompt = buildCodexPrompt(prompt, content, scope);

    res.status(200);
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const writeStreamEvent = (payload) => {
      if (res.writableEnded) {
        return;
      }
      try {
        res.write(`${JSON.stringify(payload)}\n`);
        if (typeof res.flush === 'function') {
          res.flush();
        }
      } catch (err) {
        // ignore write errors; close handler below will terminate response
      }
    };

    writeStreamEvent({
      event: 'run_started',
      request_id: requestId,
      model: selectedModel,
      reasoning_effort: selectedReasoningEffort,
      timestamp: new Date().toISOString(),
    });

    const abortController = new AbortController();
    const abortHandler = () => {
      try {
        abortController.abort();
      } catch (err) {
        // ignore abort controller failures
      }
    };
    const responseCloseAbortHandler = () => {
      if (res.writableEnded || res.finished) {
        return;
      }
      abortHandler();
    };
    req.on('aborted', abortHandler);
    res.on('close', responseCloseAbortHandler);

    try {
      const result = await runCodexStream(
        config,
        codexPrompt,
        model,
        requestedReasoningEffortRaw,
        timeoutResult.value,
        (progress) => {
          const stage =
            progress && typeof progress.stage === 'string' && progress.stage.trim()
              ? progress.stage.trim()
              : 'progress';
          const message =
            progress && typeof progress.message === 'string' && progress.message.trim()
              ? progress.message.trim()
              : stage;
          writeStreamEvent({
            event: 'progress',
            request_id: requestId,
            stage,
            message,
            timestamp: new Date().toISOString(),
          });
        },
        null,
        abortController.signal
      );

      if (result && hasTokenMetricsData(result.token_metrics)) {
        runtime.tokenMetrics = mergeTokenMetrics(runtime.tokenMetrics, result.token_metrics);
      }

      writeStreamEvent({
        event: 'summary',
        request_id: requestId,
        elapsed_ms: result.elapsedMs,
        usage: result.usage,
        warnings_count: result.warningsCount,
      });

      writeStreamEvent({
        event: 'result',
        request_id: requestId,
        output_text: result.outputText,
        elapsed_ms: result.elapsedMs,
        usage: result.usage,
        response_id: null,
      });
      res.end();
    } catch (err) {
      if (abortController.signal.aborted || (err && err.status === 499)) {
        if (!res.writableEnded) {
          try {
            res.end();
          } catch (endErr) {
            // ignore close failures on cancellation
          }
        }
        return;
      }
      writeStreamEvent({
        event: 'error',
        request_id: requestId,
        message: err && err.message ? err.message : 'Request failed',
        status: err && Number(err.status) ? Number(err.status) : 500,
      });
      res.end();
    } finally {
      req.off('aborted', abortHandler);
      res.off('close', responseCloseAbortHandler);
    }
  });

  app.post('/assist', async (req, res) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    const scope = typeof body.scope === 'string' ? body.scope : 'auto';
    const model = typeof body.model === 'string' ? body.model : '';
    const timeoutResult = resolveRequestTimeoutMs(body.timeout_ms);
    const requestedReasoningEffortRaw =
      typeof body.reasoning_effort === 'string'
        ? body.reasoning_effort.trim().toLowerCase() || 'default'
        : 'default';

    if (timeoutResult.error) {
      res.status(400).json({ error: timeoutResult.error });
      return;
    }

    if (
      requestedReasoningEffortRaw !== 'default' &&
      !normalizeReasoningEffort(requestedReasoningEffortRaw)
    ) {
      res.status(400).json({
        error: 'reasoning_effort must be one of: default, minimal, low, medium, high, xhigh',
      });
      return;
    }

    if (!prompt || !content) {
      res.status(400).json({ error: 'prompt and content are required' });
      return;
    }

    const codexPrompt = buildCodexPrompt(prompt, content, scope);
    const abortController = new AbortController();
    const abortHandler = () => {
      try {
        abortController.abort();
      } catch (err) {
        // ignore abort controller failures
      }
    };
    const responseCloseAbortHandler = () => {
      if (res.writableEnded || res.finished) {
        return;
      }
      abortHandler();
    };
    req.on('aborted', abortHandler);
    res.on('close', responseCloseAbortHandler);

    try {
      const result = await runCodex(
        config,
        codexPrompt,
        model,
        requestedReasoningEffortRaw,
        timeoutResult.value,
        abortController.signal
      );
      res.json({
        output_text: result.outputText,
        elapsed_ms: result.elapsedMs,
        usage: null,
        response_id: null,
      });
    } catch (err) {
      if (abortController.signal.aborted || (err && err.status === 499)) {
        if (!res.headersSent) {
          res.status(499).json({ error: 'request cancelled by client' });
          return;
        }
        if (!res.writableEnded) {
          try {
            res.end();
          } catch (endErr) {
            // ignore close failures on cancellation
          }
        }
        return;
      }
      res.status(err.status || 500).json({ error: err.message || 'Request failed' });
    } finally {
      req.off('aborted', abortHandler);
      res.off('close', responseCloseAbortHandler);
    }
  });

  return { app, runtime };
}

async function startBridge(overrides = {}) {
  if (activeBridge && activeBridge.server) {
    return {
      app: activeBridge.app,
      server: activeBridge.server,
      port: activeBridge.config.port,
      codexBin: activeBridge.config.resolvedCodexBin || activeBridge.config.codexBin,
      config: activeBridge.config,
      runtime: activeBridge.runtime,
      controller: activeBridge.runtime ? activeBridge.runtime.sessionController : null,
    };
  }

  const config = resolveBridgeConfig(overrides);
  await ensureResolvedCodexBin(config);
  const { app, runtime } = createBridgeApp(config);

  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(config.port, () => resolve(listener));
    listener.on('error', (err) => reject(err));
  });

  activeBridge = { app, server, config, runtime };
  return {
    app,
    server,
    port: config.port,
    codexBin: config.resolvedCodexBin || config.codexBin,
    config,
    runtime,
    controller: runtime.sessionController,
  };
}

async function stopBridge() {
  if (!activeBridge || !activeBridge.server) {
    return;
  }
  const server = activeBridge.server;
  await new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  activeBridge = null;
}

module.exports = {
  startBridge,
  stopBridge,
  buildCodexPrompt,
  loadModelsMetadata,
  normalizeReasoningEffort,
};
