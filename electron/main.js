const { app, BrowserWindow, ipcMain, dialog, Menu, screen, nativeImage } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

if (process.platform === "win32") {
  app.setAppUserModelId("com.rclone.gui.glasswing");
}

let mainWindow = null;
let activeJob = null;

const WINDOW_ABSOLUTE_MIN_WIDTH = 760;
const WINDOW_ABSOLUTE_MIN_HEIGHT = 520;
const WINDOW_PREFERRED_WIDTH_RATIO = 0.78;
const WINDOW_PREFERRED_HEIGHT_RATIO = 0.9;
const SCREEN_MARGIN = 20;

let contentChrome = { width: 16, height: 39 };

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, "icons", "icon.ico"),
    path.join(__dirname, "icons", "icon.png"),
    path.join(__dirname, "..", "build", "icon.ico"),
    path.join(__dirname, "..", "build", "icon.png"),
    path.join(process.resourcesPath, "icon.ico"),
    path.join(process.resourcesPath, "icon.png"),
  ];

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

async function writeJobHistory(entries) {
  const filePath = getHistoryFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const trimmed = sortJobHistory(entries.filter((entry) => entry.saved)).slice(0, MAX_JOB_HISTORY);
  await fs.writeFile(filePath, JSON.stringify(trimmed, null, 2), "utf8");
  return trimmed;
}

async function upsertJobHistory(job, { name = null } = {}) {
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
  };

  if (existingIndex >= 0) {
    entries.splice(existingIndex, 1);
  }

  entries.unshift(entry);
  return writeJobHistory(entries);
}

async function updateSavedJob(jobId, job) {
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

async function markJobRunStarted(job) {
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

async function markJobRunFinished(historyId, { success, cancelled }) {
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
    icon,
    title: `Rclone GUI v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    ensureWindowOnScreen(mainWindow);
    mainWindow.show();
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  cacheContentChrome(mainWindow);

  if (icon) {
    mainWindow.setIcon(icon);
  }
}

function runRclone(args, { interactive = false, timeoutMs = 0, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, {
      windowsHide: !interactive,
      shell: false,
      env: process.env,
    });

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

async function fetchRemoteByteRange(source, offset, count) {
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
    { timeoutMs: 120000, binary: true },
  );

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout?.toString?.() || `Failed to read bytes from "${source}"`);
  }

  return result.stdout;
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
  if (!mainWindow || mainWindow.isDestroyed()) {
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

ipcMain.handle("open-rclone-config", async () => {
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

ipcMain.handle("download-remote-file", async (_event, payload) => {
  if (activeJob) {
    throw new Error("Wait for the current job to finish before downloading.");
  }

  const remotePath = payload?.remotePath;
  const localPath = payload?.localPath;
  if (!localPath?.trim()) {
    throw new Error("A local save path is required.");
  }

  const source = normalizeRemoteBrowsePath(remotePath);
  const result = await runRclone(["copyto", source, localPath.trim()], {
    timeoutMs: 0,
  });

  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Failed to download "${source}"`);
  }

  return { source, localPath: localPath.trim() };
});

const PREVIEW_KINDS = {
  ".txt": { kind: "text", mime: "text/plain", maxBytes: 2 * 1024 * 1024, mode: "buffer" },
  ".pdf": { kind: "pdf", mime: "application/pdf", maxBytes: 40 * 1024 * 1024, mode: "buffer" },
  ".mp3": { kind: "audio", mime: "audio/mpeg", mode: "stream" },
  ".mp4": { kind: "video", mime: "video/mp4", mode: "stream" },
  ".zip": { kind: "zip", mime: "application/zip", mode: "zip" },
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

async function listZipEntriesFromRemote(source, archiveSize) {
  if (!Number.isFinite(archiveSize) || archiveSize < 22) {
    throw new Error("Not a valid zip archive.");
  }

  // Only fetch the end of the archive (EOCD + usually the central directory).
  const tailSize = Math.min(archiveSize, 65557);
  const tailOffset = archiveSize - tailSize;
  const tail = await fetchRemoteByteRange(source, tailOffset, tailSize);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) {
      eocd = i;
      break;
    }
  }
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
      zip64Header = await fetchRemoteByteRange(source, zip64EocdOffset, 56);
    }

    if (zip64Header.readUInt32LE(0) !== ZIP_ZIP64_EOCD_SIG) {
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

  let central;
  if (cdSize === 0) {
    central = Buffer.alloc(0);
  } else if (cdOffset >= tailOffset && cdOffset + cdSize <= archiveSize) {
    const local = cdOffset - tailOffset;
    central = Buffer.from(tail.subarray(local, local + cdSize));
  } else {
    // Directory starts earlier than the EOCD tail window — fetch only that slice.
    central = await fetchRemoteByteRange(source, cdOffset, cdSize);
  }

  return parseZipCentralDirectory(central, totalEntries);
}

