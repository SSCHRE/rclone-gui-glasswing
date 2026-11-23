const { spawn } = require("child_process");
const fsSync = require("fs");
const fsPromises = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const linux = require("./mounts-linux");
const darwin = require("./mounts-darwin");

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
const DARWIN_SUPPORT_TTL_MS = 15000;
let darwinSupport = null;

function isLinux() {
  return process.platform === "linux";
}

function isDarwin() {
  return process.platform === "darwin";
}

function usesFolders() {
  return isLinux() || isDarwin();
}

function isSupported() {
  return process.platform === "win32" || usesFolders();
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

function runCapture(command, args) {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(command, args, { shell: false });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(stdout));
  });
}

function realParentPath(dir) {
  try {
    return path.join(fsSync.realpathSync(path.dirname(dir)), path.basename(dir));
  } catch {
    return "";
  }
}

function sameFolder(left, right) {
  try {
    const a = fsSync.statSync(left);
    const b = fsSync.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

async function darwinIsMounted(dir) {
  const output = await runCapture("/sbin/mount", []);
  const real = realParentPath(dir);
  const aliases = [real, real && `/System/Volumes/Data${real}`, `/System/Volumes/Data${dir}`];
  if (darwin.isMountedIn(output, dir, aliases)) {
    return true;
  }
  const name = path.basename(dir);
  const parent = path.dirname(dir);
  return darwin
    .parseMountOutput(output)
    .some((entry) => path.basename(entry.mountPoint) === name && sameFolder(path.dirname(entry.mountPoint), parent));
}

async function detectDarwinSupport() {
  if (darwinSupport && Date.now() - darwinSupport.checkedAt < DARWIN_SUPPORT_TTL_MS) {
    return darwinSupport;
  }
  const nfsmount = (await runCommand("rclone", ["nfsmount", "--help"])).code === 0;
  const fuse = darwin.hasFuse((file) => fsSync.existsSync(file));
  const mount = !nfsmount && fuse && (await runCommand("rclone", ["mount", "--help"])).code === 0;
  const mode = darwin.pickMode({ nfsmount, mount, fuse });
  darwinSupport = {
    mode,
    available: Boolean(mode),
    message: mode ? "" : darwin.NO_SUPPORT_MESSAGE,
    checkedAt: Date.now(),
  };
  return darwinSupport;
}

async function folderIsMounted(dir) {
  return isDarwin() ? darwinIsMounted(dir) : linuxIsMounted(dir);
}

async function folderUnmount(dir) {
  if (!(await folderIsMounted(dir))) {
    return;
  }
  const chain = isDarwin() ? darwin.runUnmountChain : linux.runUnmountChain;
  const result = await chain(dir, runCommand);
  if (!result.ok && (await folderIsMounted(dir))) {
    throw new Error(result.error || `Could not unmount ${dir}.`);
  }
}

async function prepareMountFolder(dir) {
  if (await folderIsMounted(dir)) {
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
      const unmountCommand = isDarwin() ? `umount "${dir}"` : `fusermount -u ${dir}`;
      throw new Error(`${dir} is a leftover mount from an earlier session. Unmount it with "${unmountCommand}" and try again.`);
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
  if (isDarwin()) {
    status.platform = "darwin";
    status.mountRoot = darwin.defaultMountRoot(os.homedir());
    status.fuse = darwinSupport
      ? { available: darwinSupport.available, message: darwinSupport.message }
      : { available: true, message: "" };
  }
  return status;
}

async function refreshStatus() {
  if (isDarwin()) {
    await detectDarwinSupport();
  }
  return getStatus();
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
  const onDarwin = isDarwin();
  const folderMode = onLinux || onDarwin;
  let letter = "";
  let mountPoint;
  let darwinMode = "";
  if (onDarwin) {
    const support = await detectDarwinSupport();
    if (!support.available) {
      throw new Error(support.message);
    }
    darwinMode = support.mode;
    mountPoint = linux.normalizeMountPoint(requestedMountPoint || darwin.defaultMountPoint(os.homedir(), remote), os.homedir());
    if (!mountPoint || mountPoint === "/") {
      throw new Error("Pick a folder to mount into.");
    }
  } else if (onLinux) {
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
  if (folderMode) {
    for (const other of mounts.values()) {
      if (other.mountPoint === mountPoint) {
        throw new Error(`${mountPoint} is already used by "${other.remote}". Pick another folder.`);
      }
    }
    await prepareMountFolder(mountPoint);
  }

  const rc = { port: await getFreePort(), user: "glasswing", pass: randomUUID() };
  let args;
  if (onDarwin) {
    args = darwin.buildMountArgs({ mode: darwinMode, remote, mountPoint, cacheModeFlag, rc, readOnly, bwlimit });
  } else if (onLinux) {
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
  const describeError = onDarwin ? darwin.friendlyMountError : onLinux ? linux.friendlyLinuxMountError : friendlyMountError;
  const isReady = folderMode ? () => folderIsMounted(mountPoint) : () => driveExists(letter);
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

    let checking = false;
    const poll = setInterval(() => {
      if (checking) {
        return;
      }
      checking = true;
      Promise.resolve(isReady())
        .then((ready) => {
          if (ready) {
            finish(() => {
              mount.ready = true;
              mount.stderr = "";
              resolve(describeMount(mount));
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          checking = false;
        });
    }, MOUNT_READY_POLL_MS);

    const timer = setTimeout(() => {
      finish(() => {
        mounts.delete(remote);
        child.kill();
        reject(new Error(`Timed out waiting for ${mountPoint} to appear. ${mount.stderr.trim() ? describeError(mount.stderr) : "rclone was running, but the folder never showed up as mounted."}`));
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
        if (folderMode && !mount.stopping) {
          folderUnmount(mountPoint).catch(() => {});
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
      await folderUnmount(stale);
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
  if (usesFolders()) {
    staleLinuxMounts.set(remote, mount.mountPoint);
    await folderUnmount(mount.mountPoint);
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
  refreshStatus,
  listMounts,
  startMount,
  stopMount,
  stopAllMounts,
  setBwlimit,
  getTotalPendingUploads,
  hasMounts,
};
