const { app, BrowserWindow, Menu, Tray, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const os = require('os');
const fsSync = require('fs');
const fs = require('fs/promises');
const { spawn } = require('child_process');
const { startBridge, stopBridge } = require('../proxy/bridge');
const { TerminalManager } = require('./terminal-manager');

const SERVICE_PORT = 8787;
const INSTALL_DOCS_URL = 'https://platform.openai.com/docs/codex';
const HEALTH_URL = `http://localhost:${SERVICE_PORT}/health`;
const DOCTOR_BASE_URL = `http://localhost:${SERVICE_PORT}/doctor`;
const WINDOWS_APP_ID = 'com.overleaf.assist.bridge';
const ASSETS_DIR = path.join(__dirname, 'assets');
const ICON_ICO_PATH = path.join(ASSETS_DIR, 'icon.ico');
const ICON_PNG_PATH = path.join(ASSETS_DIR, 'icon.png');
const TRAY_ICON_PATH = path.join(ASSETS_DIR, 'tray.png');

let tray = null;
let mainWindow = null;
let healthPollTimer = null;
let bridgeState = null;
let bridgeSessionUnsubscribe = null;
let diagnosticsState = {
  startup_error: null,
  health: null,
  doctor: null,
  checked_at: 0,
};
const terminalManager = new TerminalManager({
  cwd: os.homedir(),
  getCommand: async () => ({
    command:
      bridgeState &&
      bridgeState.config &&
      typeof bridgeState.config.resolvedCodexBin === 'string' &&
      bridgeState.config.resolvedCodexBin.trim()
        ? bridgeState.config.resolvedCodexBin.trim()
        : process.platform === 'win32'
          ? 'codex.cmd'
          : 'codex',
    args: [],
  }),
});

function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    try {
      if (fsSync.existsSync(candidate)) {
        return candidate;
      }
    } catch (err) {
      // ignore filesystem access errors and continue probing
    }
  }
  return '';
}

function loadNativeIcon(paths) {
  const iconPath = firstExistingPath(paths);
  if (!iconPath) {
    return nativeImage.createEmpty();
  }
  const image = nativeImage.createFromPath(iconPath);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function getWindowIconPath() {
  if (process.platform === 'win32') {
    return firstExistingPath([ICON_ICO_PATH, ICON_PNG_PATH]) || undefined;
  }
  return firstExistingPath([ICON_PNG_PATH]) || undefined;
}

function createTrayIcon() {
  const icon = loadNativeIcon([TRAY_ICON_PATH, ICON_PNG_PATH, ICON_ICO_PATH]);
  if (icon.isEmpty()) {
    return icon;
  }
  if (process.platform === 'win32') {
    return icon.resize({ width: 16, height: 16 });
  }
  return icon;
}

function hasActionableIssues(state) {
  if (!state || state.startup_error) {
    return true;
  }
  if (!state.health || state.health.ok !== true) {
    return true;
  }
  if (state.health.codex_ready !== true) {
    return true;
  }
  if (state.doctor && Array.isArray(state.doctor.issues) && state.doctor.issues.length > 0) {
    return true;
  }
  return false;
}

function formatWholeNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  return Math.max(0, Math.floor(numeric)).toLocaleString();
}

function formatQuotaPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '';
  }
  return `${Math.max(0, numeric).toFixed(1)}%`;
}

function getTokenMetrics(state) {
  if (!state || !state.health || typeof state.health !== 'object') {
    return null;
  }
  const metrics = state.health.token_metrics;
  if (!metrics || typeof metrics !== 'object') {
    return null;
  }
  return metrics;
}

