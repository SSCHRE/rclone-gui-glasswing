const { app, BrowserWindow, ipcMain, dialog, Menu, Notification, Tray, powerMonitor, screen, nativeImage, nativeTheme, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const mounts = require("./mounts");
const scheduler = require("./scheduler");
const remoteSearch = require("./remote-search");

if (process.platform === "win32") {
  app.setAppUserModelId("com.rclone.gui.glasswing");
}

let mainWindow = null;
let activeJob = null;
let jobStarting = false;
let appQuitting = false;
let windowRevealed = !process.argv.includes("--hidden");
let closeConfirmed = false;
let closeCheckInProgress = false;
let mountsStopping = false;

const WINDOW_ABSOLUTE_MIN_WIDTH = 760;
const WINDOW_ABSOLUTE_MIN_HEIGHT = 520;
const WINDOW_PREFERRED_WIDTH_RATIO = 0.78;
const WINDOW_PREFERRED_HEIGHT_RATIO = 0.9;
const SCREEN_MARGIN = 20;

let contentChrome = { width: 16, height: 39 };

function resolveAppIconPath() {
  const formats = process.platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png"];
  const candidates = [
    path.join(__dirname, "icons"),
    path.join(__dirname, "..", "build"),
    process.resourcesPath,
  ].flatMap((dir) => formats.map((file) => path.join(dir, file)));

  for (const iconPath of candidates) {
    if (fsSync.existsSync(iconPath)) {
      return iconPath;
    }
  }

  return undefined;
}

function resolveAppIcon() {
  const iconPath = resolveAppIconPath();
  if (!iconPath) {
    return undefined;
  }

  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}
const MAX_JOB_HISTORY = 50;

const BWLIMIT_RATE = String.raw`\d+(?:\.\d+)?[KMG]`;
const BWLIMIT_PATTERN = new RegExp(
  String.raw`^(?:${BWLIMIT_RATE}|\d{2}:\d{2},(?:${BWLIMIT_RATE}|off)(?: \d{2}:\d{2},(?:${BWLIMIT_RATE}|off))*)$`,
);
let appSettings = null;

function getSettingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

function getAppSettings() {
  if (!appSettings) {
    try {
      appSettings = JSON.parse(fsSync.readFileSync(getSettingsPath(), "utf8")) || {};
    } catch {
      appSettings = {};
    }
  }
  return appSettings;
}

async function saveAppSettings(changes) {
  appSettings = { ...getAppSettings(), ...changes };
  await fs.mkdir(path.dirname(getSettingsPath()), { recursive: true });
  await fs.writeFile(getSettingsPath(), JSON.stringify(appSettings, null, 2), "utf8");
  return appSettings;
}

function normalizeBwlimit(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!BWLIMIT_PATTERN.test(text)) {
    throw new Error(`Invalid bandwidth limit "${text}".`);
  }
  return text;
}

const THEMES = {
  glass: { background: "#080b10", nativeTheme: "dark" },
  material: { background: "#f0f4f9", nativeTheme: "light" },
  "material-dark": { background: "#131314", nativeTheme: "dark" },
};

function getTheme() {
  const theme = getAppSettings().theme;
  return Object.hasOwn(THEMES, theme) ? theme : "glass";
}

function applyNativeTheme(theme) {
  nativeTheme.themeSource = THEMES[theme].nativeTheme;
}

function getBwlimit() {
  try {
    return normalizeBwlimit(getAppSettings().bwlimit);
  } catch {
    return "";
  }
}

function bwlimitArgs() {
  const bwlimit = getBwlimit();
  return bwlimit ? ["--bwlimit", bwlimit] : [];
}
const JOB_OPERATIONS = ["sync", "copy", "move", "bisync"];
const JOB_OUTPUT_TAIL_CHARS = 16384;

function jobSignature(job) {
  return [
    job.operation,
    job.source,
    job.destination,
    !!job.dryRun,
    !!job.deleteExcluded,
    (job.extraArgs || "").trim(),
  ].join("\0");
}

function parseExtraArgs(input) {
  if (!input?.trim()) {
    return [];
  }

  const args = [];
  let current = "";
  let quote = null;

  for (const char of input.trim()) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error("Custom arguments contain an unclosed quote.");
  }

  if (current) {
    args.push(current);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("-")) {
      continue;
    }

    if (index === 0) {
      throw new Error('Custom arguments must start with a flag (e.g. --drime-upload-cutoff 128M).');
    }

    if (!args[index - 1].startsWith("-")) {
      throw new Error(`Invalid custom argument "${arg}".`);
    }
  }

  return args;
}

function truncatePath(value, max = 28) {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}

function defaultJobName(job) {
  const operation = job.operation.charAt(0).toUpperCase() + job.operation.slice(1);
  return `${operation}: ${truncatePath(job.source)} → ${truncatePath(job.destination)}`;
}

function sortJobHistory(entries) {
  return [...entries].sort(
    (left, right) => (right.lastRunAt || right.createdAt || 0) - (left.lastRunAt || left.createdAt || 0),
  );
}

function getHistoryFilePath() {
  return path.join(app.getPath("userData"), "job-history.json");
}

async function readJobHistory() {
  try {
    const raw = await fs.readFile(getHistoryFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    const savedEntries = Array.isArray(parsed) ? parsed.filter((entry) => entry.saved) : [];
    return sortJobHistory(savedEntries);
  } catch {
    return [];
  }
}

let historyQueue = Promise.resolve();

function withJobHistory(task) {
  const run = historyQueue.then(task);
  historyQueue = run.catch(() => {});
  return run;
}

async function writeJobHistory(entries) {
  const filePath = getHistoryFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const trimmed = sortJobHistory(entries.filter((entry) => entry.saved)).slice(0, MAX_JOB_HISTORY);
  await fs.writeFile(filePath, JSON.stringify(trimmed, null, 2), "utf8");
  return trimmed;
}

function upsertJobHistory(job, options) {
  return withJobHistory(() => upsertJobHistoryNow(job, options));
}

async function upsertJobHistoryNow(job, { name = null } = {}) {
  const signature = jobSignature(job);
  const now = Date.now();
  const entries = await readJobHistory();
  const existingIndex = entries.findIndex((entry) => entry.signature === signature);
  const existing = existingIndex >= 0 ? entries[existingIndex] : null;

  const entry = {
    id: existing?.id || randomUUID(),
    signature,
    name: name?.trim() || existing?.name || defaultJobName(job),
    operation: job.operation,
    source: job.source,
    destination: job.destination,
    dryRun: !!job.dryRun,
    deleteExcluded: !!job.deleteExcluded,
    extraArgs: (job.extraArgs || "").trim(),
    saved: true,
    createdAt: existing?.createdAt || now,
    lastRunAt: existing?.lastRunAt || null,
    lastRunSuccess: existing?.lastRunSuccess ?? null,
    runCount: existing?.runCount || 0,
    schedule: existing?.schedule || null,
  };

  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1);
  }

  entries.unshift(entry);
  return writeJobHistory(entries);
}

function updateSavedJob(jobId, job) {
  return withJobHistory(() => updateSavedJobNow(jobId, job));
}

async function updateSavedJobNow(jobId, job) {
  const entries = await readJobHistory();
  const index = entries.findIndex((entry) => entry.id === jobId);
  if (index < 0) {
    throw new Error("Saved job not found.");
  }

  const signature = jobSignature(job);
  const duplicateIndex = entries.findIndex(
    (entry) => entry.signature === signature && entry.id !== jobId,
  );
  if (duplicateIndex >= 0) {
    throw new Error("Another saved job already uses these settings.");
  }

  const existing = entries[index];
  const updated = {
    ...existing,
    signature,
    operation: job.operation,
    source: job.source.trim(),
    destination: job.destination.trim(),
    dryRun: !!job.dryRun,
    deleteExcluded: !!job.deleteExcluded,
    extraArgs: (job.extraArgs || "").trim(),
    saved: true,
  };

  entries.splice(index, 1);
  entries.unshift(updated);
  return writeJobHistory(entries);
}

function markJobRunStarted(job) {
  return withJobHistory(() => markJobRunStartedNow(job));
}

async function markJobRunStartedNow(job) {
  const signature = jobSignature(job);
  const now = Date.now();
  const entries = await readJobHistory();
  const index = entries.findIndex((entry) => entry.signature === signature);

  if (index < 0) {
    return null;
  }

  const [entry] = entries.splice(index, 1);
  entry.lastRunAt = now;
  entry.runCount = (entry.runCount || 0) + 1;
  entries.unshift(entry);
  await writeJobHistory(entries);
  return entry.id;
}

function markJobRunFinished(historyId, result) {
  return withJobHistory(() => markJobRunFinishedNow(historyId, result));
}

async function markJobRunFinishedNow(historyId, { success, cancelled }) {
  if (!historyId) {
    return readJobHistory();
  }

  const entries = await readJobHistory();
  const entry = entries.find((item) => item.id === historyId);
  if (!entry) {
    return entries;
  }

  entry.lastRunSuccess = cancelled ? null : success;
  return writeJobHistory(entries);
}
function cacheContentChrome(window) {
  const [contentWidth, contentHeight] = window.getContentSize();
  const [outerWidth, outerHeight] = window.getSize();
  contentChrome = {
    width: Math.max(0, outerWidth - contentWidth),
    height: Math.max(0, outerHeight - contentHeight),
  };
}

