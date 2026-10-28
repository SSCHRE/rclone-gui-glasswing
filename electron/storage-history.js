const fs = require("fs/promises");
const path = require("path");

const KEEP_DAYS = 120;
const MAX_TARGETS = 200;

function dayKey(time = Date.now()) {
  const date = new Date(time);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function createStorageHistory({ directory }) {
  const file = path.join(directory, "storage-history.json");
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
      cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  }

  async function write(data) {
    cache = data;
    await fs.mkdir(directory, { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data), "utf8");
    await fs.rename(temp, file);
  }

  function record(target, { used, total }) {
    if (typeof used !== "number" || !target) {
      return Promise.resolve();
    }
    return serialize(async () => {
      const data = await read();
      const today = dayKey();
      const cutoff = dayKey(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
      const points = (data[target] || []).filter((point) => point.day >= cutoff && point.day !== today);
      points.push({ day: today, used, total: typeof total === "number" ? total : null, at: Date.now() });
      points.sort((left, right) => (left.day < right.day ? -1 : 1));
      data[target] = points;

      const targets = Object.keys(data);
      if (targets.length > MAX_TARGETS) {
        targets
          .sort((left, right) => (data[left].at(-1)?.at || 0) - (data[right].at(-1)?.at || 0))
          .slice(0, targets.length - MAX_TARGETS)
          .forEach((stale) => delete data[stale]);
      }
      await write(data);
    });
  }

  function get(targets) {
    return serialize(async () => {
      const data = await read();
      const wanted = Array.isArray(targets) ? targets : Object.keys(data);
      return Object.fromEntries(wanted.filter((target) => data[target]).map((target) => [target, data[target]]));
    });
  }

  return { record, get };
}

module.exports = { createStorageHistory, dayKey };
