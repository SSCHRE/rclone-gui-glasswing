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

  mainWindow = new BrowserWindow({
    width: initialSize.width,
    height: initialSize.height,
    minWidth: WINDOW_ABSOLUTE_MIN_WIDTH,
    minHeight: WINDOW_ABSOLUTE_MIN_HEIGHT,
    useContentSize: true,
    center: true,
    show: false,
    icon: resolveAppIcon(),
    title: `Rclone GUI v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
  cacheContentChrome(mainWindow);

  const icon = resolveAppIcon();
  if (icon) {
    mainWindow.setIcon(icon);
  }
}

function runRclone(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("rclone", args, {
      windowsHide: true,
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
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
  const result = await runRclone(["version"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to run rclone version");
  }

  const firstLine = result.stdout.split("\n")[0].trim();
  return firstLine || "rclone (unknown version)";
});

ipcMain.handle("list-remotes", async () => {
  const result = await runRclone(["listremotes"]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to list remotes");
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/:$/, ""));
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
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopActiveJob();
});