function getWorkAreaContentLimits(window) {
  const display = window
    ? screen.getDisplayMatching(window.getBounds())
    : screen.getPrimaryDisplay();
  const { workArea } = display;
  const frameWidth = contentChrome.width + SCREEN_MARGIN * 2;
  const frameHeight = contentChrome.height + SCREEN_MARGIN * 2;

  return {
    maxWidth: Math.max(
      WINDOW_ABSOLUTE_MIN_WIDTH,
      workArea.width - frameWidth,
    ),
    maxHeight: Math.max(
      WINDOW_ABSOLUTE_MIN_HEIGHT,
      workArea.height - frameHeight,
    ),
  };
}

function getPreferredContentSize(window) {
  const limits = getWorkAreaContentLimits(window);

  return {
    width: Math.max(
      WINDOW_ABSOLUTE_MIN_WIDTH,
      Math.floor(limits.maxWidth * WINDOW_PREFERRED_WIDTH_RATIO),
    ),
    height: Math.max(
      WINDOW_ABSOLUTE_MIN_HEIGHT,
      Math.floor(limits.maxHeight * WINDOW_PREFERRED_HEIGHT_RATIO),
    ),
  };
}

function getInitialContentSize() {
  const display = screen.getPrimaryDisplay();
  const maxWidth = Math.max(
    WINDOW_ABSOLUTE_MIN_WIDTH,
    display.workAreaSize.width - 48,
  );
  const maxHeight = Math.max(
    WINDOW_ABSOLUTE_MIN_HEIGHT,
    display.workAreaSize.height - 48,
  );

  return {
    width: Math.max(
      WINDOW_ABSOLUTE_MIN_WIDTH,
      Math.floor(maxWidth * WINDOW_PREFERRED_WIDTH_RATIO),
    ),
    height: Math.max(
      WINDOW_ABSOLUTE_MIN_HEIGHT,
      Math.floor(maxHeight * WINDOW_PREFERRED_HEIGHT_RATIO),
    ),
  };
}

function ensureWindowOnScreen(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  const bounds = window.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const { workArea } = display;
  const inset = 8;
  let { x, y, width, height } = bounds;

  width = Math.min(width, workArea.width - inset * 2);
  height = Math.min(height, workArea.height - inset * 2);
  x = Math.max(workArea.x + inset, Math.min(x, workArea.x + workArea.width - width - inset));
  y = Math.max(workArea.y + inset, Math.min(y, workArea.y + workArea.height - height - inset));

  if (
    x !== bounds.x ||
    y !== bounds.y ||
    width !== bounds.width ||
    height !== bounds.height
  ) {
    window.setBounds({ x, y, width, height });
  }
}

function applyMinimumContentSize(window) {
  window.setMinimumSize(WINDOW_ABSOLUTE_MIN_WIDTH, WINDOW_ABSOLUTE_MIN_HEIGHT);
  return {
    minWidth: WINDOW_ABSOLUTE_MIN_WIDTH,
    minHeight: WINDOW_ABSOLUTE_MIN_HEIGHT,
  };
}

function fitWindowToContent(window, { width, height } = {}, snap = false) {
  const limits = getWorkAreaContentLimits(window);
  const preferred = getPreferredContentSize(window);
  applyMinimumContentSize(window);

  const measuredWidth = width != null ? Math.ceil(width) : null;
  const targetWidth = measuredWidth != null
    ? Math.max(measuredWidth, preferred.width)
    : preferred.width;
  const desiredWidth = Math.min(
    limits.maxWidth,
    Math.max(WINDOW_ABSOLUTE_MIN_WIDTH, targetWidth),
  );
  const desiredHeight = Math.min(
    limits.maxHeight,
    Math.max(
      WINDOW_ABSOLUTE_MIN_HEIGHT,
      Math.ceil(height ?? preferred.height),
    ),
  );

  const [currentWidth, currentHeight] = window.getContentSize();
  const nextWidth = snap
    ? desiredWidth
    : Math.min(limits.maxWidth, Math.max(WINDOW_ABSOLUTE_MIN_WIDTH, currentWidth));
  const nextHeight = snap
    ? desiredHeight
    : Math.min(limits.maxHeight, Math.max(WINDOW_ABSOLUTE_MIN_HEIGHT, currentHeight));

  window.setContentSize(nextWidth, nextHeight);
  cacheContentChrome(window);
  ensureWindowOnScreen(window);

  return {
    minWidth: WINDOW_ABSOLUTE_MIN_WIDTH,
    minHeight: WINDOW_ABSOLUTE_MIN_HEIGHT,
    width: nextWidth,
    height: nextHeight,
    maxWidth: limits.maxWidth,
    maxHeight: limits.maxHeight,
  };
}

function createWindow() {
  const theme = getTheme();
  applyNativeTheme(theme);

  const initialSize = getInitialContentSize();
  const icon = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: WINDOW_ABSOLUTE_MIN_WIDTH,
    minHeight: WINDOW_ABSOLUTE_MIN_HEIGHT,
    useContentSize: true,
    center: true,
    show: false,
    backgroundColor: THEMES[theme].background,
    icon,
    title: "Glasswing",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--glasswing-theme=${theme}`],
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed() || !windowRevealed) {
      return;
    }
    ensureWindowOnScreen(mainWindow);
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  cacheContentChrome(mainWindow);

  // Windows mouse side buttons arrive as app-command, not reliable mouse events.
  mainWindow.on("app-command", (event, command) => {
    if (command !== "browser-backward" && command !== "browser-forward") {
      return;
    }
    event.preventDefault();
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    mainWindow.webContents.send(
      "history-navigate",
      command === "browser-backward" ? "back" : "forward",
    );
  });

  mainWindow.on("close", (event) => {
    if (!appQuitting && shouldKeepRunning()) {
      event.preventDefault();
      hideToTray();
      return;
    }
    if (closeConfirmed || !mounts.hasMounts()) {
      return;
    }
    event.preventDefault();
    void confirmCloseWithMounts();
  });

  if (icon) {
    mainWindow.setIcon(icon);
  }
}

async function confirmCloseWithMounts() {
  if (closeCheckInProgress) {
    return;
  }
  closeCheckInProgress = true;

  try {
    const pending = await mounts.getTotalPendingUploads();
    if (pending > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Uploads still running",
        message: `${pending} file${pending === 1 ? " is" : "s are"} still uploading from a mounted drive.`,
        detail:
          "Closing Glasswing unmounts all drives. Unfinished uploads stay in rclone's cache and resume the next time you mount the same remote.",
        buttons: ["Keep open", "Close anyway"],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 0) {
        return;
      }
    }

    closeConfirmed = true;
    mainWindow?.close();
  } finally {
    closeCheckInProgress = false;
  }
}

function runRclone(args, { interactive = false, timeoutMs = 0, binary = false, onSpawn = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, {
      windowsHide: !interactive,
      shell: false,
      env: process.env,
    });
    onSpawn?.(child);

    let stdout = binary ? null : "";
    const stdoutChunks = binary ? [] : null;
    let stderr = "";
    let settled = false;
    let timer = null;

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      handler();
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(() => {
          child.kill();
          reject(new Error(`rclone ${args[0] || ""} timed out after ${timeoutMs}ms`));
        });
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      if (binary) {
        stdoutChunks.push(chunk);
      } else {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      finish(() =>
        resolve({
          code,
          stdout: binary ? Buffer.concat(stdoutChunks) : stdout,
          stderr,
        }),
      );
    });
  });
}

async function fetchRemoteByteRange(source, offset, count, { timeoutMs = 120000 } = {}) {
  if (count <= 0) {
    return Buffer.alloc(0);
  }

  const result = await runRclone(
    [
      "cat",
      source,
      "--offset",
      String(offset),
      "--count",
      String(count),
      "--buffer-size",
      "128Ki",
    ],
    { timeoutMs, binary: true },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout?.toString?.() || `Failed to read bytes from "${source}"`);
  }

  return result.stdout;
}

// Prefer end-relative reads. Positive offsets near the end of huge files can make
// some remotes scan from byte 0; negative offsets map to HTTP suffix ranges.
async function fetchRemoteTail(source, byteCount, options = {}) {
  const count = Math.max(0, Math.floor(byteCount));
  if (count <= 0) {
    return Buffer.alloc(0);
  }
  return fetchRemoteByteRange(source, -count, count, options);
}

async function getRemoteObjectSize(source) {
  const result = await runRclone(["lsjson", source, "--files-only"], { timeoutMs: 60000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to inspect "${source}"`);
  }

  const trimmed = result.stdout.trim();
  const entries = trimmed ? JSON.parse(trimmed) : [];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`File not found: ${source}`);
  }

  const entry = entries.find((item) => !item.IsDir) || entries[0];
  if (typeof entry.Size !== "number" || entry.Size < 0) {
    throw new Error("Could not determine file size.");
  }

  return entry.Size;
}

function parseConfigDump(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return {};
  }

  return JSON.parse(trimmed);
}

