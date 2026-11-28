const fs = require("fs/promises");
const path = require("path");
const { createHash } = require("crypto");

const CACHE_FOLDER = "glasswing-open";
const META_NAME = ".glasswing-open.json";
const ENTRY_PATTERN = /^[0-9a-f]{12}$/;
const MAX_NAME_LENGTH = 160;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

const BLOCKED_EXTENSIONS = {
  win32: [".exe", ".msi", ".bat", ".cmd", ".com", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf", ".wsh", ".scr", ".lnk", ".reg", ".hta", ".cpl", ".pif", ".msc", ".msp", ".url", ".inf", ".application", ".appref-ms", ".jar"],
  darwin: [".app", ".command", ".pkg", ".sh", ".terminal", ".workflow", ".jar"],
  linux: [".sh", ".run", ".appimage", ".desktop", ".jar"],
};

function blockedExtensions(platform) {
  return new Set(BLOCKED_EXTENSIONS[platform] || [...BLOCKED_EXTENSIONS.linux, ".jar"]);
}

function fileExtension(name) {
  const trimmed = String(name || "").replace(/[. ]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  return dot > 0 ? trimmed.slice(dot).toLowerCase() : "";
}

function isBlockedFile(name, platform = process.platform) {
  const extension = fileExtension(name);
  return Boolean(extension) && blockedExtensions(platform).has(extension);
}

function safeFileName(name) {
  let cleaned = String(name || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/[. ]+$/, "")
    .replace(/^\.+$/, "_");
  if (!cleaned || cleaned === META_NAME || RESERVED_WINDOWS_NAME.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }
  if (cleaned.length > MAX_NAME_LENGTH) {
    const extension = fileExtension(cleaned);
    cleaned = cleaned.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
  }
  return cleaned;
}

function remoteFileName(remotePath) {
  const text = String(remotePath || "");
  const afterRemote = text.slice(text.indexOf(":") + 1);
  return afterRemote.split("/").filter(Boolean).pop() || "";
}

function entryHash(remotePath) {
  return createHash("sha1").update(String(remotePath)).digest("hex").slice(0, 12);
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function buildCachePaths(cacheRoot, remotePath) {
  const name = safeFileName(remoteFileName(remotePath));
  const dir = path.join(cacheRoot, entryHash(remotePath));
  const filePath = path.join(dir, name);
  if (!isInside(cacheRoot, filePath) || path.dirname(filePath) !== dir) {
    throw new Error("That file name can't be opened.");
  }
  return { name, dir, filePath, metaPath: path.join(dir, META_NAME) };
}

function normalizeModTime(value) {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? String(value ?? "") : String(parsed);
}

async function readMeta(metaPath) {
  try {
    return JSON.parse(await fs.readFile(metaPath, "utf8"));
  } catch {
    return null;
  }
}

async function findReusable(paths, remotePath, size, modTime) {
  const meta = await readMeta(paths.metaPath);
  if (!meta || meta.remotePath !== remotePath) {
    return false;
  }
  if (Number(meta.size) !== Number(size) || meta.modTime !== normalizeModTime(modTime)) {
    return false;
  }
  try {
    const stat = await fs.stat(paths.filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function writeMeta(paths, remotePath, size, modTime) {
  await fs.mkdir(paths.dir, { recursive: true });
  const meta = { remotePath, size: Number(size) || 0, modTime: normalizeModTime(modTime), usedAt: Date.now() };
  await fs.writeFile(paths.metaPath, JSON.stringify(meta));
}

async function newestTime(dir) {
  let newest = (await fs.stat(dir)).mtimeMs;
  for (const name of await fs.readdir(dir)) {
    try {
      newest = Math.max(newest, (await fs.lstat(path.join(dir, name))).mtimeMs);
    } catch {}
  }
  return newest;
}

async function cleanupCache(cacheRoot, maxAgeMs, now = Date.now()) {
  if (path.basename(cacheRoot) !== CACHE_FOLDER) {
    return 0;
  }
  let names;
  try {
    names = await fs.readdir(cacheRoot);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ENTRY_PATTERN.test(name)) {
      continue;
    }
    const dir = path.join(cacheRoot, name);
    if (!isInside(cacheRoot, dir)) {
      continue;
    }
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        continue;
      }
      const meta = await readMeta(path.join(dir, META_NAME));
      const lastUsed = Math.max(await newestTime(dir), Number(meta?.usedAt) || 0);
      if (now - lastUsed > maxAgeMs) {
        await fs.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {}
  }
  return removed;
}

module.exports = {
  CACHE_FOLDER,
  isBlockedFile,
  safeFileName,
  remoteFileName,
  entryHash,
  isInside,
  buildCachePaths,
  findReusable,
  writeMeta,
  cleanupCache,
  normalizeModTime,
};
