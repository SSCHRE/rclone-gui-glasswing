(() => {
const SNACKBAR_ACTION_MS = 14000;
const EXPIRED_SUFFIX = " (sign in again)";
const REJECTED_SUFFIX = " (sign-in failed)";

const states = new Map();
const listeners = new Set();
const announced = new Set();
let enabled = true;
let checking = false;
let options = { notify: null, openManager: null };
let reconnecting = null;

function cleanError(error, fallback) {
  const text = String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "").trim();
  return text || fallback;
}

function get(name) {
  return states.get(name) || null;
}

function stateOf(name) {
  return states.get(name)?.state || "";
}

function expiredNames() {
  return [...states.values()].filter((entry) => entry.state === "expired").map((entry) => entry.name);
}

function canReconnect(name) {
  return states.get(name)?.oauth !== false;
}

function label(name) {
  if (stateOf(name) !== "expired") {
    return name;
  }
  return `${name}${canReconnect(name) ? EXPIRED_SUFFIX : REJECTED_SUFFIX}`;
}

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function describeExpired(names) {
  if (names.length === 1) {
    return `${names[0]} needs you to sign in again`;
  }
  return `${names.length} remotes need you to sign in again`;
}

async function reconnect(name) {
  if (reconnecting || !window.rcloneGui?.reconnectRemote) {
    return false;
  }
  reconnecting = name;
  options.notify?.({
    title: `Signing in to ${name}`,
    message: "Finish signing in in the browser window that opened.",
    type: "running",
  });
  try {
    await window.rcloneGui.reconnectRemote(name);
    options.notify?.({ title: "Signed in again", message: `${name} is connected.`, type: "success" });
    return true;
  } catch (error) {
    options.notify?.({ title: `Couldn't sign in to ${name}`, message: cleanError(error, "Reconnecting didn't work."), type: "error" });
    return false;
  } finally {
    reconnecting = null;
  }
}

function announce() {
  const expired = expiredNames();
  for (const name of [...announced]) {
    if (!expired.includes(name)) {
      announced.delete(name);
    }
  }
  const fresh = expired.filter((name) => !announced.has(name));
  if (!fresh.length) {
    return;
  }
  fresh.forEach((name) => announced.add(name));
  if (fresh.length > 1) {
    options.notify?.({
      title: "Sign-in problems",
      message: describeExpired(fresh),
      type: "warning",
      duration: SNACKBAR_ACTION_MS,
      action: { label: "Manage remotes", onClick: () => options.openManager?.() },
    });
    return;
  }
  const [name] = fresh;
  if (canReconnect(name)) {
    options.notify?.({
      title: "Sign-in expired",
      message: describeExpired(fresh),
      type: "warning",
      duration: SNACKBAR_ACTION_MS,
      action: { label: "Reconnect", onClick: () => void reconnect(name) },
    });
    return;
  }
  options.notify?.({
    title: "Sign-in failed",
    message: `${name} didn't accept its API key or password`,
    type: "warning",
    duration: SNACKBAR_ACTION_MS,
    action: { label: "Show remote", onClick: () => options.openManager?.(name) },
  });
}

function apply(payload) {
  states.clear();
  for (const entry of payload?.results || []) {
    states.set(entry.name, entry);
  }
  checking = Boolean(payload?.checking);
  emit();
  if (!checking && enabled) {
    announce();
  }
}

function setEnabled(next) {
  enabled = next;
  if (!enabled) {
    states.clear();
    announced.clear();
    emit();
  }
}

async function check() {
  if (!window.rcloneGui?.checkRemoteSignIns) {
    return;
  }
  try {
    const outcome = await window.rcloneGui.checkRemoteSignIns();
    if (outcome?.skipped === "off") {
      setEnabled(false);
    } else if (outcome && !outcome.skipped) {
      apply({ results: outcome.results, checking: false });
    }
  } catch {}
}

async function init(next = {}) {
  options = { ...options, ...next };
  if (!window.rcloneGui?.getRemoteSignIns) {
    return;
  }
  window.rcloneGui.onRemoteSignInsChanged?.(apply);
  try {
    const current = await window.rcloneGui.getRemoteSignIns();
    enabled = current.enabled;
    if (current.results.length) {
      apply({ results: current.results, checking: false });
    }
  } catch {}
}

window.SignIns = {
  init,
  check,
  get,
  stateOf,
  expiredNames,
  canReconnect,
  openManager: (name) => options.openManager?.(name),
  label,
  reconnect,
  onChange,
  setEnabled,
  isEnabled: () => enabled,
  isChecking: () => checking,
};
})();