function getRemoteEntriesFromDump(config) {
  return Object.entries(config)
    .map(([name, settings]) => ({
      name,
      type: settings?.type || "unknown",
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readRemoteEntries() {
  const result = await runRclone(["config", "dump"], { timeoutMs: 30000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to read rclone config");
  }

  return getRemoteEntriesFromDump(parseConfigDump(result.stdout));
}

async function listRemoteNames() {
  const result = await runRclone(["listremotes"], { timeoutMs: 15000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to list remotes");
  }

  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/:$/, ""))
    .filter(Boolean);
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function stopActiveJob() {
  if (!activeJob) {
    return false;
  }

  activeJob.killed = true;
  activeJob.process.kill();
  activeJob = null;
  return true;
}

ipcMain.handle("get-app-version", async () => app.getVersion());

function compareVersions(left, right) {
  const leftParts = String(left).split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const rightParts = String(right).split(/[.-]/).map((part) => parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

ipcMain.handle("open-release-page", async (_event, url) => {
  if (typeof url === "string" && url.startsWith("https://github.com/SSCHRE/rclone-gui-glasswing/")) {
    await shell.openExternal(url);
  }
});

ipcMain.handle("check-for-updates", async () => {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: "/repos/SSCHRE/rclone-gui-glasswing/releases/latest",
      method: "GET",
      headers: {
        "User-Agent": "Glasswing-Rclone",
      },
    };

    const req = require("https").request(options, (res) => {
      let data = "";

      res.on("data", (chunk) => {
        data += chunk;
      });

      res.on("end", () => {
        if (res.statusCode === 200) {
          try {
            const release = JSON.parse(data);
            const latestVersion = release.tag_name.replace(/^v/, "");
            const currentVersion = app.getVersion();
            
            resolve({
              currentVersion,
              latestVersion,
              hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
              releaseUrl: release.html_url,
              publishedAt: release.published_at,
            });
          } catch (error) {
            reject(new Error("Failed to parse GitHub release data"));
          }
        } else {
          reject(new Error(`GitHub API returned status ${res.statusCode}`));
        }
      });
    });

    req.on("error", (error) => {
      reject(error);
    });

    req.end();
  });
});

ipcMain.handle("set-minimum-content-size", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  return applyMinimumContentSize(mainWindow);
});

ipcMain.handle("probe-minimum-content-size", async (_event, size) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const { minWidth, minHeight } = fitWindowToContent(mainWindow, size, true);
  const [restoreWidth, restoreHeight] = mainWindow.getContentSize();
  mainWindow.setContentSize(minWidth, minHeight);

  return {
    minWidth,
    minHeight,
    restoreWidth,
    restoreHeight,
  };
});

ipcMain.handle("restore-content-size", async (_event, { width, height }) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const limits = getWorkAreaContentLimits(mainWindow);
  mainWindow.setContentSize(
    Math.min(limits.maxWidth, Math.max(WINDOW_ABSOLUTE_MIN_WIDTH, width)),
    Math.min(limits.maxHeight, Math.max(WINDOW_ABSOLUTE_MIN_HEIGHT, height)),
  );
  ensureWindowOnScreen(mainWindow);
});

ipcMain.handle("fit-window-to-content", async (_event, size, snap = false) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  return fitWindowToContent(mainWindow, size, snap);
});

ipcMain.handle("show-main-window", async () => {
  if (!mainWindow || mainWindow.isDestroyed() || !windowRevealed) {
    return;
  }

  ensureWindowOnScreen(mainWindow);

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
});

ipcMain.handle("get-work-area-limits", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const display = screen.getPrimaryDisplay();
    const maxWidth = Math.max(WINDOW_ABSOLUTE_MIN_WIDTH, display.workAreaSize.width - 48);
    const maxHeight = Math.max(WINDOW_ABSOLUTE_MIN_HEIGHT, display.workAreaSize.height - 48);
    return {
      maxWidth,
      maxHeight,
      preferredWidth: Math.max(
        WINDOW_ABSOLUTE_MIN_WIDTH,
        Math.floor(maxWidth * WINDOW_PREFERRED_WIDTH_RATIO),
      ),
      preferredHeight: Math.max(
        WINDOW_ABSOLUTE_MIN_HEIGHT,
        Math.floor(maxHeight * WINDOW_PREFERRED_HEIGHT_RATIO),
      ),
    };
  }

  const limits = getWorkAreaContentLimits(mainWindow);
  const preferred = getPreferredContentSize(mainWindow);
  return {
    ...limits,
    preferredWidth: preferred.width,
    preferredHeight: preferred.height,
  };
});

ipcMain.handle("get-rclone-version", async () => {
  const result = await runRclone(["version"], { timeoutMs: 15000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to run rclone version");
  }

  const firstLine = result.stdout.split("\n")[0].trim();
  return firstLine || "rclone (unknown version)";
});

ipcMain.handle("list-remotes", async () => listRemoteNames());

ipcMain.handle("list-remote-entries", async () => readRemoteEntries());

function normalizeRemoteBrowsePath(remotePath) {
  const raw = String(remotePath || "").trim();
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*):(.*)$/.exec(raw);
  if (!match) {
    throw new Error('Path must look like "remote:" or "remote:folder/path".');
  }

  const remote = match[1];
  const subPath = match[2].replace(/^\/+/, "").replace(/\\/g, "/");
  return subPath ? `${remote}:${subPath}` : `${remote}:`;
}

ipcMain.handle("list-remote-path", async (_event, remotePath) => {
  const target = normalizeRemoteBrowsePath(remotePath);
  const result = await runRclone(
    [
      "lsjson",
      target,
      "--max-depth",
      "1",
    ],
    { timeoutMs: 120000 },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to list "${target}"`);
  }

  const trimmed = result.stdout.trim();
  const entries = trimmed ? JSON.parse(trimmed) : [];
  if (!Array.isArray(entries)) {
    throw new Error("Unexpected rclone lsjson response.");
  }

  const mapped = entries
    .map((entry) => ({
      name: entry.Name || entry.Path || "",
      path: entry.Path || entry.Name || "",
      size: typeof entry.Size === "number" ? entry.Size : null,
      modTime: entry.ModTime || "",
      isDir: Boolean(entry.IsDir),
    }))
    .filter((entry) => entry.name && entry.name !== "." && entry.name !== "..");

  mapped.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  return { path: target, entries: mapped };
});

let activeRemoteSearch = null;

function stopRemoteSearch() {
  activeRemoteSearch?.kill();
  activeRemoteSearch = null;
}

ipcMain.handle("search-remote", async (_event, { remotePath, query, token }) => {
  stopRemoteSearch();
  let child = null;
  try {
    const summary = await remoteSearch.searchRemote(normalizeRemoteBrowsePath(remotePath), query, {
      onSpawn: (spawned) => {
        child = spawned;
        activeRemoteSearch = spawned;
      },
      onBatch: (items, scanned) => send("remote-search-results", { token, items, scanned }),
    });
    return { ok: true, ...summary };
  } catch (error) {
    return { ok: false, cancelled: Boolean(error.cancelled), message: error.message };
  } finally {
    if (activeRemoteSearch === child) {
      activeRemoteSearch = null;
    }
  }
});

ipcMain.handle("cancel-remote-search", async () => stopRemoteSearch());

ipcMain.handle("get-config-providers", async () => {
  const result = await runRclone(["config", "providers"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to load rclone providers");
  }

  return JSON.parse(result.stdout);
});

ipcMain.handle("get-remote-redacted", async (_event, name) => {
  if (!name?.trim()) {
    throw new Error("Remote name is required.");
  }

  const result = await runRclone(["config", "redacted", name.trim()]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to load remote "${name}"`);
  }

  return result.stdout.trim();
});

ipcMain.handle("delete-remote", async (_event, name) => {
  if (!name?.trim()) {
    throw new Error("Remote name is required.");
  }

  const result = await runRclone(["config", "delete", name.trim()]);
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to delete remote "${name}"`);
  }

  return readRemoteEntries();
});

ipcMain.handle("create-remote", async (_event, payload) => {
  const name = payload?.name?.trim();
  const type = payload?.type?.trim();
  const options = payload?.options || {};

  if (!name || !type) {
    throw new Error("Remote name and provider type are required.");
  }

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Remote name must start with a letter or number and contain only letters, numbers, underscore, or hyphen.");
  }

  const args = ["config", "create", name, type];
  for (const [key, value] of Object.entries(options)) {
    if (value === "" || value == null) {
      continue;
    }

    if (typeof value === "boolean") {
      args.push(`${key}=${value ? "true" : "false"}`);
      continue;
    }

    args.push(`${key}=${String(value)}`);
  }

  // Obscure password-type values for backends like koofr that require it.
  args.push("--obscure");

  const result = await runRclone(args);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to create remote "${name}"`);
  }

  return readRemoteEntries();
});

ipcMain.handle("authorize-provider", async (_event, provider) => {
  if (!provider?.trim()) {
    throw new Error("Provider type is required.");
  }

  const result = await runRclone(["authorize", provider.trim()], { interactive: true });
  if (result.code !== 0) {
    throw new Error(result.stderr || "Authorization failed or was cancelled.");
  }

  return result.stdout.trim();
});

ipcMain.handle("reconnect-remote", async (_event, name) => {
  if (!name?.trim()) {
    throw new Error("Remote name is required.");
  }

  const result = await runRclone(["config", "reconnect", name.trim()], { interactive: true });
  if (result.code !== 0) {
    throw new Error(result.stderr || `Failed to reconnect remote "${name}"`);
  }

  return result.stdout.trim();
});

function sendMountsChanged(event = null) {
  send("mounts-changed", { mounts: mounts.listMounts(), event });
}

ipcMain.handle("get-mount-status", async () => mounts.getStatus());

ipcMain.handle("get-bwlimit", async () => getBwlimit());

