const path = require("path");

const FUSE_MISSING_MESSAGE = "Mounting needs FUSE. Install fuse3 (e.g. `sudo apt install fuse3`) and try again.";
const FUSERMOUNT_BINARIES = ["fusermount3", "fusermount"];

function defaultMountRoot(homeDir) {
  return path.posix.join(homeDir, "rclone");
}

function defaultMountPoint(homeDir, remote) {
  const safeName = String(remote || "").replace(/[\/\0]/g, "_");
  return path.posix.join(defaultMountRoot(homeDir), safeName);
}

function normalizeMountPoint(input, homeDir) {
  let value = String(input || "").trim();
  if (value === "~") {
    value = homeDir;
  } else if (value.startsWith("~/")) {
    value = path.posix.join(homeDir, value.slice(2));
  }
  if (!value.startsWith("/")) {
    return "";
  }
  const normalized = path.posix.normalize(value);
  return trimTrailingSlashes(normalized);
}

function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 1 && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(0, end);
}

function detectFuse({ pathEnv, exists }) {
  const dirs = String(pathEnv || "").split(":").filter(Boolean);
  const binary = FUSERMOUNT_BINARIES.find((name) => dirs.some((dir) => exists(path.posix.join(dir, name))));
  const device = exists("/dev/fuse");
  const available = Boolean(binary) && device;
  return { available, binary: binary || "", device, message: available ? "" : FUSE_MISSING_MESSAGE };
}

function unescapeMountinfo(field) {
  return field.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function parseMountinfo(text) {
  const entries = [];
  for (const line of String(text || "").split("\n")) {
    const parts = line.split(" ");
    const separator = parts.indexOf("-");
    if (parts.length < 7 || separator < 6) {
      continue;
    }
    entries.push({
      mountPoint: unescapeMountinfo(parts[4]),
      fsType: parts[separator + 1] || "",
      source: parts[separator + 2] || "",
    });
  }
  return entries;
}

function isMountedIn(text, dir) {
  const target = trimTrailingSlashes(path.posix.normalize(dir));
  return parseMountinfo(text).some((entry) => entry.mountPoint === target);
}

function buildMountArgs({ remote, mountPoint, cacheModeFlag, rc, readOnly, bwlimit }) {
  const flags = [
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
  return ["mount", ...flags, "--", `${remote}:`, mountPoint];
}

function unmountCommands(dir) {
  return [
    ["fusermount3", ["-u", dir]],
    ["fusermount", ["-u", dir]],
    ["umount", [dir]],
  ];
}

function busyMessage(dir) {
  return `Something is still using files in ${dir}. Close it and try again.`;
}

async function runUnmountChain(dir, exec) {
  let busy = false;
  let lastError = "";
  for (const [command, args] of unmountCommands(dir)) {
    const result = await exec(command, args);
    if (result.code === 0) {
      return { ok: true, busy: false, error: "" };
    }
    if (result.notFound) {
      continue;
    }
    const stderr = String(result.stderr || "").trim();
    if (/busy/i.test(stderr)) {
      busy = true;
    }
    lastError = stderr || lastError;
  }
  return { ok: false, busy, error: busy ? busyMessage(dir) : lastError };
}

function friendlyLinuxMountError(stderr, code) {
  const text = String(stderr || "");
  if (/didn't find section in config file|not found in config/i.test(text)) {
    return "This remote no longer exists in your rclone config.";
  }
  if (/fusermount3?: (?:exec: )?.*not found|fusermount.*executable file not found|fuse: .*not found|can't find fuse/i.test(text)) {
    return FUSE_MISSING_MESSAGE;
  }
  if (/\/dev\/fuse/i.test(text) && /permission denied|no such file/i.test(text)) {
    return "Glasswing can't open /dev/fuse. Check that FUSE is installed and your user is allowed to use it.";
  }
  if (/directory already mounted|not empty|already mounted/i.test(text)) {
    return "That folder is already in use. Pick an empty folder.";
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

module.exports = {
  FUSE_MISSING_MESSAGE,
  defaultMountRoot,
  defaultMountPoint,
  normalizeMountPoint,
  detectFuse,
  parseMountinfo,
  isMountedIn,
  buildMountArgs,
  unmountCommands,
  runUnmountChain,
  busyMessage,
  friendlyLinuxMountError,
};