let previewServe = null;

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
    throw new Error("Preview supports .txt, .pdf, .mp3, .mp4, .zip, .jpg, .jpeg, and .png files only.");
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

  if (meta.mode === "zip") {
    stopPreviewServe();
    const { fileName } = splitRemoteParentAndFile(source);
    if (!fileName) {
      throw new Error("Invalid zip path for preview.");
    }

    const hintedSize = Number(options?.size);
    const archiveSize =
      Number.isFinite(hintedSize) && hintedSize >= 0 ? hintedSize : await getRemoteObjectSize(source);
    const listed = await listZipEntriesFromRemote(source, archiveSize);
    return {
      kind: "zip",
      name: fileName,
      entries: listed.entries,
      totalEntries: listed.totalEntries,
      truncated: listed.truncated,
      archiveBytes: archiveSize,
    };
  }

  stopPreviewServe();

  const tmpDir = path.join(app.getPath("temp"), "glasswing-preview", randomUUID());
  const localPath = path.join(tmpDir, sanitizePreviewFileName(source, path.extname(source)));

  try {
    await fs.mkdir(tmpDir, { recursive: true });
    const result = await runRclone(["copyto", source, localPath], { timeoutMs: 0 });
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
});

ipcMain.handle("start-job", async (_event, job) => {
  if (activeJob) {
    throw new Error("A job is already running.");
  }

  const operation = job.operation;
  if (!["sync", "copy", "move"].includes(operation)) {
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

  if (job.deleteExcluded) {
    args.push("--delete-excluded");
  }

  args.push(...parseExtraArgs(job.extraArgs));

  const child = spawn("rclone", args, {
    windowsHide: true,
    shell: false,
  });

  const jobState = {
    id: Date.now(),
    process: child,
    killed: false,
    historyId: await markJobRunStarted({
      operation,
      source: job.source,
      destination: job.destination,
      dryRun: job.dryRun,
      deleteExcluded: job.deleteExcluded,
      extraArgs: job.extraArgs,
    }),
  };

  activeJob = jobState;

  send("job-started", {
    id: jobState.id,
    operation,
    source: job.source,
    destination: job.destination,
  });

  const forwardOutput = (stream, type) => {
    stream.on("data", (chunk) => {
      const text = chunk.toString();
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
  });

  child.on("close", async (code) => {
    const cancelled = jobState.killed;
    await markJobRunFinished(jobState.historyId, {
      success: code === 0 && !cancelled,
      cancelled,
    });
    send("job-finished", {
      id: jobState.id,
      code,
      success: code === 0 && !cancelled,
      message: cancelled ? "" : code === 0 ? "Job completed successfully." : "Job failed.",
      cancelled,
    });

    if (activeJob && activeJob.id === jobState.id) {
      activeJob = null;
    }
  });

  return { id: jobState.id };
});

ipcMain.handle("stop-job", async () => {
  const stopped = stopActiveJob();
  return { stopped };
});

ipcMain.handle("list-jobs", async () => readJobHistory());

ipcMain.handle("save-job", async (_event, job) => {
  if (!job?.source?.trim() || !job?.destination?.trim()) {
    throw new Error("Source and destination are required.");
  }

  if (!["sync", "copy", "move"].includes(job.operation)) {
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

  if (!["sync", "copy", "move"].includes(job.operation)) {
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
  const entries = await readJobHistory();
  const next = entries.filter((entry) => entry.id !== jobId);
  return writeJobHistory(next);
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();

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

app.on("before-quit", () => {
  stopActiveJob();
  stopPreviewServe();
});