ipcMain.handle("set-theme", async (event, theme) => {
  if (!Object.hasOwn(THEMES, theme)) {
    throw new Error(`Unknown theme "${theme}".`);
  }
  await saveAppSettings({ theme });
  applyNativeTheme(theme);
  BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(THEMES[theme].background);
  return theme;
});

ipcMain.handle("set-bwlimit", async (_event, value) => {
  const bwlimit = normalizeBwlimit(value);
  await saveAppSettings({ bwlimit });
  const isTimetable = bwlimit.includes(",");
  const mountsUpdated = isTimetable ? 0 : await mounts.setBwlimit(bwlimit || "off");
  return { bwlimit, mountsUpdated, mountsNeedRemount: isTimetable ? mounts.listMounts().length : 0 };
});

ipcMain.handle("mount-remote", async (_event, payload) => {
  const remote = payload?.remote?.trim();
  if (!remote) {
    throw new Error("Remote name is required.");
  }
  if (!(await listRemoteNames()).includes(remote)) {
    throw new Error(`Remote "${remote}" was not found in your rclone config.`);
  }

  const mount = await mounts.startMount(
    {
      remote,
      driveLetter: payload.driveLetter,
      cacheMode: payload.cacheMode,
      readOnly: Boolean(payload.readOnly),
      bwlimit: getBwlimit(),
    },
    { onExit: (info) => sendMountsChanged({ type: "unmounted", ...info }) },
  );
  sendMountsChanged({ type: "mounted", remote: mount.remote, mountPoint: mount.mountPoint });
  return mounts.getStatus();
});

ipcMain.handle("unmount-remote", async (_event, remote, options) => {
  const result = await mounts.stopMount(String(remote || ""), { force: Boolean(options?.force) });
  return { ...result, status: mounts.getStatus() };
});

ipcMain.handle("open-mount", async (_event, remote) => {
  const mount = mounts.listMounts().find((item) => item.remote === remote);
  if (!mount) {
    throw new Error(`"${remote}" is not mounted.`);
  }
  const error = await shell.openPath(`${mount.mountPoint}\\`);
  if (error) {
    throw new Error(error);
  }
});

const LINUX_TERMINALS = [
  ["x-terminal-emulator", ["-e"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-x"]],
  ["mate-terminal", ["-x"]],
  ["tilix", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["wezterm", ["start", "--"]],
  ["foot", []],
  ["xterm", ["-e"]],
];

function findOnPath(command) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = dir && path.join(dir, command);
    if (candidate && fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function findLinuxTerminal() {
  const preferred = process.env.TERMINAL && findOnPath(process.env.TERMINAL);
  if (preferred) {
    return [preferred, ["-e"]];
  }
  for (const [command, args] of LINUX_TERMINALS) {
    const found = findOnPath(command);
    if (found) {
      return [found, args];
    }
  }
  return null;
}

async function openRcloneConfigInLinuxTerminal() {
  const terminal = findLinuxTerminal();
  if (!terminal) {
    throw new Error("Couldn't find a terminal app. Run \"rclone config\" in a terminal instead.");
  }

  const script = path.join(os.tmpdir(), "glasswing-rclone-config.sh");
  await fs.writeFile(
    script,
    '#!/bin/sh\nrclone config\nprintf "\\nPress Enter to close this window."\nread _\n',
    { mode: 0o755 },
  );
  await fs.chmod(script, 0o755);

  const [command, args] = terminal;
  const child = spawn(command, [...args, script], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

ipcMain.handle("open-rclone-config", async () => {
  if (process.platform === "linux") {
    await openRcloneConfigInLinuxTerminal();
    return;
  }

  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "", "cmd", "/k", "rclone", "config"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const child = spawn("rclone", ["config"], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
});

ipcMain.handle("get-config-file-path", async () => {
  const result = await runRclone(["config", "file"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to locate rclone config file");
  }

  return result.stdout.trim();
});

ipcMain.handle("pick-folder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (canceled || filePaths.length === 0) {
    return null;
  }

  return filePaths[0];
});

ipcMain.handle("pick-upload-files", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: "Upload files",
    properties: ["openFile", "multiSelections"],
  });
  return canceled ? [] : filePaths;
});

let activeUpload = null;

function createJsonLogReader(onEntry) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) {
        continue;
      }
      try {
        onEntry(JSON.parse(trimmed));
      } catch {}
    }
  };
}

async function measureLocalPath(localPath) {
  const name = path.basename(localPath);
  try {
    const stat = await fs.stat(localPath);
    if (!stat.isDirectory()) {
      return { path: localPath, name, isDir: false, size: stat.size };
    }

    const children = await fs.readdir(localPath, { recursive: true, withFileTypes: true });
    const sizes = await Promise.all(
      children
        .filter((child) => child.isFile())
        .map((child) =>
          fs.stat(path.join(child.parentPath ?? child.path, child.name)).then(
            (childStat) => childStat.size,
            () => 0,
          ),
        ),
    );
    return { path: localPath, name, isDir: true, size: sizes.reduce((sum, size) => sum + size, 0) };
  } catch {
    return { path: localPath, name, isDir: false, size: 0 };
  }
}

const CHUNK_FINISHED_PATTERN = /^multi-thread copy: chunk \d+\/\d+ \((\d+)-(\d+)\) size \S+ finished/;

function createChunkTracker() {
  const finishedBytes = new Map();

  return {
    handle(entry) {
      const object = entry.object;
      const message = String(entry.msg || "");
      if (!object) {
        return;
      }
      if (message.startsWith("Starting multi-thread copy")) {
        finishedBytes.set(object, 0);
        return;
      }
      const match = CHUNK_FINISHED_PATTERN.exec(message);
      if (match) {
        finishedBytes.set(object, (finishedBytes.get(object) || 0) + Number(match[2]) - Number(match[1]));
      }
    },
    confirmed(stats) {
      const transferring = stats.transferring || [];
      const bytes = Number(stats.bytes) || 0;
      let inProgress = 0;
      let confirmedInProgress = 0;
      for (const transfer of transferring) {
        const transferBytes = Number(transfer.bytes) || 0;
        inProgress += transferBytes;
        confirmedInProgress += finishedBytes.has(transfer.name)
          ? Math.min(finishedBytes.get(transfer.name), transferBytes)
          : transferBytes;
      }
      return Math.max(0, bytes - inProgress + confirmedInProgress);
    },
  };
}

const DRIME_ROOT_UPLOAD_ERROR =
  "Drime doesn't accept large files at the top level of a remote. Open or create a folder and upload into it instead.";

function parseSizeSuffix(value) {
  const match = /^\s*([\d.]+)\s*([bkmgtp])?i?b?\s*$/i.exec(String(value ?? ""));
  if (!match) {
    return null;
  }
  const units = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };
  return Math.round(Number(match[1]) * units[(match[2] || "k").toLowerCase()]);
}

async function getRootUploadLimit(target) {
  if (!target.endsWith(":")) {
    return null;
  }
  try {
    const result = await runRclone(["config", "dump"], { timeoutMs: 30000 });
    if (result.code !== 0) {
      return null;
    }
    const settings = parseConfigDump(result.stdout)[target.slice(0, -1)];
    if (settings?.type !== "drime") {
      return null;
    }
    return parseSizeSuffix(settings.upload_cutoff) ?? 5 * 1024 * 1024;
  } catch {
    return null;
  }
}

function describeUploadError(message) {
  return /parentId/i.test(message) ? DRIME_ROOT_UPLOAD_ERROR : message;
}

ipcMain.handle("measure-local-paths", async (_event, localPaths) => {
  const paths = Array.isArray(localPaths)
    ? localPaths.filter((localPath) => typeof localPath === "string" && localPath.trim())
    : [];
  return Promise.all(paths.map(measureLocalPath));
});

function joinRemoteChild(base, name) {
  return base.endsWith(":") ? `${base}${name}` : `${base}/${name}`;
}

function stopActiveUpload() {
  if (!activeUpload) {
    return;
  }
  activeUpload.cancelled = true;
  const child = activeUpload.child;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {}
  }
}