function buildTrayTooltip(state) {
  const parts = ['Overleaf Assist'];

  if (!state || state.startup_error) {
    parts.push('Bridge error');
  } else if (!state.health || state.health.ok !== true) {
    parts.push('Bridge unavailable');
  } else if (state.health.codex_ready === true) {
    parts.push('Ready');
  } else {
    parts.push('Codex not ready');
  }

  const tokenMetrics = getTokenMetrics(state);
  const usageTokens =
    tokenMetrics && tokenMetrics.usage && Number.isFinite(Number(tokenMetrics.usage.total_tokens))
      ? formatWholeNumber(tokenMetrics.usage.total_tokens)
      : '';
  if (usageTokens) {
    parts.push(`Tokens ${usageTokens}`);
  }

  const quotaPercent =
    tokenMetrics &&
    tokenMetrics.rate_limits &&
    tokenMetrics.rate_limits.primary &&
    Number.isFinite(Number(tokenMetrics.rate_limits.primary.used_percent))
      ? formatQuotaPercent(tokenMetrics.rate_limits.primary.used_percent)
      : '';
  if (quotaPercent) {
    parts.push(`5h ${quotaPercent}`);
  }

  const weeklyQuotaPercent =
    tokenMetrics &&
    tokenMetrics.rate_limits &&
    tokenMetrics.rate_limits.secondary &&
    Number.isFinite(Number(tokenMetrics.rate_limits.secondary.used_percent))
      ? formatQuotaPercent(tokenMetrics.rate_limits.secondary.used_percent)
      : '';
  if (weeklyQuotaPercent) {
    parts.push(`Wk ${weeklyQuotaPercent}`);
  }

  return parts.join(' | ');
}

function refreshTrayTooltip() {
  if (!tray) {
    return;
  }
  tray.setToolTip(buildTrayTooltip(diagnosticsState));
}

function createMainWindow() {
  const iconPath = getWindowIconPath();
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('close', (event) => {
    if (app.isQuiting) {
      return;
    }
    event.preventDefault();
    mainWindow.hide();
  });
}

function pushDiagnosticsToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('doctor:update', diagnosticsState);
}

function pushSessionUpdateToWindow(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('session:update', payload || null);
}

function pushTerminalEventToWindow(type, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('terminal:event', {
    type,
    payload: payload || null,
  });
}

function showStatusWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.show();
  mainWindow.focus();
  pushDiagnosticsToWindow();
}

function buildDoctorUrl(shouldProbe) {
  const probe = shouldProbe ? '1' : '0';
  return `${DOCTOR_BASE_URL}?probe=${probe}`;
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : 7000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
      },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function refreshDiagnostics(showWindowOnIssue) {
  const next = {
    startup_error: diagnosticsState.startup_error,
    health: null,
    doctor: null,
    checked_at: Date.now(),
  };

  if (next.startup_error) {
    diagnosticsState = next;
    pushDiagnosticsToWindow();
    refreshTrayTooltip();
    if (showWindowOnIssue) {
      showStatusWindow();
    }
    return diagnosticsState;
  }

  try {
    next.health = await fetchJsonWithTimeout(HEALTH_URL, 6000);
  } catch (err) {
    next.startup_error = {
      code: 'bridge_unavailable',
      message: err.message || 'Bridge unavailable',
    };
  }

  if (!next.startup_error) {
    try {
      next.doctor = await fetchJsonWithTimeout(buildDoctorUrl(false), 12000);
    } catch (err) {
      next.doctor = {
        issues: ['doctor_unavailable'],
        error: err.message || 'Failed to run diagnostics',
      };
    }
  }

  if (!next.startup_error && next.health && next.health.codex_ready !== true) {
    try {
      next.doctor = await fetchJsonWithTimeout(buildDoctorUrl(true), 30000);
    } catch (err) {
      if (next.doctor && Array.isArray(next.doctor.issues)) {
        if (!next.doctor.issues.includes('doctor_unavailable')) {
          next.doctor.issues.push('doctor_unavailable');
        }
      } else {
        next.doctor = {
          issues: ['doctor_unavailable'],
        };
      }
      next.doctor.error = err.message || 'Failed to run diagnostics';
    }
  }

  diagnosticsState = next;
  pushDiagnosticsToWindow();
  refreshTrayTooltip();
  if (showWindowOnIssue && hasActionableIssues(diagnosticsState)) {
    showStatusWindow();
  }
  return diagnosticsState;
}

