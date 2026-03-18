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
  deleteSession: (sessionId) => ipcRenderer.invoke('session:delete', sessionId),
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
});
