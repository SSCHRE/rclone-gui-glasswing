const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

let mainWindow = null;
let activeJob = null;

const WINDOW_MIN_WIDTH = 980;
const WINDOW_MIN_HEIGHT = 800;

function applyMinimumContentSize(window, { width, height }) {
  const minWidth = Math.max(WINDOW_MIN_WIDTH, Math.ceil(width));
  const minHeight = Math.max(WINDOW_MIN_HEIGHT, Math.ceil(height) + 12);
  window.setMinimumSize(minWidth, minHeight);

  const [currentWidth, currentHeight] = window.getContentSize();
  if (currentWidth < minWidth || currentHeight < minHeight) {
    window.setContentSize(Math.max(currentWidth, minWidth), Math.max(currentHeight, minHeight));
  }

  return { minWidth, minHeight };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 980,
    minWidth: WINDOW_MIN_WIDTH,
    minHeight: WINDOW_MIN_HEIGHT,
    useContentSize: true,
    center: true,
    title: `Rclone GUI v${app.getVersion()}`,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
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

ipcMain.handle("set-minimum-content-size", async (_event, size) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  return applyMinimumContentSize(mainWindow, size);
});

ipcMain.handle("probe-minimum-content-size", async (_event, size) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }

  const { minWidth, minHeight } = applyMinimumContentSize(mainWindow, size);
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

  const [minWidth, minHeight] = mainWindow.getMinimumSize();
  mainWindow.setContentSize(Math.max(width, minWidth), Math.max(height, minHeight));
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

  const child = spawn("rclone", args, {
    windowsHide: true,
    shell: false,
  });

  const jobState = {
    id: Date.now(),
    process: child,
    killed: false,
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

  child.on("error", (error) => {
    send("job-finished", {
      id: jobState.id,
      code: -1,
      success: false,
      message: error.message,
      cancelled: false,
    });
    activeJob = null;
  });

  child.on("close", (code) => {
    const cancelled = jobState.killed;
    send("job-finished", {
      id: jobState.id,
      code,
      success: code === 0 && !cancelled,
      message: cancelled ? "Job cancelled." : code === 0 ? "Job completed successfully." : "Job failed.",
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

app.whenReady().then(() => {
  createWindow();

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
