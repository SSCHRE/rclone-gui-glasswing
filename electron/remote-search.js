const { spawn } = require("child_process");
const { rcloneBinary } = require("./rclone-binary");

const DEFAULT_MAX_RESULTS = 1000;
const BATCH_INTERVAL_MS = 200;

function wildcardToRegExp(term) {
  const pattern = term.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${pattern}$`, "i");
}

function createMatcher(query) {
  const terms = String(query || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => (/[*?]/.test(term) ? wildcardToRegExp(term) : term));

  if (terms.length === 0) {
    return null;
  }

  return (name) => {
    const lower = name.toLowerCase();
    return terms.every((term) => (typeof term === "string" ? lower.includes(term) : term.test(name)));
  };
}

function parseListingLine(line) {
  const trimmed = line.trim().replace(/,$/, "");
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function searchRemote(remotePath, query, { maxResults = DEFAULT_MAX_RESULTS, onBatch, onSpawn } = {}) {
  const matches = createMatcher(query);
  if (!matches) {
    return Promise.reject(new Error("Type something to search for."));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(rcloneBinary(), ["lsjson", "-R", "--no-mimetype", "--", remotePath], { windowsHide: true, shell: false });
    onSpawn?.(child);

    let pending = "";
    let stderr = "";
    let scanned = 0;
    let matched = 0;
    let limited = false;
    let batch = [];
    let lastFlush = Date.now();

    const flush = (force = false) => {
      if (!force && Date.now() - lastFlush < BATCH_INTERVAL_MS) {
        return;
      }
      lastFlush = Date.now();
      if (batch.length || force) {
        onBatch?.(batch, scanned);
        batch = [];
      }
    };

    const handleLine = (line) => {
      if (limited) {
        return;
      }
      const entry = parseListingLine(line);
      if (!entry) {
        return;
      }
      scanned += 1;
      const name = entry.Name || String(entry.Path || "").split("/").pop() || "";
      if (!name || !matches(name)) {
        return;
      }
      matched += 1;
      batch.push({
        name: entry.Path || name,
        size: typeof entry.Size === "number" ? entry.Size : null,
        modTime: entry.ModTime || "",
        isDir: Boolean(entry.IsDir),
      });
      if (matched >= maxResults) {
        limited = true;
        child.kill();
      }
    };

    child.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        handleLine(line);
      }
      flush();
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (error) => {
      reject(error.code === "ENOENT" ? new Error("rclone was not found on your PATH.") : error);
    });

    child.on("close", (code) => {
      handleLine(pending);
      flush(true);

      if (child.killed && !limited) {
        reject(Object.assign(new Error("Search stopped."), { cancelled: true }));
        return;
      }

      const lastError = stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /ERROR|Failed/i.test(line))
        .pop()
        ?.replace(/^(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}\s+)?([A-Z]+\s*:\s*)?/, "");

      if (code !== 0 && !limited && scanned === 0) {
        reject(new Error(lastError || stderr.trim() || `rclone exited with code ${code}.`));
        return;
      }

      resolve({
        scanned,
        matched,
        limited,
        warning: code !== 0 && !limited ? lastError || "Some folders couldn't be read." : "",
      });
    });
  });
}

module.exports = { createMatcher, searchRemote };
