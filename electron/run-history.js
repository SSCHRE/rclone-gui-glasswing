const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const MAX_RUNS = 300;
const MAX_LOG_CHARS = 16000;

const STATS_LINE = /-\s+([^/\s][^/]*)\/([^,]+),\s*(?:[\d.]+%|-),([^,]+),\s*ETA\b/;
const TRANSFER_COUNT = /\(xfr#(\d+)\/(\d+)\)/;
const ERROR_LINE = /(?:^|\s)ERROR\s+:/;

function createRunTracker() {
  let partial = "";
  const summary = { transferred: null, total: null, speed: null, files: null, errors: 0 };

  function readLine(line) {
    if (ERROR_LINE.test(line)) {
      summary.errors += 1;
      return;
    }
    const stats = line.match(STATS_LINE);
    if (!stats) {
      return;
    }
    summary.transferred = stats[1].trim();
    summary.total = stats[2].trim();
    summary.speed = stats[3].trim();
    const files = line.match(TRANSFER_COUNT);
    if (files) {
      summary.files = Number(files[1]);
    }
  }

  return {
    push(text) {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop();
      lines.forEach(readLine);
    },
    finish() {
      if (partial) {
        readLine(partial);
        partial = "";
      }
      return { ...summary };
    },
  };
}

function createRunHistory({ directory }) {
  const file = path.join(directory, "run-history.json");
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

  async function write(runs) {
    cache = runs;
    await fs.mkdir(directory, { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(runs), "utf8");
    await fs.rename(temp, file);
  }

  function summarize({ log, ...run }) {
    return { ...run, hasLog: Boolean(log) };
  }

  function record(run) {
    return serialize(async () => {
      const entry = {
        id: randomUUID(),
        ...run,
        log: run.status === "success" ? "" : String(run.log || "").slice(-MAX_LOG_CHARS),
      };
      await write([entry, ...(await read())].slice(0, MAX_RUNS));
      return summarize(entry);
    });
  }

  function list() {
    return serialize(async () => (await read()).map(summarize));
  }

  function getLog(runId) {
    return serialize(async () => (await read()).find((run) => run.id === runId)?.log || "");
  }

  function clear() {
    return serialize(async () => {
      await write([]);
      return [];
    });
  }

  return { record, list, getLog, clear };
}

module.exports = { createRunHistory, createRunTracker };
