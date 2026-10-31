const fs = require("fs");
const path = require("path");

const BINARY_NAME = process.platform === "win32" ? "rclone.exe" : "rclone";

let resolved = null;

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function findRclone() {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    const candidate = dir && path.isAbsolute(dir) ? path.join(dir, BINARY_NAME) : null;
    if (candidate && isFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function rcloneBinary() {
  if (!resolved || !isFile(resolved)) {
    resolved = findRclone();
  }
  return resolved || BINARY_NAME;
}

module.exports = { rcloneBinary };