ipcMain.handle("upload-to-remote", async (_event, payload) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before uploading.");
  }
  if (activeUpload) {
    throw new Error("An upload is already running.");
  }

  const target = normalizeRemoteBrowsePath(payload?.remotePath);
  const localPaths = Array.isArray(payload?.localPaths)
    ? payload.localPaths.filter((localPath) => typeof localPath === "string" && localPath.trim())
    : [];
  if (!localPaths.length) {
    throw new Error("Choose at least one file to upload.");
  }

  const upload = { child: null, cancelled: false };
  const total = localPaths.length;
  const failed = [];
  let uploaded = 0;
  activeUpload = upload;
  const rootUploadLimit = await getRootUploadLimit(target);

  try {
    for (const [index, localPath] of localPaths.entries()) {
      if (upload.cancelled) {
        break;
      }

      const name = path.basename(localPath);
      let stat;
      try {
        stat = await fs.stat(localPath);
      } catch (error) {
        failed.push({ name, error: error.message || "File not found." });
        continue;
      }
      const stagingDir = rootUploadLimit != null && !stat.isDirectory() && stat.size > rootUploadLimit
        ? `${target}glasswing-upload-${randomUUID().slice(0, 8)}`
        : null;
      const destination = joinRemoteChild(target, name);
      send("upload-progress", { index, bytes: 0, confirmed: 0, current: "" });

      const errors = [];
      const chunks = createChunkTracker();
      const result = await runRclone(
        [
          stat.isDirectory() ? "copy" : "copyto",
          localPath,
          stagingDir ? joinRemoteChild(stagingDir, name) : destination,
          "--stats",
          "500ms",
          "--stats-log-level",
          "NOTICE",
          "--log-level",
          "DEBUG",
          "--multi-thread-cutoff",
          "16Mi",
          "--retries",
          "1",
          "--use-json-log",
          ...bwlimitArgs(),
        ],
        {
          timeoutMs: 0,
          onSpawn: (child) => {
            upload.child = child;
            child.stderr.on("data", createJsonLogReader((entry) => {
              if (entry.level === "error" && entry.msg) {
                errors.push(String(entry.msg).trim());
              }
              if (entry.level === "debug") {
                chunks.handle(entry);
                return;
              }
              const stats = entry.stats;
              if (stats) {
                send("upload-progress", {
                  index,
                  bytes: Number(stats.bytes) || 0,
                  confirmed: chunks.confirmed(stats),
                  current: stats.transferring?.[0]?.name || "",
                });
              }
            }));
          },
        },
      );
      upload.child = null;

      let moveError = null;
      if (stagingDir && result.code === 0 && !upload.cancelled) {
        const moved = await runRclone(
          ["moveto", joinRemoteChild(stagingDir, name), destination],
          { timeoutMs: 0, onSpawn: (child) => { upload.child = child; } },
        );
        upload.child = null;
        if (moved.code !== 0) {
          moveError = moved.stderr.trim() || `Failed to move "${name}" into place.`;
        }
      }
      if (stagingDir) {
        await runRclone(["purge", stagingDir], { timeoutMs: 60000 }).catch(() => {});
      }

      if (upload.cancelled) {
        break;
      }
      if (result.code !== 0 || moveError) {
        failed.push({
          name,
          error: describeUploadError(moveError || errors[errors.length - 1] || `Failed to upload "${name}".`),
        });
        continue;
      }
      uploaded += 1;
    }
  } finally {
    activeUpload = null;
  }

  return { uploaded, failed, total, cancelled: upload.cancelled, target };
});

ipcMain.handle("cancel-upload", async () => {
  stopActiveUpload();
});

ipcMain.handle("pick-save-file", async (_event, defaultName) => {
  const suggested = String(defaultName || "download").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggested,
    properties: ["showOverwriteConfirmation", "createDirectory"],
  });

  if (canceled || !filePath) {
    return null;
  }

  return filePath;
});

let activeDownload = null;

function stopActiveDownload() {
  if (!activeDownload) {
    return;
  }
  activeDownload.cancelled = true;
  const child = activeDownload.child;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {}
  }
}

async function removePartialDownloads(localPath) {
  const dir = path.dirname(localPath);
  const base = path.basename(localPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${base}\\.[0-9a-f]{8}\\.partial$`, "i");
  try {
    const names = await fs.readdir(dir);
    await Promise.all(
      names.filter((name) => pattern.test(name)).map((name) => fs.rm(path.join(dir, name), { force: true })),
    );
  } catch {}
}

ipcMain.handle("download-remote-file", async (_event, payload) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before downloading.");
  }
  if (activeDownload) {
    throw new Error("A download is already running.");
  }

  const remotePath = payload?.remotePath;
  const localPath = payload?.localPath?.trim();
  if (!localPath) {
    throw new Error("A local save path is required.");
  }

  const source = normalizeRemoteBrowsePath(remotePath);
  const download = { child: null, cancelled: false };
  activeDownload = download;
  const errors = [];
  const chunks = createChunkTracker();

  try {
    send("download-progress", { index: 0, bytes: 0, confirmed: 0, total: 0 });
    const result = await runRclone(
      [
        "copyto",
        source,
        localPath,
        "--stats",
        "500ms",
        "--stats-log-level",
        "NOTICE",
        "--log-level",
        "DEBUG",
        "--retries",
        "1",
        "--use-json-log",
        ...bwlimitArgs(),
      ],
      {
        timeoutMs: 0,
        onSpawn: (child) => {
          download.child = child;
          child.stderr.on("data", createJsonLogReader((entry) => {
            if (entry.level === "error" && entry.msg) {
              errors.push(String(entry.msg).trim());
            }
            if (entry.level === "debug") {
              chunks.handle(entry);
              return;
            }
            const stats = entry.stats;
            if (stats) {
              send("download-progress", {
                index: 0,
                bytes: Number(stats.bytes) || 0,
                confirmed: chunks.confirmed(stats),
                total: Number(stats.totalBytes) || 0,
              });
            }
          }));
        },
      },
    );

    if (download.cancelled) {
      await removePartialDownloads(localPath);
      return { source, localPath, cancelled: true };
    }
    if (result.code !== 0) {
      await removePartialDownloads(localPath);
      throw new Error(errors[errors.length - 1] || `Failed to download "${source}"`);
    }
    return { source, localPath, cancelled: false };
  } finally {
    activeDownload = null;
  }
});

ipcMain.handle("cancel-download", async () => {
  stopActiveDownload();
});

ipcMain.handle("delete-remote-file", async (_event, payload) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before deleting.");
  }

  const remotePath = payload?.remotePath;
  const isDir = payload?.isDir || false;
  if (!remotePath?.trim()) {
    throw new Error("A remote path is required.");
  }

  const source = normalizeRemoteBrowsePath(remotePath);
  // Use purge for directories (deletes directory and all contents), delete for files
  const command = isDir ? "purge" : "delete";
  const result = await runRclone([command, source], {
    timeoutMs: 0,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "Failed to delete " + source);
  }

  return { source };
});

ipcMain.handle("create-remote-folder", async (_event, payload) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before creating a folder.");
  }

  const { remotePath, folderName } = payload;
  if (!remotePath?.trim() || !folderName?.trim()) {
    throw new Error("Remote path and folder name are required.");
  }

  const source = normalizeRemoteBrowsePath(remotePath);
  // Build the folder path: remote:current/path/newFolder
  const folderPath = source.endsWith(":") ? `${source}${folderName}` : `${source}/${folderName}`;
  
  // Use rclone mkdir to create the directory
  const result = await runRclone(["mkdir", folderPath], {
    timeoutMs: 0,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to create folder "${folderName}"`);
  }

  return { folderPath };
});

const PREVIEW_KINDS = {
  ".txt": { kind: "text", mime: "text/plain", maxBytes: 2 * 1024 * 1024, mode: "buffer" },
  ".pdf": { kind: "pdf", mime: "application/pdf", maxBytes: 40 * 1024 * 1024, mode: "buffer" },
  ".mp3": { kind: "audio", mime: "audio/mpeg", mode: "stream" },
  ".mp4": { kind: "video", mime: "video/mp4", mode: "stream" },
  ".zip": { kind: "zip", mime: "application/zip", mode: "zip" },
  ".7z": { kind: "zip", mime: "application/x-7z-compressed", mode: "7z" },
  ".jpg": { kind: "image", mime: "image/jpeg", maxBytes: 40 * 1024 * 1024, mode: "buffer" },
  ".jpeg": { kind: "image", mime: "image/jpeg", maxBytes: 40 * 1024 * 1024, mode: "buffer" },
  ".png": { kind: "image", mime: "image/png", maxBytes: 40 * 1024 * 1024, mode: "buffer" },
};

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP_ZIP64_EOCD_SIG = 0x06064b50;
const ZIP_PREVIEW_ENTRY_LIMIT = 5000;
const ZIP_MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
// EOCD is always within the last 22..65557 bytes (incl. max comment).
const ZIP_EOCD_PROBE_BYTES = 65557;

// Session cache so reopening the same archive doesn't re-fetch the index.
const zipPreviewCache = new Map();
const ZIP_PREVIEW_CACHE_LIMIT = 8;

function parseZipCentralDirectory(central, totalEntriesHint) {
  const entries = [];
  let offset = 0;
  let truncated = false;

  while (offset + 46 <= central.length) {
    if (central.readUInt32LE(offset) !== ZIP_CD_SIG) {
      break;
    }

    const flags = central.readUInt16LE(offset + 8);
    let compressedSize = central.readUInt32LE(offset + 20);
    let uncompressedSize = central.readUInt32LE(offset + 24);
    const nameLen = central.readUInt16LE(offset + 28);
    const extraLen = central.readUInt16LE(offset + 30);
    const commentLen = central.readUInt16LE(offset + 32);
    const externalAttr = central.readUInt32LE(offset + 38);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > central.length) {
      break;
    }

    const nameBuf = central.subarray(nameStart, nameEnd);
    const name = (flags & 0x800 ? nameBuf.toString("utf8") : nameBuf.toString("latin1")).replace(/\\/g, "/");

    const extraStart = nameEnd;
    const extraEnd = extraStart + extraLen;
    if (
      (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) &&
      extraLen >= 4 &&
      extraEnd <= central.length
    ) {
      let extraOffset = extraStart;
      while (extraOffset + 4 <= extraEnd) {
        const headerId = central.readUInt16LE(extraOffset);
        const dataSize = central.readUInt16LE(extraOffset + 2);
        const dataStart = extraOffset + 4;
        const dataEnd = dataStart + dataSize;
        if (dataEnd > extraEnd) {
          break;
        }
        if (headerId === 0x0001) {
          let zip64Pos = dataStart;
          if (uncompressedSize === 0xffffffff && zip64Pos + 8 <= dataEnd) {
            uncompressedSize = Number(central.readBigUInt64LE(zip64Pos));
            zip64Pos += 8;
          }
          if (compressedSize === 0xffffffff && zip64Pos + 8 <= dataEnd) {
            compressedSize = Number(central.readBigUInt64LE(zip64Pos));
          }
          break;
        }
        extraOffset = dataEnd;
      }
    }

    const isDir = name.endsWith("/") || ((externalAttr >>> 16) & 0o40000) !== 0;
    if (entries.length < ZIP_PREVIEW_ENTRY_LIMIT) {
      entries.push({
        name,
        size: isDir ? null : uncompressedSize,
        compressedSize: isDir ? null : compressedSize,
        isDir,
      });
    } else {
      truncated = true;
    }

    offset = nameEnd + extraLen + commentLen;
  }

  entries.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });

  const totalEntries = Math.max(totalEntriesHint || 0, entries.length + (truncated ? 1 : 0));
  return {
    entries,
    totalEntries,
    truncated: truncated || totalEntries > entries.length,
  };
}