function getBridgeTempDir() {
  try {
    return path.join(app.getPath('temp'), 'Codex_Assist', 'bridge');
  } catch (err) {
    return path.join(os.tmpdir(), 'Codex_Assist', 'bridge');
  }
}

function clearBridgeSessionSubscription() {
  if (typeof bridgeSessionUnsubscribe === 'function') {
    try {
      bridgeSessionUnsubscribe();
    } catch (err) {
      // ignore bridge listener cleanup failures
    }
  }
  bridgeSessionUnsubscribe = null;
}

function attachBridgeSessionUpdates() {
  clearBridgeSessionSubscription();
  if (
    !bridgeState ||
    !bridgeState.controller ||
    typeof bridgeState.controller.onUpdate !== 'function'
  ) {
    return;
  }
  bridgeSessionUnsubscribe = bridgeState.controller.onUpdate((payload) => {
    pushSessionUpdateToWindow(payload);
  });
}

function shouldOpenWindowOnStartup() {
  if (!app.isPackaged) {
    return true;
  }
  try {
    const loginState = app.getLoginItemSettings();
    if (loginState && loginState.wasOpenedAtLogin) {
      return false;
    }
  } catch (err) {
    // ignore login-item detection failures and fall back to opening the window
  }
  return true;
}

async function ensureBridgeStarted() {
  diagnosticsState = {
    startup_error: null,
    health: null,
    doctor: null,
    checked_at: Date.now(),
  };
  try {
    bridgeState = await startBridge({
      port: SERVICE_PORT,
      tempDir: getBridgeTempDir(),
    });
    attachBridgeSessionUpdates();
  } catch (err) {
    bridgeState = null;
    clearBridgeSessionSubscription();
    diagnosticsState.startup_error = {
      code: err && err.code ? err.code : 'bridge_start_failed',
      message: err && err.message ? err.message : 'Failed to start bridge',
      issue:
        err && err.code === 'EADDRINUSE' ? 'port_in_use' : 'bridge_start_failed',
    };
    return false;
  }
  return true;
}

async function restartBridge() {
  try {
    await stopBridge();
  } catch (err) {
    // ignore stop failures; restart still attempts start
  }
  bridgeState = null;
  clearBridgeSessionSubscription();
  await ensureBridgeStarted();
  await refreshDiagnostics(true);
}

function runCodexLoginCommand() {
  try {
    if (process.platform === 'win32') {
      spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/c', 'start', 'cmd.exe', '/k', 'codex.cmd login'],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }
      ).unref();
      return true;
    }

    if (process.platform === 'darwin') {
      spawn(
        'osascript',
        ['-e', 'tell application "Terminal" to do script "codex login"'],
        {
          detached: true,
          stdio: 'ignore',
        }
      ).unref();
      return true;
    }

    spawn(
      'sh',
      [
        '-lc',
        'x-terminal-emulator -e "codex login" || gnome-terminal -- bash -lc "codex login; exec bash" || konsole -e bash -lc "codex login; exec bash"',
      ],
      {
        detached: true,
        stdio: 'ignore',
      }
    ).unref();
    return true;
  } catch (err) {
    return false;
  }
}

async function ensureLinuxAutostart() {
  if (process.platform !== 'linux' || !app.isPackaged) {
    return;
  }
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const entryPath = path.join(autostartDir, 'overleaf-assist.desktop');
  const execPath = process.execPath.replace(/"/g, '\\"');
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Overleaf Assist',
    'Comment=Overleaf Assist local bridge service',
    `Exec="${execPath}"`,
    'X-GNOME-Autostart-enabled=true',
    'Terminal=false',
    '',
  ].join('\n');
  await fs.mkdir(autostartDir, { recursive: true });
  await fs.writeFile(entryPath, content, 'utf8');
}

