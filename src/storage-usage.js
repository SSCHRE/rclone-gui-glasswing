(() => {
const STORAGE_USAGE_CONCURRENCY = 4;
const STORAGE_WARN_RATIO = 0.75;
const STORAGE_FULL_RATIO = 0.9;
const METER_MAX_AGE_MS = 5 * 60 * 1000;

const entries = new Map();
const listeners = new Set();
const waiting = [];
let active = 0;

function formatBytes(size) {
  if (size == null || size < 0 || Number.isNaN(size)) {
    return "—";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let value = size / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function usedBytes(usage) {
  if (typeof usage?.used === "number") {
    return usage.used;
  }
  if (typeof usage?.total === "number" && typeof usage?.free === "number") {
    return usage.total - usage.free;
  }
  return null;
}

function usageRatio(usage) {
  const used = usedBytes(usage);
  return usage?.total > 0 && used != null ? Math.min(1, used / usage.total) : null;
}

function levelClass(ratio) {
  if (ratio == null) {
    return "";
  }
  if (ratio >= STORAGE_FULL_RATIO) {
    return "is-full";
  }
  return ratio >= STORAGE_WARN_RATIO ? "is-warn" : "";
}

function pump() {
  while (active < STORAGE_USAGE_CONCURRENCY && waiting.length) {
    const run = waiting.shift();
    active += 1;
    run().finally(() => {
      active -= 1;
      pump();
    });
  }
}

function schedule(task) {
  return new Promise((resolve, reject) => {
    waiting.push(() => task().then(resolve, reject));
    pump();
  });
}

function notify(target) {
  for (const listener of listeners) {
    listener(target);
  }
}

function get(target) {
  return entries.get(target) || null;
}

function load(target, { force = false, maxAgeMs = Infinity } = {}) {
  const existing = entries.get(target);
  if (existing?.pending) {
    return existing.promise;
  }
  if (existing && !force && Date.now() - existing.fetchedAt < maxAgeMs) {
    return Promise.resolve(existing.usage);
  }

  const promise = schedule(() => window.rcloneGui.getRemoteUsage(target))
    .catch((error) => ({
      error: String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || "rclone about failed.",
    }))
    .then((usage) => {
      entries.set(target, { usage, fetchedAt: Date.now() });
      notify(target);
      return usage;
    });

  entries.set(target, { pending: true, promise, usage: existing?.usage, fetchedAt: existing?.fetchedAt });
  notify(target);
  return promise;
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function targetForPath(value, remoteNames = []) {
  const text = String(value || "").trim();
  const drive = /^([A-Za-z]):[\\/]/.exec(text);
  if (drive) {
    return `${drive[1].toUpperCase()}:\\`;
  }
  const remote = /^([^:\\/]+):/.exec(text);
  if (remote && remoteNames.includes(remote[1])) {
    return `${remote[1]}:`;
  }
  return null;
}

class StorageMeter {
  constructor(container) {
    this.target = null;
    this.root = document.createElement("div");
    this.root.className = "storage-meter hidden";
    this.text = document.createElement("span");
    this.text.className = "storage-meter-text";
    const track = document.createElement("span");
    track.className = "storage-meter-bar";
    this.fill = document.createElement("span");
    this.fill.className = "storage-meter-fill";
    track.appendChild(this.fill);
    this.root.append(this.text, track);
    container.appendChild(this.root);
    subscribe((target) => {
      if (target === this.target) {
        this.render();
      }
    });
  }

  setTarget(target) {
    if (target === this.target) {
      return;
    }
    this.target = target || null;
    if (this.target) {
      void load(this.target, { maxAgeMs: METER_MAX_AGE_MS });
    }
    this.render();
  }

  refresh() {
    if (this.target) {
      void load(this.target, { force: true });
    }
  }

  render() {
    const entry = this.target ? get(this.target) : null;
    const usage = entry?.usage;
    this.root.className = "storage-meter";
    this.root.title = "";
    this.fill.style.width = "0";

    if (!this.target || (!usage && !entry?.pending) || usage?.unsupported) {
      this.root.classList.add("hidden");
      return;
    }

    if (!usage) {
      this.root.classList.add("is-loading");
      this.text.textContent = "Checking free space…";
      return;
    }

    if (usage.error) {
      this.root.classList.add("is-muted");
      this.text.textContent = "Couldn't check free space";
      this.root.title = usage.error;
      return;
    }

    const ratio = usageRatio(usage);
    const used = usedBytes(usage);
    if (ratio == null) {
      this.root.classList.add("is-muted");
      this.text.textContent = `${formatBytes(used)} used · no limit reported`;
      return;
    }

    const free = typeof usage.free === "number" ? usage.free : usage.total - used;
    this.text.textContent = `${formatBytes(free)} free of ${formatBytes(usage.total)}`;
    this.root.title = `${formatBytes(used)} used (${Math.round(ratio * 100)}%)`;
    this.fill.style.width = `${Math.max(ratio * 100, 1)}%`;
    const level = levelClass(ratio);
    if (level) {
      this.root.classList.add(level);
    }
    if (entry.pending) {
      this.root.classList.add("is-refreshing");
    }
  }
}

window.StorageUsage = {
  get,
  load,
  subscribe,
  targetForPath,
  formatBytes,
  usedBytes,
  usageRatio,
  levelClass,
};
window.StorageMeter = StorageMeter;
})();
