const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const GIB = 1024 ** 3;
const DRIVE_DAILY_UPLOAD_BYTES = 750 * GIB;
const MAX_SAMPLES = 50;
const SIZE_UNITS = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5 };

const PAUSED_WINDOW = /max transfer duration reached|max-duration/i;
const PAUSED_LIMIT = /stop-on-upload-limit|upload limit|uploadLimitExceeded|userRateLimitExceeded|dailyLimitExceeded|quota exceeded/i;

function parseSize(text) {
  const match = /^([\d.]+)\s*([bkmgtp]?)i?b?(?:\/s)?$/i.exec(String(text ?? "").trim());
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.round(value * SIZE_UNITS[(match[2] || "b").toLowerCase()]) : null;
}

function migrationFlags({ destType, windowHours }) {
  const flags = [];
  if (destType === "drive") {
    flags.push("--drive-stop-on-upload-limit");
  }
  if (windowHours) {
    flags.push("--max-duration", `${windowHours}h`, "--cutoff-mode", "soft");
  }
  return flags;
}

function classifyRun({ success, cancelled, output }) {
  if (cancelled) {
    return "stopped";
  }
  if (success) {
    return "complete";
  }
  if (PAUSED_WINDOW.test(output || "")) {
    return "paused-window";
  }
  if (PAUSED_LIMIT.test(output || "")) {
    return "paused-limit";
  }
  return "failed";
}

function dailyCapFor(destType) {
  return destType === "drive" ? DRIVE_DAILY_UPLOAD_BYTES : null;
}

function estimate({ bytes, bytesPerSecond, dailyCapBytes = null, windowHours = null }) {
  if (!(bytes > 0) || !(bytesPerSecond > 0)) {
    return null;
  }
  const seconds = bytes / bytesPerSecond;
  const perRunBytes = Math.min(
    dailyCapBytes ?? Number.POSITIVE_INFINITY,
    bytesPerSecond * (windowHours ? windowHours * 3600 : 86400),
  );
  return { seconds, runs: Math.max(1, Math.ceil(bytes / perRunBytes)) };
}

function parseCheckReport(text) {
  const report = { matched: 0, missing: 0, differ: 0, errors: 0, samples: { missing: [], differ: [], errors: [] } };
  const buckets = { "-": "missing", "*": "differ", "!": "errors" };
  for (const line of String(text || "").split(/\r?\n/)) {
    const marker = line[0];
    const name = line.slice(2);
    if (!name || line[1] !== " ") {
      continue;
    }
    if (marker === "=") {
      report.matched += 1;
      continue;
    }
    const bucket = buckets[marker];
    if (!bucket) {
      continue;
    }
    report[bucket] += 1;
    if (report.samples[bucket].length < MAX_SAMPLES) {
      report.samples[bucket].push(name);
    }
  }
  return report;
}

function tipsFor({ sourceType, destType, sameRemote, bytes, free }) {
  const tips = [];
  if (typeof free === "number" && bytes > free) {
    tips.push({ level: "bad", text: "This won't fit: the destination doesn't have enough free space." });
  }
  if (sameRemote) {
    tips.push({ level: "good", text: "Both sides are on the same remote, so rclone copies on the server and your internet isn't used." });
  } else {
    tips.push({ level: "info", text: "Everything goes through this PC: it downloads from the source and uploads to the destination, so your upload speed is the limit." });
  }
  if (destType === "drive") {
    tips.push({ level: "warn", text: "Google Drive accepts about 750 GB of uploads per day. When it hits that, the migration pauses and carries on at the next run." });
  }
  if (sourceType === "drive") {
    tips.push({ level: "info", text: "Google Docs, Sheets and Slides get exported as Word, Excel and PowerPoint files." });
  }
  if (destType === "onedrive") {
    tips.push({ level: "info", text: "OneDrive doesn't allow some characters in names. rclone swaps them for look-alikes so nothing gets skipped." });
  }
  return tips;
}

function createMigrationStore({ directory }) {
  const file = path.join(directory, "migrations.json");
  const reportsDir = path.join(directory, "migrations");
  let cache = null;
  let queue = Promise.resolve();

  function serialize(task) {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  }

  async function read() {
    if (cache) {
      return cache;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(file, "utf8"));
      cache = Array.isArray(parsed) ? parsed : [];
    } catch {
      cache = [];
    }
    return cache;
  }

  async function write(entries) {
    cache = entries;
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(file, JSON.stringify(entries, null, 2), "utf8");
    return entries;
  }

  return {
    list: () => serialize(async () => [...(await read())]),
    get: (id) => serialize(async () => (await read()).find((entry) => entry.id === id) || null),
    findByJob: (jobId) => serialize(async () => (await read()).find((entry) => entry.jobId === jobId) || null),
    create: (fields) => serialize(async () => {
      const entry = { id: randomUUID(), createdAt: Date.now(), runs: 0, copiedBytes: 0, ...fields };
      await write([entry, ...(await read())]);
      return entry;
    }),
    update: (id, change) => serialize(async () => {
      const entries = await read();
      const index = entries.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return null;
      }
      const next = { ...entries[index], ...(typeof change === "function" ? change(entries[index]) : change) };
      entries[index] = next;
      await write([...entries]);
      return next;
    }),
    remove: (id) => serialize(async () => {
      await write((await read()).filter((entry) => entry.id !== id));
      await fs.rm(path.join(reportsDir, `${id}-matched.txt`), { force: true }).catch(() => {});
      await fs.rm(path.join(reportsDir, `${id}-combined.txt`), { force: true }).catch(() => {});
    }),
    reportPaths: async (id) => {
      await fs.mkdir(reportsDir, { recursive: true });
      return {
        matched: path.join(reportsDir, `${id}-matched.txt`),
        combined: path.join(reportsDir, `${id}-combined.txt`),
      };
    },
  };
}

module.exports = {
  createMigrationStore,
  migrationFlags,
  classifyRun,
  dailyCapFor,
  estimate,
  parseCheckReport,
  parseSize,
  tipsFor,
};
