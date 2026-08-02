const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rcloneGui", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getRcloneVersion: () => ipcRenderer.invoke("get-rclone-version"),
  listRemotes: () => ipcRenderer.invoke("list-remotes"),
  listRemoteEntries: () => ipcRenderer.invoke("list-remote-entries"),
  listRemotePath: (remotePath) => ipcRenderer.invoke("list-remote-path", remotePath),
  getConfigProviders: () => ipcRenderer.invoke("get-config-providers"),
  getRemoteRedacted: (name) => ipcRenderer.invoke("get-remote-redacted", name),
  deleteRemote: (name) => ipcRenderer.invoke("delete-remote", name),
  createRemote: (payload) => ipcRenderer.invoke("create-remote", payload),
  authorizeProvider: (provider) => ipcRenderer.invoke("authorize-provider", provider),
  reconnectRemote: (name) => ipcRenderer.invoke("reconnect-remote", name),
  openRcloneConfig: () => ipcRenderer.invoke("open-rclone-config"),
  getConfigFilePath: () => ipcRenderer.invoke("get-config-file-path"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickSaveFile: (defaultName) => ipcRenderer.invoke("pick-save-file", defaultName),
  downloadRemoteFile: (payload) => ipcRenderer.invoke("download-remote-file", payload),
  startJob: (job) => ipcRenderer.invoke("start-job", job),
  stopJob: () => ipcRenderer.invoke("stop-job"),
  setMinimumContentSize: (size) => ipcRenderer.invoke("set-minimum-content-size", size),
  probeMinimumContentSize: (size) => ipcRenderer.invoke("probe-minimum-content-size", size),
  restoreContentSize: (size) => ipcRenderer.invoke("restore-content-size", size),
  fitWindowToContent: (size, snap) => ipcRenderer.invoke("fit-window-to-content", size, snap),
  getWorkAreaLimits: () => ipcRenderer.invoke("get-work-area-limits"),
  showMainWindow: () => ipcRenderer.invoke("show-main-window"),
  listJobs: () => ipcRenderer.invoke("list-jobs"),
  saveJob: (job) => ipcRenderer.invoke("save-job", job),
  updateJob: (jobId, job) => ipcRenderer.invoke("update-job", jobId, job),
  deleteJob: (jobId) => ipcRenderer.invoke("delete-job", jobId),
  onJobStarted: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job-started", listener);
    return () => ipcRenderer.removeListener("job-started", listener);
  },
  onJobOutput: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job-output", listener);
    return () => ipcRenderer.removeListener("job-output", listener);
  },
  onJobFinished: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("job-finished", listener);
    return () => ipcRenderer.removeListener("job-finished", listener);
  },
});