function zipPreviewCacheKey(source, archiveSize) {
  return `${source}\0${archiveSize}`;
}

function rememberZipPreview(source, archiveSize, payload) {
  const key = zipPreviewCacheKey(source, archiveSize);
  if (zipPreviewCache.has(key)) {
    zipPreviewCache.delete(key);
  }
  zipPreviewCache.set(key, payload);
  while (zipPreviewCache.size > ZIP_PREVIEW_CACHE_LIMIT) {
    const oldest = zipPreviewCache.keys().next().value;
    zipPreviewCache.delete(oldest);
  }
}

async function listZipEntriesFromRemote(source, archiveSize) {
  if (!Number.isFinite(archiveSize) || archiveSize < 22) {
    throw new Error("Not a valid zip archive.");
  }

  // 1) Tiny end probe for EOCD (always in the last ~64KiB).
  // 2) If needed, one precise suffix fetch for the central directory.
  // Never use positive offsets into multi-GB objects.
  let tail = await fetchRemoteTail(source, Math.min(archiveSize, ZIP_EOCD_PROBE_BYTES), {
    timeoutMs: 120000,
  });
  let tailOffset = archiveSize - tail.length;

  const findEocd = (buffer) => {
    for (let i = buffer.length - 22; i >= 0; i -= 1) {
      if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
        return i;
      }
    }
    return -1;
  };

  const eocd = findEocd(tail);
  if (eocd < 0) {
    throw new Error("Invalid or unsupported zip (missing central directory).");
  }

  let totalEntries = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    let locator = -1;
    for (let i = eocd - 20; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === ZIP_ZIP64_LOCATOR_SIG) {
        locator = i;
        break;
      }
    }
    if (locator < 0) {
      throw new Error("Unsupported zip64 archive.");
    }

    const zip64EocdOffset = Number(tail.readBigUInt64LE(locator + 8));
    let zip64Header;
    if (zip64EocdOffset >= tailOffset && zip64EocdOffset + 56 <= archiveSize) {
      const local = zip64EocdOffset - tailOffset;
      zip64Header = tail.subarray(local, local + 56);
    } else {
      const fromEnd = archiveSize - zip64EocdOffset;
      const slice = await fetchRemoteTail(source, fromEnd, { timeoutMs: 180000 });
      zip64Header = slice.subarray(0, 56);
    }

    if (zip64Header.length < 56 || zip64Header.readUInt32LE(0) !== ZIP_ZIP64_EOCD_SIG) {
      throw new Error("Unsupported zip64 archive.");
    }

    totalEntries = Number(zip64Header.readBigUInt64LE(32));
    cdSize = Number(zip64Header.readBigUInt64LE(40));
    cdOffset = Number(zip64Header.readBigUInt64LE(48));
  }

  if (!Number.isFinite(cdSize) || !Number.isFinite(cdOffset) || cdSize < 0 || cdOffset < 0) {
    throw new Error("Invalid zip central directory.");
  }
  if (cdSize > ZIP_MAX_CENTRAL_DIRECTORY) {
    throw new Error("Zip central directory is too large to preview.");
  }
  if (cdOffset > archiveSize || cdOffset + cdSize > archiveSize) {
    throw new Error("Invalid zip central directory offsets.");
  }

  let central;
  if (cdSize === 0) {
    central = Buffer.alloc(0);
  } else if (cdOffset >= tailOffset && cdOffset + cdSize <= tailOffset + tail.length) {
    const local = cdOffset - tailOffset;
    central = Buffer.from(tail.subarray(local, local + cdSize));
  } else {
    // Exact suffix covering central directory → end of file.
    const fromEnd = archiveSize - cdOffset;
    const slice = await fetchRemoteTail(source, fromEnd, { timeoutMs: 300000 });
    if (slice.length < cdSize) {
      throw new Error("Failed to read zip central directory.");
    }
    central = Buffer.from(slice.subarray(0, cdSize));
  }

  return parseZipCentralDirectory(central, totalEntries);
}

let previewServe = null;
let previewFetchChild = null;
const cancelledPreviewFetches = new WeakSet();

function stopPreviewFetch() {
  const child = previewFetchChild;
  previewFetchChild = null;
  if (child && !child.killed) {
    cancelledPreviewFetches.add(child);
    try {
      child.kill();
    } catch {}
  }
}

function previewKindFromPath(remotePath) {
  const base = remotePath.split("/").pop() || remotePath;
  const ext = path.extname(base).toLowerCase();
  return PREVIEW_KINDS[ext] || null;
}

function sanitizePreviewFileName(remotePath, ext) {
  const raw = path.basename((remotePath.split(":").pop() || `preview${ext}`).replace(/\\/g, "/"));
  const cleaned = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim() || `preview${ext}`;
  return cleaned;
}

function splitRemoteParentAndFile(source) {
  const match = /^([^:]+):(.*)$/.exec(source);
  const remote = match[1];
  const subPath = (match[2] || "").replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = subPath.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  const parentPath = parts.length ? `${remote}:${parts.join("/")}` : `${remote}:`;
  return { parentPath, fileName };
}

function stopPreviewServe() {
  if (!previewServe) {
    return;
  }

  const child = previewServe.child;
  previewServe = null;
  if (child && !child.killed) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}

function startPreviewServe(parentPath) {
  return new Promise((resolve, reject) => {
    stopPreviewServe();

    // No basic auth: Chromium strips user:pass from media element fetches.
    // Small VFS chunks avoid the default 128Mi read-ahead that pulled whole MP3s.
    const child = spawn(
      "rclone",
      [
        "serve",
        "http",
        parentPath,
        "--addr",
        "127.0.0.1:0",
        "--vfs-cache-mode",
        "off",
        "--vfs-read-chunk-size",
        "512k",
        "--vfs-read-chunk-size-limit",
        "2M",
        "--buffer-size",
        "512k",
      ],
      {
        windowsHide: true,
        shell: false,
        env: process.env,
      },
    );

    let settled = false;
    let output = "";

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      handler();
    };

    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        reject(new Error("Timed out starting media preview stream."));
      });
    }, 20000);

    const onData = (chunk) => {
      output += chunk.toString();
      const match =
        output.match(/Serving on (https?:\/\/[^\s\]]+)/i) ||
        output.match(/HTTP Server started on \[(https?:\/\/[^\]]+)\]/i) ||
        output.match(/HTTP Server started on (https?:\/\/[^\s\]]+)/i);
      if (!match) {
        return;
      }

      finish(() => {
        const baseUrl = match[1].replace(/\/$/, "");
        previewServe = { child, baseUrl };
        resolve(previewServe);
      });
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (error) => {
      finish(() => reject(error));
    });

    child.on("close", (code) => {
      if (previewServe?.child === child) {
        previewServe = null;
      }
      finish(() => {
        reject(new Error(output.trim() || `Preview stream exited (code ${code ?? "?"}).`));
      });
    });
  });
}

