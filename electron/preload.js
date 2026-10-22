const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("rcloneGui", {
  platform: process.platform,
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  openReleasePage: (url) => ipcRenderer.invoke("open-release-page", url),
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
  getMountStatus: () => ipcRenderer.invoke("get-mount-status"),
  getBwlimit: () => ipcRenderer.invoke("get-bwlimit"),
  setBwlimit: (value) => ipcRenderer.invoke("set-bwlimit", value),
  mountRemote: (payload) => ipcRenderer.invoke("mount-remote", payload),
  unmountRemote: (name, options) => ipcRenderer.invoke("unmount-remote", name, options),
  openMount: (name) => ipcRenderer.invoke("open-mount", name),
  onMountsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mounts-changed", listener);
    return () => ipcRenderer.removeListener("mounts-changed", listener);
  },
  getConfigFilePath: () => ipcRenderer.invoke("get-config-file-path"),
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickSaveFile: (defaultName) => ipcRenderer.invoke("pick-save-file", defaultName),
  downloadRemoteFile: (payload) => ipcRenderer.invoke("download-remote-file", payload),
  cancelDownload: () => ipcRenderer.invoke("cancel-download"),
  onDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("download-progress", listener);
    return () => ipcRenderer.removeListener("download-progress", listener);
  },
  pickUploadFiles: () => ipcRenderer.invoke("pick-upload-files"),
  measureLocalPaths: (paths) => ipcRenderer.invoke("measure-local-paths", paths),
  uploadToRemote: (payload) => ipcRenderer.invoke("upload-to-remote", payload),
  cancelUpload: () => ipcRenderer.invoke("cancel-upload"),
getPathForFile: (file) => webUtils.getPathForFile(file),
  onUploadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("upload-progress", listener);
    return () => ipcRenderer.removeListener("upload-progress", listener);
  },
    deleteRemoteFile: (payload) => ipcRenderer.invoke("delete-remote-file", payload),
    createRemoteFolder: (payload) => ipcRenderer.invoke("create-remote-folder", payload),
openRemotePreview: (remotePath, options) => ipcRenderer.invoke("open-remote-preview", remotePath, options),
  closeRemotePreview: () => ipcRenderer.invoke("close-remote-preview"),
  previewJobCommand: (job) => ipcRenderer.invoke("preview-job-command", job),
  approveJobCommand: (job) => ipcRenderer.invoke("approve-job-command", job),
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
  getActiveJob: () => ipcRenderer.invoke("get-active-job"),
  setJobSchedule: (jobId, schedule) => ipcRenderer.invoke("set-job-schedule", jobId, schedule),
  previewJobSchedule: (schedule) => ipcRenderer.invoke("preview-job-schedule", schedule),
  getScheduleSettings: () => ipcRenderer.invoke("get-schedule-settings"),
  setScheduleSettings: (changes) => ipcRenderer.invoke("set-schedule-settings", changes),
  onSchedulesChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("schedules-changed", listener);
    return () => ipcRenderer.removeListener("schedules-changed", listener);
  },
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
  onHistoryNavigate: (callback) => {
    const listener = (_event, direction) => callback(direction);
    ipcRenderer.on("history-navigate", listener);
    return () => ipcRenderer.removeListener("history-navigate", listener);
  },
});
