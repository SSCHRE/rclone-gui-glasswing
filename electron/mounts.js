const { spawn } = require("child_process");
const fsSync = require("fs");
const fsPromises = require("fs/promises");
const net = require("net");
const os = require("os");
const { randomUUID } = require("crypto");
const linux = require("./mounts-linux");

const CACHE_MODE_FLAGS = Object.freeze({
  off: "--vfs-cache-mode=off",
  minimal: "--vfs-cache-mode=minimal",
  writes: "--vfs-cache-mode=writes",
  full: "--vfs-cache-mode=full",
});
const MOUNT_READY_TIMEOUT_MS = 30000;
const MOUNT_READY_POLL_MS = 250;
const RC_REQUEST_TIMEOUT_MS = 3000;
const QUIT_TIMEOUT_MS = 8000;
const STDERR_TAIL_BYTES = 4096;

const mounts = new Map();
const staleLinuxMounts = new Map();

function isLinux() {
  return process.platform === "linux";
}

function isSupported() {
  return process.platform === "win32" || isLinux();
}

function readMountinfo() {
  try {
    return fsSync.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return "";
  }
}

function linuxIsMounted(dir) {
  return linux.isMountedIn(readMountinfo(), dir);
}

function linuxFuseStatus() {
  return linux.detectFuse({ pathEnv: process.env.PATH, exists: (file) => fsSync.existsSync(file) });
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(command, args, { shell: false });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: null, stderr: "", notFound: error.code === "ENOENT" }));
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

async function linuxUnmount(dir) {
  if (!linuxIsMounted(dir)) {
    return;
  }
  const result = await linux.runUnmountChain(dir, runCommand);
  if (!result.ok && linuxIsMounted(dir)) {
    throw new Error(result.error || `Could not unmount ${dir}.`);
  }
}

async function prepareLinuxMountPoint(dir) {
  if (linuxIsMounted(dir)) {
    throw new Error(`${dir} already has something mounted on it. Pick another folder.`);
  }
  let entries;
  try {
    entries = await fsPromises.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") {
      await fsPromises.mkdir(dir, { recursive: true });
      return;
    }
    if (error.code === "ENOTDIR") {
      throw new Error(`${dir} is a file, not a folder. Pick a folder.`);
    }
    if (error.code === "ENOTCONN") {
      throw new Error(`${dir} is a leftover mount from an earlier session. Unmount it with "fusermount -u ${dir}" and try again.`);
    }
    throw new Error(`Can't use ${dir}: ${error.message}`);
  }
  if (entries.length > 0) {
    throw new Error(`${dir} isn't empty. Pick an empty folder (or a new one) to mount into.`);
  }
}

function driveExists(letter) {
  try {
    return fsSync.existsSync(`${letter}:\\`);
  } catch {
    return false;
  }
}

function listFreeDriveLetters() {
  if (process.platform !== "win32") {
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
  const status = {
    supported: isSupported(),
    freeDriveLetters: listFreeDriveLetters(),
    mounts: listMounts(),
  };
  if (isLinux()) {
    status.platform = "linux";
    status.mountRoot = linux.defaultMountRoot(os.homedir());
    status.fuse = linuxFuseStatus();
  }
  return status;
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

async function startMount({ remote, driveLetter, mountPoint: requestedMountPoint, cacheMode = "writes", readOnly = false, bwlimit = "" }, { onExit } = {}) {
  if (!isSupported()) {
    throw new Error("Mounting isn't supported on this system.");
  }

  const onLinux = isLinux();
  let letter = "";
  let mountPoint;
  if (onLinux) {
    const fuse = linuxFuseStatus();
    if (!fuse.available) {
      throw new Error(fuse.message);
    }
    mountPoint = linux.normalizeMountPoint(requestedMountPoint || linux.defaultMountPoint(os.homedir(), remote), os.homedir());
    if (!mountPoint || mountPoint === "/") {
      throw new Error("Pick a folder to mount into.");
    }
  } else {
    letter = String(driveLetter || "").toUpperCase();
    if (!/^[D-Z]$/.test(letter)) {
      throw new Error("Pick a drive letter between D and Z.");
    }
    if (driveExists(letter)) {
      throw new Error(`Drive ${letter}: is already in use. Pick another one.`);
    }
    mountPoint = `${letter}:`;
  }
  if (mounts.has(remote)) {
    throw new Error(`"${remote}" is already mounted.`);
  }
  if (!Object.hasOwn(CACHE_MODE_FLAGS, cacheMode)) {
    throw new Error(`Unknown cache mode "${cacheMode}".`);
  }
  const cacheModeFlag = CACHE_MODE_FLAGS[cacheMode];
  if (onLinux) {
    for (const other of mounts.values()) {
      if (other.mountPoint === mountPoint) {
        throw new Error(`${mountPoint} is already used by "${other.remote}". Pick another folder.`);
      }
    }
    await prepareLinuxMountPoint(mountPoint);
  }

  const rc = { port: await getFreePort(), user: "glasswing", pass: randomUUID() };
  let args;
  if (onLinux) {
    args = linux.buildMountArgs({ remote, mountPoint, cacheModeFlag, rc, readOnly, bwlimit });
  } else {
    const flags = [
      `--volname=${remote}`,
      cacheModeFlag,
      "--rc",
      "--rc-addr",
      `127.0.0.1:${rc.port}`,
      "--rc-user",
      rc.user,
      "--rc-pass",
      rc.pass,
    ];
    if (readOnly) {
      flags.push("--read-only");
    }
    if (bwlimit) {
      flags.push(`--bwlimit=${bwlimit}`);
    }
    args = ["mount", ...flags, "--", `${remote}:`, mountPoint];
  }
  const describeError = onLinux ? linux.friendlyLinuxMountError : friendlyMountError;
  const isReady = onLinux ? () => linuxIsMounted(mountPoint) : () => driveExists(letter);
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
      if (isReady()) {
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
        reject(new Error(`Timed out waiting for ${mountPoint} to appear. ${describeError(mount.stderr)}`));
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

      finish(() => reject(new Error(describeError(mount.stderr, code))));

      if (wasReady) {
        if (onLinux && !mount.stopping) {
          linuxUnmount(mountPoint).catch(() => {});
        }
        onExit?.({
          remote,
          mountPoint,
          unexpected: !mount.stopping,
          message: mount.stopping ? "" : describeError(mount.stderr, code),
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
    const stale = staleLinuxMounts.get(remote);
    if (stale) {
      await linuxUnmount(stale);
      staleLinuxMounts.delete(remote);
    }
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
  if (isLinux()) {
    staleLinuxMounts.set(remote, mount.mountPoint);
    await linuxUnmount(mount.mountPoint);
    staleLinuxMounts.delete(remote);
  }
  return { stopped: true, pending: 0 };
}

async function setBwlimit(rate) {
  const results = await Promise.all(
    [...mounts.values()].filter((mount) => mount.ready).map((mount) =>
      rcCall(mount, "core/bwlimit", { rate }).then(() => true, () => false),
    ),
  );
  return results.filter(Boolean).length;
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
  setBwlimit,
  getTotalPendingUploads,
  hasMounts,
};
