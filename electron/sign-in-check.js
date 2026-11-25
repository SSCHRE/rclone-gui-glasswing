const CONCURRENCY = 3;
const RECHECK_COOLDOWN_MS = 60000;

const NEVER_PROBED_TYPES = new Set([
  "alias",
  "union",
  "crypt",
  "combine",
  "local",
  "chunker",
  "cache",
  "compress",
  "hasher",
  "press",
]);

function hasToken(settings) {
  const token = typeof settings?.token === "string" ? settings.token.trim() : "";
  return token !== "" && token !== "{}";
}

function selectTargets(dump, only = null) {
  const wanted = only ? new Set(only) : null;
  return Object.entries(dump || {})
    .filter(([name, settings]) => !wanted || wanted.has(name))
    .filter(([, settings]) => settings && !NEVER_PROBED_TYPES.has(settings.type))
    .map(([name, settings]) => ({ name, type: settings.type || "unknown", oauth: hasToken(settings) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function stateFromFailure(failure) {
  if (!failure) {
    return "ok";
  }
  if (failure.code === "auth") {
    return "expired";
  }
  if (failure.code === "unreachable") {
    return "unreachable";
  }
  return "error";
}

function remoteNameFromPath(value) {
  const match = /^([^:\\/]{2,}):/.exec(String(value || ""));
  return match ? match[1] : "";
}

function createSignInChecker({ readDump, probe, onChange, concurrency = CONCURRENCY, now = Date.now }) {
  let results = new Map();
  let running = null;
  let queued = null;
  const lastChecked = new Map();

  function snapshot() {
    return [...results.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  function emit(checking) {
    onChange?.({ results: snapshot(), checking });
  }

  async function checkOne(target) {
    let failure;
    try {
      failure = await probe(target.name);
    } catch (error) {
      failure = { code: "other", message: error?.message || "" };
    }
    const state = stateFromFailure(failure);
    results.set(target.name, {
      name: target.name,
      type: target.type,
      oauth: target.oauth,
      state,
      message: state === "ok" ? "" : failure.message || "",
    });
    lastChecked.set(target.name, now());
    emit(true);
  }

  async function execute({ full, names }) {
    const dump = await readDump();
    const targets = selectTargets(dump, full ? null : [...names]);
    if (full) {
      const keep = new Set(targets.map((target) => target.name));
      results = new Map([...results].filter(([name]) => keep.has(name)));
    } else {
      for (const name of names) {
        if (!targets.some((target) => target.name === name)) {
          results.delete(name);
        }
      }
    }
    emit(targets.length > 0);
    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const target = targets[index];
        index += 1;
        await checkOne(target);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  }

  async function drain(first) {
    let job = first;
    while (job) {
      try {
        await execute(job);
      } catch {}
      job = queued;
      queued = null;
    }
    running = null;
    emit(false);
    return snapshot();
  }

  function run({ only = null } = {}) {
    const request = only ? { full: false, names: new Set(only) } : { full: true, names: new Set() };
    if (running) {
      if (!queued) {
        queued = { full: request.full, names: new Set(request.names) };
      } else if (request.full) {
        queued = { full: true, names: new Set() };
      } else if (!queued.full) {
        for (const name of request.names) {
          queued.names.add(name);
        }
      }
      return running;
    }
    running = drain(request);
    return running;
  }

  function recheck(name) {
    const last = lastChecked.get(name) || 0;
    if (running || now() - last < RECHECK_COOLDOWN_MS) {
      return null;
    }
    return run({ only: [name] });
  }

  function failingNames() {
    return [...results.values()].filter((entry) => entry.state !== "ok").map((entry) => entry.name);
  }

  function recheckFailing({ force = false } = {}) {
    const names = failingNames().filter((name) => force || now() - (lastChecked.get(name) || 0) >= RECHECK_COOLDOWN_MS);
    return names.length ? run({ only: names }) : null;
  }

  function markOk(name) {
    const entry = results.get(name);
    if (!entry || entry.state === "ok") {
      return;
    }
    results.set(name, { ...entry, state: "ok", message: "" });
    lastChecked.set(name, now());
    emit(Boolean(running));
  }

  function clear() {
    results = new Map();
    emit(false);
  }

  return {
    run,
    recheck,
    recheckFailing,
    markOk,
    clear,
    results: snapshot,
    isRunning: () => Boolean(running),
  };
}

module.exports = { selectTargets, stateFromFailure, remoteNameFromPath, createSignInChecker, CONCURRENCY };
