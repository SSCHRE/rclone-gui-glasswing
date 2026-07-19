const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("rcloneGui", {
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  getRcloneVersion: () => ipcRenderer.invoke("get-rclone-version"),
  listRemotes: () => ipcRenderer.invoke("list-remotes"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  startJob: (job) => ipcRenderer.invoke("start-job", job),
  stopJob: () => ipcRenderer.invoke("stop-job"),
  setMinimumContentSize: (size) => ipcRenderer.invoke("set-minimum-content-size", size),
  probeMinimumContentSize: (size) => ipcRenderer.invoke("probe-minimum-content-size", size),
  restoreContentSize: (size) => ipcRenderer.invoke("restore-content-size", size),
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