ipcMain.handle("open-remote-preview", async (_event, remotePath, options = {}) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before opening a preview.");
  }

  const source = normalizeRemoteBrowsePath(remotePath);
  const meta = previewKindFromPath(source);
  if (!meta) {
    throw new Error("Preview supports .txt, .pdf, .mp3, .mp4, .zip, .7z, .jpg, .jpeg, and .png files only.");
  }

  if (meta.mode === "stream") {
    const { parentPath, fileName } = splitRemoteParentAndFile(source);
    if (!fileName) {
      throw new Error("Invalid media path for preview.");
    }

    const serve = await startPreviewServe(parentPath);
    // Avoid encodeURIComponent on the whole name: rclone serves path segments with
    // percent-encoding for reserved chars only (spaces -> %20 is fine via encodeURI).
    const streamUrl = `${serve.baseUrl}/${encodeURI(fileName).replace(/#/g, "%23")}`;
    return {
      kind: meta.kind,
      name: fileName,
      mime: meta.mime,
      streamUrl,
      streamed: true,
    };
  }

  if (meta.mode === "zip" || meta.mode === "7z") {
    stopPreviewServe();
    const { fileName } = splitRemoteParentAndFile(source);
    if (!fileName) {
      throw new Error("Invalid archive path for preview.");
    }

    const hintedSize = Number(options?.size);
    const archiveSize =
      Number.isFinite(hintedSize) && hintedSize >= 0 ? hintedSize : await getRemoteObjectSize(source);

    const cacheKey = zipPreviewCacheKey(source, archiveSize);
    const cached = zipPreviewCache.get(cacheKey);
    if (cached) {
      rememberZipPreview(source, archiveSize, cached);
      return { ...cached };
    }

    const listed =
      meta.mode === "7z"
        ? await require("./7z-preview").listSevenZEntriesFromRemote(source, archiveSize, {
            fetchRange: fetchRemoteByteRange,
            fetchTail: fetchRemoteTail,
          })
        : await listZipEntriesFromRemote(source, archiveSize);

    const payload = {
      kind: "zip",
      name: fileName,
      entries: listed.entries,
      totalEntries: listed.totalEntries,
      truncated: listed.truncated,
      archiveBytes: archiveSize,
    };
    rememberZipPreview(source, archiveSize, payload);
    return payload;
  }

  stopPreviewServe();
  stopPreviewFetch();

  const tmpDir = path.join(app.getPath("temp"), "glasswing-preview", randomUUID());
  const localPath = path.join(tmpDir, sanitizePreviewFileName(source, path.extname(source)));

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    let fetchChild = null;
    const result = await runRclone(["copyto", source, localPath], {
      timeoutMs: 0,
      onSpawn: (child) => {
        fetchChild = child;
        previewFetchChild = child;
      },
    });
    if (previewFetchChild === fetchChild) {
      previewFetchChild = null;
    }
    if (fetchChild && cancelledPreviewFetches.has(fetchChild)) {
      return { cancelled: true };
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `Failed to fetch "${source}"`);
    }

    const stat = await fs.stat(localPath);
    if (meta.maxBytes && stat.size > meta.maxBytes) {
      const limitMb = Math.round(meta.maxBytes / (1024 * 1024));
      throw new Error(`Preview is limited to ${limitMb} MB for ${meta.kind} files.`);
    }

    if (meta.kind === "text") {
      const text = await fs.readFile(localPath, "utf8");
      return {
        kind: meta.kind,
        name: path.basename(localPath),
        text,
      };
    }

    const data = await fs.readFile(localPath);
    return {
      kind: meta.kind,
      name: path.basename(localPath),
      mime: meta.mime,
      data,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

ipcMain.handle("close-remote-preview", async () => {
  stopPreviewServe();
  stopPreviewFetch();
});

function describeJobFailure(operation, output) {
  if (operation !== "bisync") {
    return {};
  }
  if (/Must run --resync/i.test(output)) {
    return {
      needsResync: true,
      message: "Bisync needs a resync first: on the first run, or after an interrupted run. Resync is now ticked; run the job again.",
    };
  }
  if (/filename, directory name, or volume label syntax is incorrect/i.test(output)) {
    return {
      message: "Bisync couldn't save its state file because the two paths together are too long for Windows. Try shorter paths.",
    };
  }
  return {};
}

function buildJobArgs(job, { appLimits = true } = {}) {
  const operation = job?.operation;
  if (!JOB_OPERATIONS.includes(operation)) {
    throw new Error(`Unsupported operation: ${operation}`);
  }

  const args = [
    operation,
    job.source,
    job.destination,
    "--stats",
    "1s",
    "--stats-one-line",
    "--stats-one-line-date",
    "--verbose",
  ];

  if (job.dryRun) {
    args.push("--dry-run");
  }

  if (job.deleteExcluded && operation === "sync") {
    args.push("--delete-excluded");
  }

  if (operation === "bisync") {
    args.push("--color", "NEVER");
    if (job.resync) {
      args.push("--resync");
    }
  }

  if (appLimits) {
    args.push(...bwlimitArgs());
  }

  args.push(...parseExtraArgs(job.extraArgs));
  return args;
}

function quoteCommandArg(arg) {
  const text = String(arg);
  if (text && !/[\s"'&|<>^()%!;`$]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

const MAX_APPROVED_COMMANDS = 200;

function getApprovedCommandsPath() {
  return path.join(app.getPath("userData"), "approved-commands.json");
}

function commandFingerprint(args) {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

async function readApprovedCommands() {
  try {
    const parsed = JSON.parse(await fs.readFile(getApprovedCommandsPath(), "utf8"));
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

ipcMain.handle("preview-job-command", async (_event, job) => {
  const args = buildJobArgs(job);
  const approved = await readApprovedCommands();
  return {
    args,
    command: ["rclone", ...args].map(quoteCommandArg).join(" "),
    approved: approved.includes(commandFingerprint(buildJobArgs(job, { appLimits: false }))),
  };
});

ipcMain.handle("approve-job-command", async (_event, job) => {
  const fingerprint = commandFingerprint(buildJobArgs(job, { appLimits: false }));
  const approved = (await readApprovedCommands()).filter((item) => item !== fingerprint);
  approved.unshift(fingerprint);
  const filePath = getApprovedCommandsPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(approved.slice(0, MAX_APPROVED_COMMANDS), null, 2), "utf8");
});

ipcMain.handle("start-job", async (_event, job) => startJob(job));

async function startJob(job, { scheduled = null } = {}) {
  if (activeJob || jobStarting) {
    throw new Error("A job is already running.");
  }

  const operation = job.operation;
  const args = buildJobArgs(job);

  jobStarting = true;
  let historyId = null;
  try {
    historyId = await markJobRunStarted({
      operation,
      source: job.source,
      destination: job.destination,
      dryRun: job.dryRun,
      deleteExcluded: job.deleteExcluded,
      extraArgs: job.extraArgs,
    });
  } catch {}

  const child = spawn("rclone", args, {
    windowsHide: true,
    shell: false,
  });

  const jobState = {
    id: Date.now(),
    process: child,
    job,
    killed: false,
    outputTail: "",
    scheduled,
    historyId,
  };

  activeJob = jobState;
  jobStarting = false;

  send("job-started", {
    id: jobState.id,
    operation,
    source: job.source,
    destination: job.destination,
    scheduled: scheduled ? { name: scheduled.name } : null,
  });

  const forwardOutput = (stream, type) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
      jobState.outputTail = (jobState.outputTail + text).slice(-JOB_OUTPUT_TAIL_CHARS);
      send("job-output", {
        id: jobState.id,
        type,
        text,
      });
    });
  };

  forwardOutput(child.stdout, "stdout");
  forwardOutput(child.stderr, "stderr");

  child.on("error", async (error) => {
    await markJobRunFinished(jobState.historyId, { success: false, cancelled: false });
    send("job-finished", {
      id: jobState.id,
      code: -1,
      success: false,
      message: error.message,
      cancelled: false,
    });
    activeJob = null;
    onJobSettled(jobState, { success: false, cancelled: false, message: error.message });
  });

  child.on("close", async (code) => {
    const cancelled = jobState.killed;
    const success = code === 0 && !cancelled;
    const failure = !success && !cancelled ? describeJobFailure(operation, jobState.outputTail) : {};
    await markJobRunFinished(jobState.historyId, { success, cancelled });
    send("job-finished", {
      id: jobState.id,
      code,
      success,
      message: cancelled ? "" : success ? "Job completed successfully." : failure.message || "Job failed.",
      cancelled,
      needsResync: Boolean(failure.needsResync),
    });

    if (activeJob && activeJob.id === jobState.id) {
      activeJob = null;
    }
    onJobSettled(jobState, {
      success,
      cancelled,
      message: success ? "" : failure.message || (cancelled ? "" : "rclone exited with an error."),
    });
  });

  return { id: jobState.id };
}

ipcMain.handle("stop-job", async () => {
  const stopped = stopActiveJob();
  return { stopped };
});

ipcMain.handle("list-jobs", async () => readJobHistory());

ipcMain.handle("save-job", async (_event, job) => {
  if (!job?.source?.trim() || !job?.destination?.trim()) {
    throw new Error("Source and destination are required.");
  }

  if (!JOB_OPERATIONS.includes(job.operation)) {
    throw new Error(`Unsupported operation: ${job.operation}`);
  }

  return upsertJobHistory(
    {
      operation: job.operation,
      source: job.source.trim(),
      destination: job.destination.trim(),
      dryRun: !!job.dryRun,
      deleteExcluded: !!job.deleteExcluded,
      extraArgs: (job.extraArgs || "").trim(),
    },
    { name: job.name },
  );
});

ipcMain.handle("update-job", async (_event, jobId, job) => {
  if (!jobId) {
    throw new Error("Saved job id is required.");
  }

  if (!job?.source?.trim() || !job?.destination?.trim()) {
    throw new Error("Source and destination are required.");
  }

  if (!JOB_OPERATIONS.includes(job.operation)) {
    throw new Error(`Unsupported operation: ${job.operation}`);
  }

  return updateSavedJob(jobId, {
    operation: job.operation,
    source: job.source.trim(),
    destination: job.destination.trim(),
    dryRun: !!job.dryRun,
    deleteExcluded: !!job.deleteExcluded,
    extraArgs: (job.extraArgs || "").trim(),
  });
});

ipcMain.handle("delete-job", async (_event, jobId) => {
  const result = await withJobHistory(async () => {
    const entries = await readJobHistory();
    return writeJobHistory(entries.filter((entry) => entry.id !== jobId));
  });
  void refreshSchedules();
  return result;
});

const SCHEDULER_TICK_MS = 15000;
const SCHEDULER_FIRST_CHECK_MS = 4000;
const SCHEDULE_GRACE_MS = 5 * 60 * 1000;
const scheduleQueue = [];
let scheduledJobs = [];
let tray = null;

function getRunInBackground() {
  return getAppSettings().runInBackground !== false;
}

function shouldKeepRunning() {
  return scheduledJobs.length > 0 && getRunInBackground();
}

function canOpenAtLogin() {
  return app.isPackaged && (process.platform === "win32" || process.platform === "linux");
}

function loginItemOptions() {
  return { path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ["--hidden"] };
}

function getLinuxAutostartPath() {
  return path.join(app.getPath("appData"), "autostart", "glasswing.desktop");
}

function quoteDesktopExecArg(value) {
  return `"${value.replace(/([\\"`$])/g, "\\\\$1")}"`;
}

