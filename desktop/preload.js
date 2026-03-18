const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistDesktop', {
  getDiagnostics: () => ipcRenderer.invoke('doctor:get'),
  retryDiagnostics: () => ipcRenderer.invoke('doctor:retry'),
  openInstallDocs: () => ipcRenderer.invoke('doctor:openInstallDocs'),
  runCodexLogin: () => ipcRenderer.invoke('doctor:runLogin'),
  restartBridge: () => ipcRenderer.invoke('doctor:restartBridge'),
  listSessions: () => ipcRenderer.invoke('session:list'),
  getSession: (sessionId) => ipcRenderer.invoke('session:get', sessionId),
  cancelSession: (sessionId) => ipcRenderer.invoke('session:cancel', sessionId),
  getTerminalState: () => ipcRenderer.invoke('terminal:getState'),
  startTerminal: () => ipcRenderer.invoke('terminal:start'),
  restartTerminal: () => ipcRenderer.invoke('terminal:restart'),
  writeTerminal: (data) => ipcRenderer.invoke('terminal:write', data),
  resizeTerminal: (cols, rows) => ipcRenderer.invoke('terminal:resize', { cols, rows }),
  onDiagnostics: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('doctor:update', handler);
    return () => {
      ipcRenderer.removeListener('doctor:update', handler);
    };
  },
  onSessionUpdate: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('session:update', handler);
    return () => {
      ipcRenderer.removeListener('session:update', handler);
    };
  },
  onTerminalEvent: (callback) => {
    if (typeof callback !== 'function') {
      return () => {};
    }
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('terminal:event', handler);
    return () => {
      ipcRenderer.removeListener('terminal:event', handler);
    };
  },
});
