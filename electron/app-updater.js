const fs = require("fs");
const path = require("path");
const portable = require("./portable-updater");

const REASONS = {
  dev: "Updates can't be installed when running from source.",
  unsupported: "Updates can't be installed on this platform yet.",
  noConfig: "This build doesn't have update info, so it can't update itself.",
  portableFolder: "This folder isn't writable, so the portable version can't replace itself.",
  macUnsigned: "On macOS the update has to be downloaded from the releases page for now.",
  noPkexec: "pkexec isn't installed, so the .deb can't be updated from here.",
};

function detectKind({ isPackaged, platform, env, hasUpdateConfig }) {
  if (!isPackaged) {
    return "dev";
  }
  if (platform === "win32") {
    if (env.PORTABLE_EXECUTABLE_FILE) {
      return "portable";
    }
    return hasUpdateConfig ? "nsis" : "unsupported";
  }
  if (platform === "linux") {
    if (env.APPIMAGE) {
      return "appimage";
    }
    return hasUpdateConfig ? "deb" : "unsupported";
  }
  if (platform === "darwin") {
    return "mac";
  }
  return "unsupported";
}

function hasCommand(name, env = process.env) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fs.accessSync(path.join(dir, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function describeUpdaterError(error) {
  const text = String((error && error.message) || error || "");
  const code = error && error.code;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(`${text} ${code}`)) {
    return "Couldn't reach GitHub. Check your internet connection and try again.";
  }
  if (/rate limit|HTTP 403|status code 403|HTTP 429/i.test(text)) {
    return "GitHub is rate limiting requests right now. Try again in a bit.";
  }
  if (/sha512|sha256|checksum/i.test(text)) {
    return "The downloaded file didn't match its checksum, so it was thrown away.";
  }
  if (/ENOSPC|no space/i.test(`${text} ${code}`)) {
    return "There isn't enough free disk space to download the update.";
  }
  if (/latest.*\.yml|Cannot find latest|404/i.test(text)) {
    return "This release doesn't have update files for this build yet.";
  }
  return text.split(/\r?\n/)[0].slice(0, 300) || "The update failed.";
}

function createAppUpdater({ app, env = process.env, platform = process.platform, send, ensureRelease, getBlocker, prepareQuit, loadUpdater }) {
  let kind = null;
  let nativeUpdater = null;
  let downloading = null;
  let downloaded = null;

  function hasUpdateConfig() {
    try {
      return fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
    } catch {
      return false;
    }
  }

  function currentKind() {
    if (!kind) {
      kind = detectKind({ isPackaged: app.isPackaged, platform, env, hasUpdateConfig: hasUpdateConfig() });
    }
    return kind;
  }

  async function getCapability() {
    const detected = currentKind();
    if (detected === "dev") {
      return { canSelfUpdate: false, kind: detected, reason: REASONS.dev };
    }
    if (detected === "mac") {
      return { canSelfUpdate: false, kind: detected, reason: REASONS.macUnsigned };
    }
    if (detected === "unsupported") {
      return { canSelfUpdate: false, kind: detected, reason: hasUpdateConfig() || platform === "win32" || platform === "linux" ? REASONS.noConfig : REASONS.unsupported };
    }
    if (detected === "portable") {
      try {
        await portable.assertWritableDir(portable.portablePaths(env.PORTABLE_EXECUTABLE_FILE).dir);
      } catch {
        return { canSelfUpdate: false, kind: detected, reason: REASONS.portableFolder };
      }
    }
    if (detected === "deb" && !hasCommand("pkexec", env)) {
      return { canSelfUpdate: false, kind: detected, reason: REASONS.noPkexec };
    }
    return { canSelfUpdate: true, kind: detected };
  }

  function getNativeUpdater() {
    if (nativeUpdater) {
      return nativeUpdater;
    }
    const lib = loadUpdater ? loadUpdater() : require("electron-updater");
    const detected = currentKind();
    if (detected === "deb") {
      nativeUpdater = new lib.DebUpdater();
    } else if (detected === "appimage") {
      nativeUpdater = new lib.AppImageUpdater();
    } else {
      nativeUpdater = new lib.NsisUpdater();
    }
    nativeUpdater.autoDownload = false;
    nativeUpdater.disableDifferentialDownload = true;
    nativeUpdater.autoInstallOnAppQuit = false;
    nativeUpdater.allowPrerelease = false;
    nativeUpdater.allowDowngrade = false;
    nativeUpdater.logger = null;
    nativeUpdater.on("download-progress", (info) => {
      send("app-update-progress", {
        percent: info.percent,
        transferred: info.transferred,
        total: info.total,
        bytesPerSecond: info.bytesPerSecond,
      });
    });
    return nativeUpdater;
  }

  async function runDownload(capability) {
    if (capability.kind === "portable") {
      const release = await ensureRelease();
      const version = String(release.tag_name || "").replace(/^v/, "");
      const exePath = env.PORTABLE_EXECUTABLE_FILE;
      await portable.downloadPortableUpdate({
        release,
        version,
        exePath,
        onProgress: (progress) => send("app-update-progress", progress),
      });
      return { version };
    }

    const updater = getNativeUpdater();
    const result = await updater.checkForUpdates();
    if (!result || !result.isUpdateAvailable) {
      throw new Error("There's no update to download for this build yet.");
    }
    await updater.downloadUpdate();
    return { version: result.updateInfo.version };
  }

  async function download() {
    if (downloading) {
      return downloading;
    }
    const capability = await getCapability();
    if (!capability.canSelfUpdate) {
      throw new Error(capability.reason);
    }
    if (downloaded) {
      return { version: downloaded.version };
    }

    downloading = (async () => {
      try {
        const result = await runDownload(capability);
        downloaded = { version: result.version, kind: capability.kind };
        return result;
      } catch (error) {
        throw new Error(portable.describeDownloadError({ userMessage: error && error.userMessage, code: error && error.code, message: describeUpdaterError(error) }));
      } finally {
        downloading = null;
      }
    })();
    return downloading;
  }

  function getDownloaded() {
    return downloaded ? { version: downloaded.version } : null;
  }

  async function install() {
    if (!downloaded) {
      throw new Error("There's no downloaded update to install yet.");
    }
    const blocker = getBlocker();
    if (blocker) {
      throw new Error(blocker);
    }

    if (downloaded.kind === "portable") {
      await portable.launchSwap({ exePath: env.PORTABLE_EXECUTABLE_FILE });
      prepareQuit();
      app.quit();
      return true;
    }

    prepareQuit();
    getNativeUpdater().quitAndInstall(true, true);
    return true;
  }

  async function cleanupOnStartup() {
    if (currentKind() === "portable") {
      await portable.cleanupLeftovers(env.PORTABLE_EXECUTABLE_FILE);
    }
  }

  return { getCapability, download, install, getDownloaded, cleanupOnStartup };
}

module.exports = { createAppUpdater, detectKind, describeUpdaterError, hasCommand };
