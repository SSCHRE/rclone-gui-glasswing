const { contextBridge, ipcRenderer, webUtils, webFrame } = require("electron");

const themeArg = process.argv.find((arg) => arg.startsWith("--glasswing-theme="));
const uiScaleArg = process.argv.find((arg) => arg.startsWith("--glasswing-ui-scale="));
const initialUiScale = Number(uiScaleArg?.slice("--glasswing-ui-scale=".length)) || 1;
const titlebarArg = process.argv.find((arg) => arg.startsWith("--glasswing-titlebar="));
const titlebarMode = titlebarArg ? titlebarArg.slice("--glasswing-titlebar=".length) : "unsupported";

webFrame.setZoomFactor(initialUiScale);

contextBridge.exposeInMainWorld("rcloneGui", {
  platform: process.platform,
  initialTheme: themeArg ? themeArg.slice("--glasswing-theme=".length) : "glass",
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  initialUiScale,
  setUiScale: (scale) => {
    webFrame.setZoomFactor(scale);
    return ipcRenderer.invoke("set-ui-scale", scale);
  },
  titlebarMode,
  setCustomTitlebar: (enabled) => ipcRenderer.invoke("set-custom-titlebar", enabled),
  restartApp: () => ipcRenderer.invoke("restart-app"),
  getAppVersion: () => ipcRenderer.invoke("get-app-version"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  skipUpdateVersion: (version) => ipcRenderer.invoke("skip-update-version", version),
  openReleasePage: () => ipcRenderer.invoke("open-release-page"),
  getRcloneVersion: () => ipcRenderer.invoke("get-rclone-version"),
  listRemotes: () => ipcRenderer.invoke("list-remotes"),
  listRemoteEntries: () => ipcRenderer.invoke("list-remote-entries"),
  getRemoteUsage: (name) => ipcRenderer.invoke("get-remote-usage", name),
  getStorageHistory: (targets) => ipcRenderer.invoke("get-storage-history", targets),
  cleanupRemote: (name) => ipcRenderer.invoke("cleanup-remote", name),
  listLocalDrives: () => ipcRenderer.invoke("list-local-drives"),
  listRemotePath: (remotePath) => ipcRenderer.invoke("list-remote-path", remotePath),
  searchRemote: (request) => ipcRenderer.invoke("search-remote", request),
  cancelRemoteSearch: () => ipcRenderer.invoke("cancel-remote-search"),
  onRemoteSearchResults: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("remote-search-results", listener);
    return () => ipcRenderer.removeListener("remote-search-results", listener);
  },
  getConfigProviders: () => ipcRenderer.invoke("get-config-providers"),
  getRemoteRedacted: (name) => ipcRenderer.invoke("get-remote-redacted", name),
  deleteRemote: (name) => ipcRenderer.invoke("delete-remote", name),
  createRemote: (payload) => ipcRenderer.invoke("create-remote", payload),
  inspectVaultTarget: (payload) => ipcRenderer.invoke("inspect-vault-target", payload),
  createVault: (payload) => ipcRenderer.invoke("create-vault", payload),
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
  getServeStatus: () => ipcRenderer.invoke("get-serve-status"),
  startServe: (payload) => ipcRenderer.invoke("start-serve", payload),
  stopServe: (id) => ipcRenderer.invoke("stop-serve", id),
  openServe: (id) => ipcRenderer.invoke("open-serve", id),
  onServesChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("serves-changed", listener);
    return () => ipcRenderer.removeListener("serves-changed", listener);
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
  takeExplorerUploads: () => ipcRenderer.invoke("take-explorer-uploads"),
  onExplorerUpload: (callback) => {
    const listener = (_event, paths) => callback(paths);
    ipcRenderer.on("explorer-upload", listener);
    return () => ipcRenderer.removeListener("explorer-upload", listener);
  },
  getExplorerMenu: () => ipcRenderer.invoke("get-explorer-menu"),
  setExplorerMenu: (enabled) => ipcRenderer.invoke("set-explorer-menu", enabled),
  dismissExplorerMenuOffer: () => ipcRenderer.invoke("dismiss-explorer-menu-offer"),
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
  listRuns: () => ipcRenderer.invoke("list-runs"),
  getRunLog: (runId) => ipcRenderer.invoke("get-run-log", runId),
  clearRuns: () => ipcRenderer.invoke("clear-runs"),
  onRunsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("runs-changed", listener);
    return () => ipcRenderer.removeListener("runs-changed", listener);
  },
  listMigrations: () => ipcRenderer.invoke("migration-list"),
  scanMigration: (payload) => ipcRenderer.invoke("migration-scan", payload),
  cancelMigrationTask: () => ipcRenderer.invoke("migration-cancel"),
  createMigration: (payload) => ipcRenderer.invoke("migration-create", payload),
  runMigrationNow: (id) => ipcRenderer.invoke("migration-run-now", id),
  verifyMigration: (id) => ipcRenderer.invoke("migration-verify", id),
  cleanupMigration: (id) => ipcRenderer.invoke("migration-cleanup", id),
  removeMigration: (id) => ipcRenderer.invoke("migration-remove", id),
  onMigrationsChanged: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("migrations-changed", listener);
    return () => ipcRenderer.removeListener("migrations-changed", listener);
  },
  onMigrationProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("migration-progress", listener);
    return () => ipcRenderer.removeListener("migration-progress", listener);
  },
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