async function configureAutoStart() {
  if (!app.isPackaged) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
    });
  } catch (err) {
    // ignore on unsupported environments
  }
  try {
    await ensureLinuxAutostart();
  } catch (err) {
    // ignore linux autostart write failures
  }
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open App',
      click: () => showStatusWindow(),
    },
    {
      label: 'Restart Bridge',
      click: () => {
        restartBridge();
      },
    },
    {
      label: 'Run Codex Login',
      click: () => {
        runCodexLoginCommand();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  refreshTrayTooltip();
  tray.on('double-click', () => showStatusWindow());
  refreshTrayMenu();
}

function listProjectSessions() {
  if (
    !bridgeState ||
    !bridgeState.controller ||
    typeof bridgeState.controller.listSessions !== 'function'
  ) {
    return [];
  }
  return bridgeState.controller.listSessions();
}

function getProjectSession(sessionId) {
  if (
    !bridgeState ||
    !bridgeState.controller ||
    typeof bridgeState.controller.getSessionById !== 'function'
  ) {
    return null;
  }
  const session = bridgeState.controller.getSessionById(sessionId);
  if (!session || typeof bridgeState.controller.buildSessionSnapshot !== 'function') {
    return null;
  }
  return bridgeState.controller.buildSessionSnapshot(session);
}

function registerTerminalEvents() {
  terminalManager.onEvent((type, payload) => {
    pushTerminalEventToWindow(type, payload);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('doctor:get', async () => diagnosticsState);
  ipcMain.handle('doctor:retry', async () => {
    await refreshDiagnostics(true);
    return diagnosticsState;
  });
  ipcMain.handle('doctor:openInstallDocs', async () => {
    await shell.openExternal(INSTALL_DOCS_URL);
    return true;
  });
  ipcMain.handle('doctor:runLogin', async () => {
    const launched = runCodexLoginCommand();
    return { launched };
  });
  ipcMain.handle('doctor:restartBridge', async () => {
    await restartBridge();
    return diagnosticsState;
  });
  ipcMain.handle('session:list', async () => listProjectSessions());
  ipcMain.handle('session:get', async (_event, sessionId) => getProjectSession(sessionId));
  ipcMain.handle('session:cancel', async (_event, sessionId) => {
    if (
      !bridgeState ||
      !bridgeState.controller ||
      typeof bridgeState.controller.cancelSession !== 'function'
    ) {
      throw new Error('Bridge session controller unavailable');
    }
    return bridgeState.controller.cancelSession(sessionId);
  });
  ipcMain.handle('terminal:getState', async () => terminalManager.getSnapshot());
  ipcMain.handle('terminal:start', async () => terminalManager.start());
  ipcMain.handle('terminal:restart', async () => terminalManager.restart());
  ipcMain.handle('terminal:write', async (_event, data) => ({
    ok: terminalManager.write(data),
  }));
  ipcMain.handle('terminal:resize', async (_event, size) => ({
    ok: terminalManager.resize(size && size.cols, size && size.rows),
  }));
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_ID);
  }

  app.on('second-instance', () => {
    showStatusWindow();
  });

  app.whenReady().then(async () => {
    createMainWindow();
    createTray();
    registerTerminalEvents();
    registerIpcHandlers();
    await configureAutoStart();
    await ensureBridgeStarted();
    await refreshDiagnostics(false);

    if (shouldOpenWindowOnStartup()) {
      showStatusWindow();
    } else if (hasActionableIssues(diagnosticsState)) {
      showStatusWindow();
    }

    if (healthPollTimer) {
      clearInterval(healthPollTimer);
    }
    healthPollTimer = setInterval(() => {
      refreshDiagnostics(false);
    }, 30000);
  });
}

app.on('before-quit', async () => {
  app.isQuiting = true;
  if (healthPollTimer) {
    clearInterval(healthPollTimer);
    healthPollTimer = null;
  }
  clearBridgeSessionSubscription();
  try {
    await terminalManager.stop();
  } catch (err) {
    // ignore terminal shutdown failures during app quit
  }
  try {
    await stopBridge();
  } catch (err) {
    // ignore stop failures during shutdown
  }
  bridgeState = null;
});

app.on('activate', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  showStatusWindow();
});
