const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { createHash, randomUUID } = require("crypto");
const { spawn } = require("child_process");

const UPDATE_FILE_NAME = "Glasswing.update.exe";
const MAX_REDIRECTS = 6;
const REQUEST_TIMEOUT_MS = 30000;

function pickPortableAsset(release, version) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  const wanted = String(version || "").replace(/^v/, "");
  const candidates = assets.filter((asset) => {
    const name = String((asset && asset.name) || "");
    return /\.exe$/i.test(name)
      && !/setup|install/i.test(name)
      && !/\.blockmap$/i.test(name)
      && (!wanted || name.includes(wanted));
  });
  const preferred = candidates.find((asset) => /portable/i.test(asset.name));
  return preferred || candidates[0] || null;
}

function parseDigest(digest) {
  const match = /^sha256:([0-9a-f]{64})$/i.exec(String(digest || "").trim());
  return match ? match[1].toLowerCase() : null;
}

function cmdEscape(value) {
  return String(value).replace(/%/g, "%%");
}

function buildSwapScript({ pid, target, update, backup }) {
  const processId = Number.parseInt(pid, 10);
  if (!Number.isInteger(processId) || processId <= 0) {
    throw new Error("Bad process id for the update script.");
  }
  const t = cmdEscape(target);
  const u = cmdEscape(update);
  const b = cmdEscape(backup);
  return [
    "@echo off",
    "setlocal",
    "set /a waited=0",
    ":waitpid",
    `tasklist /FI "PID eq ${processId}" /NH 2>NUL | find "${processId}" >NUL`,
    "if errorlevel 1 goto swap",
    "set /a waited+=1",
    "if %waited% geq 60 goto giveup",
    "ping -n 2 127.0.0.1 >NUL",
    "goto waitpid",
    ":swap",
    "set /a tries=0",
    ":retry",
    `if exist "${b}" del /f /q "${b}" >NUL 2>&1`,
    `move /y "${t}" "${b}" >NUL 2>&1`,
    "if not errorlevel 1 goto place",
    "set /a tries+=1",
    "if %tries% geq 30 goto giveup",
    "ping -n 2 127.0.0.1 >NUL",
    "goto retry",
    ":place",
    `move /y "${u}" "${t}" >NUL 2>&1`,
    "if errorlevel 1 goto restore",
    `start "" "${t}"`,
    "ping -n 4 127.0.0.1 >NUL",
    `del /f /q "${b}" >NUL 2>&1`,
    "goto done",
    ":restore",
    `move /y "${b}" "${t}" >NUL 2>&1`,
    ":giveup",
    `if exist "${t}" start "" "${t}"`,
    `if exist "${u}" del /f /q "${u}" >NUL 2>&1`,
    ":done",
    '(goto) 2>NUL & del /f /q "%~f0"',
    "",
  ].join("\r\n");
}

function describeDownloadError(error) {
  const code = error && error.code;
  if (error && error.userMessage) {
    return error.userMessage;
  }
  if (code === "ENOSPC") {
    return "There isn't enough free disk space to download the update.";
  }
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return "This folder isn't writable, so the portable version can't replace itself.";
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) {
    return "Couldn't reach GitHub. Check your internet connection and try again.";
  }
  return (error && error.message) || "The update download failed.";
}

function httpError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

function rateLimited(response) {
  const headers = response.headers || {};
  return response.statusCode === 429
    || (response.statusCode === 403 && (headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined));
}

async function assertWritableDir(dir) {
  const message = "This folder isn't writable, so the portable version can't replace itself.";
  try {
    await fs.access(dir, fsSync.constants.W_OK);
    const probe = path.join(dir, `.glasswing-write-test-${randomUUID()}.tmp`);
    await fs.writeFile(probe, "");
    await fs.rm(probe, { force: true });
  } catch {
    throw httpError(message);
  }
}