async function setLinuxAutostart(enabled) {
  const file = getLinuxAutostartPath();
  if (!enabled) {
    await fs.rm(file, { force: true });
    return;
  }
  const executable = process.env.APPIMAGE || process.execPath;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Glasswing",
      "Comment=Runs scheduled rclone jobs in the background",
      `Exec=${quoteDesktopExecArg(executable)} --hidden`,
      "Terminal=false",
      "X-GNOME-Autostart-enabled=true",
      "",
    ].join("\n"),
    "utf8",
  );
}

function isOpenAtLogin() {
  if (!canOpenAtLogin()) {
    return false;
  }
  if (process.platform === "linux") {
    return fsSync.existsSync(getLinuxAutostartPath());
  }
  return app.getLoginItemSettings(loginItemOptions()).openAtLogin;
}

async function setOpenAtLogin(enabled) {
  if (process.platform === "linux") {
    await setLinuxAutostart(enabled);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: enabled, ...loginItemOptions() });
}

function getScheduleSettings() {
  return {
    runInBackground: getRunInBackground(),
    openAtLogin: isOpenAtLogin(),
    canOpenAtLogin: canOpenAtLogin(),
  };
}

function formatRunTime(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function nextScheduledJob() {
  return scheduledJobs
    .filter((entry) => entry.schedule.nextRunAt)
    .sort((left, right) => left.schedule.nextRunAt - right.schedule.nextRunAt)[0] || null;
}

function showWindow() {
  windowRevealed = true;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  ensureWindowOnScreen(mainWindow);
  mainWindow.show();
  mainWindow.focus();
  updateTray();
}

function showNotification(title, body) {
  if (!Notification.isSupported()) {
    return;
  }
  const notification = new Notification({ title, body, icon: resolveAppIconPath() });
  notification.on("click", showWindow);
  notification.show();
}

function notifyInBackground(title, body) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused()) {
    return;
  }
  showNotification(title, body);
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.hide();
  windowRevealed = false;
  updateTray();
  if (!getAppSettings().trayHintShown) {
    showNotification(
      "Glasswing is still running",
      "Your scheduled jobs keep running in the background. Right-click the tray icon to quit.",
    );
    void saveAppSettings({ trayHintShown: true });
  }
}

function updateTray() {
  if (!shouldKeepRunning() && windowRevealed) {
    tray?.destroy();
    tray = null;
    return;
  }

  if (!tray) {
    const iconPath = resolveAppIconPath();
    if (!iconPath) {
      return;
    }
    tray = new Tray(iconPath);
    tray.on("click", showWindow);
  }

  const next = nextScheduledJob();
  const nextLabel = next
    ? `Next: ${next.name} (${formatRunTime(next.schedule.nextRunAt)})`
    : "No scheduled jobs";
  tray.setToolTip(`Glasswing\n${nextLabel}`.slice(0, 127));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Glasswing", click: showWindow },
      { label: nextLabel, enabled: false },
      { type: "separator" },
      {
        label: "Quit Glasswing",
        click: () => {
          appQuitting = true;
          app.quit();
        },
      },
    ]),
  );
}

async function refreshSchedules() {
  scheduledJobs = (await readJobHistory()).filter((entry) => entry.schedule?.enabled);
  updateTray();
  send("schedules-changed");
}

async function setJobSchedule(jobId, input) {
  const schedule = scheduler.normalizeSchedule(input);
  const entries = await withJobHistory(async () => {
    const entries = await readJobHistory();
    const entry = entries.find((item) => item.id === jobId);
    if (!entry) {
      throw new Error("Saved job not found.");
    }
    if (schedule) {
      const now = Date.now();
      schedule.anchorAt = now;
      schedule.nextRunAt = scheduler.computeNextRun(schedule, now, now);
      schedule.description = scheduler.describeSchedule(schedule);
    }
    entry.schedule = schedule;
    return writeJobHistory(entries);
  });
  await refreshSchedules();
  return entries;
}

async function checkSchedules() {
  const now = Date.now();
  const due = [];
  const changed = await withJobHistory(async () => {
    const entries = await readJobHistory();
    let dirty = false;
    for (const entry of entries) {
      const schedule = entry.schedule;
      if (!schedule?.enabled || schedule.nextRunAt > now) {
        continue;
      }
      if (schedule.nextRunAt) {
        const missed = now - schedule.nextRunAt > SCHEDULE_GRACE_MS;
        if (!missed || schedule.catchUp) {
          due.push({ id: entry.id, missed });
        }
      }
      schedule.nextRunAt = scheduler.computeNextRun(schedule, now, schedule.anchorAt);
      dirty = true;
    }
    if (dirty) {
      await writeJobHistory(entries);
    }
    return dirty;
  });

  for (const item of due) {
    if (!scheduleQueue.some((queued) => queued.id === item.id)) {
      scheduleQueue.push(item);
    }
  }
  if (changed) {
    await refreshSchedules();
  }
  await runQueuedSchedule();
}

async function runQueuedSchedule() {
  if (activeJob || jobStarting || scheduleQueue.length === 0) {
    return;
  }

  const item = scheduleQueue.shift();
  const entry = (await readJobHistory()).find((candidate) => candidate.id === item.id);
  if (!entry?.schedule?.enabled) {
    await runQueuedSchedule();
    return;
  }

  try {
    await startJob(
      {
        operation: entry.operation,
        source: entry.source,
        destination: entry.destination,
        dryRun: entry.dryRun,
        deleteExcluded: entry.deleteExcluded,
        extraArgs: entry.extraArgs,
      },
      { scheduled: { id: entry.id, name: entry.name } },
    );
    notifyInBackground(
      `Running "${entry.name}"`,
      item.missed ? "Catching up on a scheduled run that was missed." : "Scheduled job started.",
    );
  } catch (error) {
    if (activeJob) {
      scheduleQueue.unshift(item);
      return;
    }
    notifyInBackground(`Couldn't start "${entry.name}"`, error.message);
    await runQueuedSchedule();
  }
}

function onJobSettled(jobState, { success, cancelled, message }) {
  if (jobState.settled) {
    return;
  }
  jobState.settled = true;

  if (jobState.scheduled && !cancelled) {
    const { name } = jobState.scheduled;
    notifyInBackground(
      success ? `"${name}" finished` : `"${name}" failed`,
      success ? "Scheduled job completed successfully." : message || "The job ended with errors.",
    );
  }
  setTimeout(() => void runQueuedSchedule(), 1000);
}

ipcMain.handle("get-active-job", async () =>
  activeJob
    ? {
        id: activeJob.id,
        operation: activeJob.job.operation,
        source: activeJob.job.source,
        destination: activeJob.job.destination,
        scheduled: activeJob.scheduled ? { name: activeJob.scheduled.name } : null,
      }
    : null,
);

ipcMain.handle("set-job-schedule", async (_event, jobId, schedule) => setJobSchedule(jobId, schedule));

ipcMain.handle("preview-job-schedule", async (_event, input) => {
  const schedule = scheduler.normalizeSchedule(input);
  const now = Date.now();
  return {
    nextRunAt: scheduler.computeNextRun(schedule, now, now),
    description: scheduler.describeSchedule(schedule),
  };
});

ipcMain.handle("get-schedule-settings", async () => getScheduleSettings());

ipcMain.handle("set-schedule-settings", async (_event, changes = {}) => {
  if (typeof changes.runInBackground === "boolean") {
    await saveAppSettings({ runInBackground: changes.runInBackground });
  }
  if (typeof changes.openAtLogin === "boolean" && canOpenAtLogin()) {
    await setOpenAtLogin(changes.openAtLogin);
  }
  updateTray();
  return getScheduleSettings();
});

const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
}

app.whenReady().then(() => {
  if (!hasInstanceLock) {
    return;
  }
  Menu.setApplicationMenu(null);
  createWindow();

  void refreshSchedules();
  setTimeout(() => void checkSchedules(), SCHEDULER_FIRST_CHECK_MS);
  setInterval(() => void checkSchedules(), SCHEDULER_TICK_MS);
  powerMonitor.on("resume", () => void checkSchedules());

  screen.on("display-metrics-changed", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    cacheContentChrome(mainWindow);
    const [width, height] = mainWindow.getContentSize();
    fitWindowToContent(mainWindow, { width, height }, false);
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopActiveJob();
  stopPreviewServe();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  appQuitting = true;
  stopActiveJob();
  stopRemoteSearch();
  stopPreviewServe();
  stopPreviewFetch();
  stopActiveUpload();
  stopActiveDownload();

  if (mounts.hasMounts() || mountsStopping) {
    event.preventDefault();
    if (!mountsStopping) {
      mountsStopping = true;
      void mounts.stopAllMounts().finally(() => {
        mountsStopping = false;
        app.quit();
      });
    }
  }
});
