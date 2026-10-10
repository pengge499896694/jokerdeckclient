const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("jokerdeck", {
  session: () => ipcRenderer.invoke("session"),
  login: (credentials) => ipcRenderer.invoke("login", credentials),
  logout: () => ipcRenderer.invoke("logout"),
  setLoginPreference: (value) => ipcRenderer.invoke("set-login-preference", value),
  verifyTwoFactor: (payload) =>
    ipcRenderer.invoke("verify-two-factor", payload),
  catalog: () => ipcRenderer.invoke("catalog"),
  savePreferences: (preferences) =>
    ipcRenderer.invoke("save-preferences", preferences),
  createKey: (payload) => ipcRenderer.invoke("create-key", payload),
  configuredKey: (payload) => ipcRenderer.invoke("configured-key", payload),
  configuredConfig: (payload) => ipcRenderer.invoke("configured-config", payload),
  healthCheck: (endpoints) => ipcRenderer.invoke("health-check", endpoints),
  capabilities: () => ipcRenderer.invoke("capabilities"),
  setIntegrations: (settings) => ipcRenderer.invoke("set-integrations", settings),
  computerUsePermissions: () => ipcRenderer.invoke("computer-use-permissions"),
  nodeStatus: () => ipcRenderer.invoke("node-status"),
  nodeConnect: () => ipcRenderer.invoke("node-connect"),
  nodeDisconnect: () => ipcRenderer.invoke("node-disconnect"),
  launchCodex: (options) => ipcRenderer.invoke("launch-codex", options),
  launchClaude: () => ipcRenderer.invoke("launch-claude"),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  appVersion: () => ipcRenderer.invoke("app-version"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  downloadUpdate: () => ipcRenderer.invoke("download-update"),
  onDownloadProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
});
