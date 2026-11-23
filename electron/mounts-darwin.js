const path = require("path");
const linux = require("./mounts-linux");

const FUSE_PATHS = [
  "/Library/Filesystems/macfuse.fs",
  "/Library/Filesystems/osxfuse.fs",
  "/Library/Filesystems/fuse-t.fs",
  "/usr/local/lib/libfuse-t.dylib",
];

const NO_SUPPORT_MESSAGE =
  "Mounting on a Mac needs an rclone build that includes nfsmount, or macFUSE (macfuse.github.io) with a build that supports mount. " +
  "The Homebrew build can't mount, so install the official rclone from rclone.org/downloads instead.";

function defaultMountRoot(homeDir) {
  return path.posix.join(homeDir, "Glasswing Mounts");
}

function defaultMountPoint(homeDir, remote) {
  const safeName = String(remote || "").replace(/[\/\0:]/g, "_");
  return path.posix.join(defaultMountRoot(homeDir), safeName);
}

function hasFuse(exists) {
  return FUSE_PATHS.some((file) => exists(file));
}

function pickMode({ nfsmount, mount, fuse }) {
  if (nfsmount) {
    return "nfsmount";
  }
  if (mount && fuse) {
    return "mount";
  }
  return "";
}

function parseMountOutput(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    const end = line.lastIndexOf(" (");
    if (end < 0) {
      continue;
    }
    const head = line.slice(0, end);
    const on = head.indexOf(" on ");
    if (on < 0) {
      continue;
    }
    entries.push({
      source: head.slice(0, on),
      mountPoint: head.slice(on + 4),
      options: line.slice(end + 2).replace(/\)\s*$/, ""),
    });
  }
  return entries;
}

function trimSlashes(dir) {
  return linux.trimTrailingSlashes(path.posix.normalize(dir));
}

function isMountedIn(text, dir, aliases = []) {
  const targets = new Set([dir, ...aliases].filter(Boolean).map(trimSlashes));
  return parseMountOutput(text).some((entry) => targets.has(trimSlashes(entry.mountPoint)));
}

function buildMountArgs({ mode, remote, ...options }) {
  const extraFlags = mode === "mount" ? [`--volname=${remote}`] : [];
  return linux.buildMountArgs({ mode, remote, ...options, extraFlags });
}

function unmountCommands(dir) {
  return [
    ["/sbin/umount", [dir]],
    ["/usr/sbin/diskutil", ["unmount", dir]],
    ["/usr/sbin/diskutil", ["unmount", "force", dir]],
  ];
}

function runUnmountChain(dir, exec) {
  return linux.runUnmountChain(dir, exec, unmountCommands(dir));
}

function friendlyMountError(stderr, code) {
  const text = String(stderr || "");
  if (linux.isMissingRemoteError(text)) {
    return linux.MISSING_REMOTE_MESSAGE;
  }
  if (/unknown command|not supported on this|mount is not supported|built without|nfsmount.*not (?:supported|available)/i.test(text)) {
    return NO_SUPPORT_MESSAGE;
  }
  if (/macfuse|osxfuse|fuse-t|libfuse|cannot find fuse|can't find fuse|failed to mount fuse/i.test(text)) {
    return "macFUSE doesn't seem to be set up. Install it from macfuse.github.io, allow its system extension in System Settings and restart your Mac.";
  }
  if (/operation not permitted|permission denied/i.test(text)) {
    return "macOS didn't let rclone mount there. Pick a folder inside your home folder.";
  }
  if (/directory already mounted|not empty|already mounted|resource busy/i.test(text)) {
    return linux.FOLDER_IN_USE_MESSAGE;
  }
  return linux.lastRcloneError(text, code);
}

module.exports = {
  NO_SUPPORT_MESSAGE,
  defaultMountRoot,
  defaultMountPoint,
  hasFuse,
  pickMode,
  parseMountOutput,
  isMountedIn,
  buildMountArgs,
  unmountCommands,
  runUnmountChain,
  friendlyMountError,
};