function openResponse(url, requestFn, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = requestFn(url, { headers: { "User-Agent": "Glasswing-Rclone", Accept: "application/octet-stream" } }, (response) => {
      const status = response.statusCode;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(httpError("The download redirected too many times."));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        openResponse(next, requestFn, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (status === 200) {
        resolve(response);
        return;
      }
      response.resume();
      if (rateLimited(response)) {
        reject(httpError("GitHub is rate limiting downloads right now. Try again in a bit."));
        return;
      }
      reject(httpError(`The download failed (HTTP ${status}).`));
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
  });
}

async function downloadFile({ url, dest, sha256, onProgress, requestFn = https.get, expectedSize = 0 }) {
  if (!sha256) {
    throw httpError("Couldn't verify the download, so Glasswing won't install it.");
  }
  let response;
  try {
    response = await openResponse(url, requestFn, MAX_REDIRECTS);
  } catch (error) {
    throw httpError(describeDownloadError(error));
  }

  const total = Number.parseInt(response.headers["content-length"], 10) || expectedSize || 0;
  const hash = createHash("sha256");
  const out = fsSync.createWriteStream(dest);
  let transferred = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  const emit = (force) => {
    const now = Date.now();
    if (!onProgress || (!force && now - lastEmit < 100)) {
      return;
    }
    lastEmit = now;
    const seconds = Math.max((now - startedAt) / 1000, 0.001);
    onProgress({
      percent: total ? Math.min(100, (transferred / total) * 100) : 0,
      transferred,
      total,
      bytesPerSecond: transferred / seconds,
    });
  };

  try {
    await new Promise((resolve, reject) => {
      response.on("data", (chunk) => {
        hash.update(chunk);
        transferred += chunk.length;
        emit(false);
      });
      response.on("error", reject);
      response.on("aborted", () => reject(Object.assign(new Error("aborted"), { code: "ECONNRESET" })));
      out.on("error", reject);
      out.on("finish", resolve);
      response.pipe(out);
    });
  } catch (error) {
    out.destroy();
    await fs.rm(dest, { force: true });
    throw httpError(describeDownloadError(error));
  }

  emit(true);

  if (hash.digest("hex") !== sha256.toLowerCase()) {
    await fs.rm(dest, { force: true });
    throw httpError("The downloaded file didn't match its checksum, so it was thrown away.");
  }
  return { size: transferred };
}

function portablePaths(exePath) {
  const dir = path.dirname(exePath);
  return {
    dir,
    update: path.join(dir, UPDATE_FILE_NAME),
    backup: `${exePath}.old`,
  };
}

async function cleanupLeftovers(exePath) {
  if (!exePath) {
    return;
  }
  const paths = portablePaths(exePath);
  await fs.rm(paths.update, { force: true }).catch(() => {});
  await fs.rm(paths.backup, { force: true }).catch(() => {});
}

async function downloadPortableUpdate({ release, version, exePath, onProgress, requestFn }) {
  const asset = pickPortableAsset(release, version);
  if (!asset) {
    throw httpError("This release doesn't have a portable download.");
  }
  const sha256 = parseDigest(asset.digest);
  if (!sha256) {
    throw httpError("Couldn't verify the download, so Glasswing won't install it.");
  }
  const paths = portablePaths(exePath);
  await assertWritableDir(paths.dir);
  await fs.rm(paths.update, { force: true });
  await downloadFile({
    url: asset.browser_download_url,
    dest: paths.update,
    sha256,
    onProgress,
    requestFn,
    expectedSize: asset.size,
  });
  return { version, updatePath: paths.update };
}

async function launchSwap({ exePath, pid = process.pid, tempDir = os.tmpdir(), spawnFn = spawn }) {
  const paths = portablePaths(exePath);
  const scriptPath = path.join(tempDir, `glasswing-update-${pid}.cmd`);
  const script = buildSwapScript({ pid, target: exePath, update: paths.update, backup: paths.backup });
  await fs.writeFile(scriptPath, script);
  const child = spawnFn("cmd.exe", ["/c", scriptPath], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  return scriptPath;
}

module.exports = {
  UPDATE_FILE_NAME,
  pickPortableAsset,
  parseDigest,
  buildSwapScript,
  describeDownloadError,
  assertWritableDir,
  downloadFile,
  downloadPortableUpdate,
  launchSwap,
  cleanupLeftovers,
  portablePaths,
};
