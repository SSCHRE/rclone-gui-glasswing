const { spawn } = require("child_process");
const fsSync = require("fs");
const net = require("net");
const { randomUUID } = require("crypto");

const CACHE_MODES = new Set(["off", "minimal", "writes", "full"]);
const MOUNT_READY_TIMEOUT_MS = 30000;
const MOUNT_READY_POLL_MS = 250;
const RC_REQUEST_TIMEOUT_MS = 3000;
const QUIT_TIMEOUT_MS = 8000;
const STDERR_TAIL_BYTES = 4096;

const mounts = new Map();

function isSupported() {
  return process.platform === "win32";
}

function driveExists(letter) {
  try {
    return fsSync.existsSync(`${letter}:\\`);
  } catch {
    return false;
  }
}

function listFreeDriveLetters() {
  if (!isSupported()) {
    return [];
  }

  const letters = [];
  for (let code = "D".charCodeAt(0); code <= "Z".charCodeAt(0); code++) {
    const letter = String.fromCharCode(code);
    if (!driveExists(letter)) {
      letters.push(letter);
    }
  }
  return letters.reverse();
}

function describeMount(mount) {
  return {
    remote: mount.remote,
    mountPoint: mount.mountPoint,
    cacheMode: mount.cacheMode,
    readOnly: mount.readOnly,
    startedAt: mount.startedAt,
  };
}

function listMounts() {
  return [...mounts.values()].filter((mount) => mount.ready).map(describeMount);
}

function getStatus() {
  return {
    supported: isSupported(),
    freeDriveLetters: listFreeDriveLetters(),
    mounts: listMounts(),
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function rcCall(mount, command, params = {}) {
  const auth = Buffer.from(`${mount.rc.user}:${mount.rc.pass}`).toString("base64");
  const response = await fetch(`http://127.0.0.1:${mount.rc.port}/${command}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(RC_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`rclone rc ${command} returned ${response.status}`);
  }

  return response.json();
}

function friendlyMountError(stderr, code) {
  const text = String(stderr || "");
  if (/didn't find section in config file|not found in config/i.test(text)) {
    return "This remote no longer exists in your rclone config.";
  }
  if (/mountpoint .* already exists|already in use|cannot create|drive.*in use/i.test(text)) {
    return "That drive letter is already in use. Pick another one.";
  }

  const lastError = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /ERROR|CRITICAL|Fatal/i.test(line))
    .pop();
  if (lastError) {
    return lastError.replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+/, "");
  }
  return `rclone mount exited with code ${code ?? "unknown"}.`;
}

async function startMount({ remote, driveLetter, cacheMode = "writes", readOnly = false }, { onExit } = {}) {
  if (!isSupported()) {
    throw new Error("Mounting is only supported on Windows for now.");
  }

  const letter = String(driveLetter || "").toUpperCase();
  if (!/^[D-Z]$/.test(letter)) {
    throw new Error("Pick a drive letter between D and Z.");
  }
  if (driveExists(letter)) {
    throw new Error(`Drive ${letter}: is already in use. Pick another one.`);
  }
  if (mounts.has(remote)) {
    throw new Error(`"${remote}" is already mounted.`);
  }
  if (!CACHE_MODES.has(cacheMode)) {
    throw new Error(`Unknown cache mode "${cacheMode}".`);
  }

  const mountPoint = `${letter}:`;
  const rc = { port: await getFreePort(), user: "glasswing", pass: randomUUID() };
  const args = [
    "mount",
    `${remote}:`,
    mountPoint,
    "--volname",
    remote,
    "--vfs-cache-mode",
    cacheMode,
    "--rc",
    "--rc-addr",
    `127.0.0.1:${rc.port}`,
    "--rc-user",
    rc.user,
    "--rc-pass",
    rc.pass,
  ];
  if (readOnly) {
    args.push("--read-only");
  }

  const child = spawn("rclone", args, {
    windowsHide: true,
    shell: false,
    env: process.env,
  });

  const mount = {
    remote,
    mountPoint,
    cacheMode,
    readOnly: Boolean(readOnly),
    startedAt: Date.now(),
    child,
    rc,
    ready: false,
    stopping: false,
    stderr: "",
  };
  mounts.set(remote, mount);

  const appendOutput = (chunk) => {
    mount.stderr = (mount.stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", appendOutput);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (handler) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      handler();
    };

    const poll = setInterval(() => {
      if (driveExists(letter)) {
        finish(() => {
          mount.ready = true;
          mount.stderr = "";
          resolve(describeMount(mount));
        });
      }
    }, MOUNT_READY_POLL_MS);

    const timer = setTimeout(() => {
      finish(() => {
        mounts.delete(remote);
        child.kill();
        reject(new Error(`Timed out waiting for ${mountPoint} to appear. ${friendlyMountError(mount.stderr)}`));
      });
    }, MOUNT_READY_TIMEOUT_MS);

    child.on("error", (error) => {
      finish(() => {
        mounts.delete(remote);
        reject(error.code === "ENOENT" ? new Error("rclone was not found on your PATH.") : error);
      });
    });

    child.on("close", (code) => {
      const wasReady = mount.ready;
      if (mounts.get(remote) === mount) {
        mounts.delete(remote);
      }

      finish(() => reject(new Error(friendlyMountError(mount.stderr, code))));

      if (wasReady) {
        onExit?.({
          remote,
          mountPoint,
          unexpected: !mount.stopping,
          message: mount.stopping ? "" : friendlyMountError(mount.stderr, code),
        });
      }
    });
  });
}

async function getPendingUploads(remote) {
  const mount = mounts.get(remote);
  if (!mount || mount.cacheMode === "off") {
    return 0;
  }

  try {
    const stats = await rcCall(mount, "vfs/stats");
    return (stats?.diskCache?.uploadsInProgress || 0) + (stats?.diskCache?.uploadsQueued || 0);
  } catch {
    return 0;
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopMount(remote, { force = false } = {}) {
  const mount = mounts.get(remote);
  if (!mount) {
    return { stopped: true, pending: 0 };
  }

  if (!force) {
    const pending = await getPendingUploads(remote);
    if (pending > 0) {
      return { stopped: false, pending };
    }
  }

  mount.stopping = true;
  try {
    await rcCall(mount, "core/quit");
  } catch {}

  if (!(await waitForExit(mount.child, QUIT_TIMEOUT_MS))) {
    mount.child.kill();
    await waitForExit(mount.child, 2000);
  }

  mounts.delete(remote);
  return { stopped: true, pending: 0 };
}

async function getTotalPendingUploads() {
  const counts = await Promise.all([...mounts.keys()].map((remote) => getPendingUploads(remote)));
  return counts.reduce((sum, count) => sum + count, 0);
}

async function stopAllMounts() {
  await Promise.all([...mounts.keys()].map((remote) => stopMount(remote, { force: true })));
}

function hasMounts() {
  return mounts.size > 0;
}

module.exports = {
  getStatus,
  listMounts,
  startMount,
  stopMount,
  stopAllMounts,
  getTotalPendingUploads,
  hasMounts,
};
