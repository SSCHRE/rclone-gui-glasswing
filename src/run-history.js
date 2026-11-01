(() => {
const ui = {
  view: document.getElementById("history-view"),
  tab: document.getElementById("mode-history"),
  filter: document.getElementById("run-history-filter"),
  job: document.getElementById("run-history-job"),
  summary: document.getElementById("run-history-summary"),
  list: document.getElementById("run-history-list"),
  empty: document.getElementById("run-history-empty"),
  clearBtn: document.getElementById("run-history-clear"),
};

const STATUS_LABELS = { success: "Done", failed: "Failed", cancelled: "Cancelled" };
const STATUS_BADGES = { success: "success", failed: "error", cancelled: "cancelled" };
const OPERATION_LABELS = { copy: "Copy", sync: "Sync", move: "Move", bisync: "Bisync" };
const CLEAR_CONFIRM_MS = 4000;

let runs = [];
let loadError = "";
let options = {};
let clearArmedTimer = null;
const openLogs = new Map();

function cleanError(error) {
  return String(error?.message || error || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function formatWhen(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) {
    return `Today ${time}`;
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${time}`;
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })} ${time}`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function runDetails(run) {
  const details = [];
  if (run.transferred && !/^0(\.0+)?\s*B?$/i.test(run.transferred)) {
    details.push(run.total && run.total !== run.transferred ? `${run.transferred} of ${run.total}` : run.transferred);
  }
  if (run.files) {
    details.push(plural(run.files, "file"));
  }
  if (run.errors) {
    details.push(plural(run.errors, "error"));
  }
  if (run.scheduled) {
    details.push("Scheduled");
  }
  if (run.dryRun) {
    details.push("Dry run");
  }
  return details.length ? details.join(" · ") : "Nothing transferred";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function jobKey(run) {
  return run.jobId ? `job:${run.jobId}` : `run:${run.operation}|${run.source}|${run.destination}`;
}

function jobLabel(run) {
  const operation = OPERATION_LABELS[run.operation] || run.operation;
  return run.name || `${operation}: ${run.source} → ${run.destination}`;
}

function renderJobOptions() {
  const selected = ui.job.value;
  const jobs = new Map();
  for (const run of runs) {
    const key = jobKey(run);
    const job = jobs.get(key);
    if (job) {
      job.count += 1;
    } else {
      jobs.set(key, { label: jobLabel(run), count: 1 });
    }
  }
  const allOption = el("option", "", "All jobs");
  allOption.value = "";
  ui.job.replaceChildren(allOption, ...[...jobs].map(([key, job]) => {
    const option = el("option", "", `${job.label} (${job.count})`);
    option.value = key;
    option.title = job.label;
    return option;
  }));
  ui.job.value = jobs.has(selected) ? selected : "";
}

function jobRuns() {
  return ui.job.value ? runs.filter((run) => jobKey(run) === ui.job.value) : runs;
}

function filteredRuns() {
  const scoped = jobRuns();
  if (ui.filter.value === "failed") {
    return scoped.filter((run) => run.status === "failed");
  }
  if (ui.filter.value === "scheduled") {
    return scoped.filter((run) => run.scheduled);
  }
  return scoped;
}

function renderSummary() {
  const scoped = jobRuns();
  if (!scoped.length) {
    ui.summary.textContent = "";
    return;
  }
  const failed = scoped.filter((run) => run.status === "failed").length;
  const lastSuccess = scoped.find((run) => run.status === "success");
  const parts = [plural(scoped.length, "run")];
  if (failed) {
    parts.push(`${failed} failed`);
  }
  if (lastSuccess) {
    parts.push(`last success ${formatWhen(lastSuccess.finishedAt).replace(/^(Today|Yesterday)/, (word) => word.toLowerCase())}`);
  }
  ui.summary.textContent = parts.join(" · ");
}

async function toggleLog(run, item, button) {
  const existing = openLogs.get(run.id);
  if (existing) {
    existing.remove();
    openLogs.delete(run.id);
    button.textContent = "Show log";
    return;
  }
  const log = el("pre", "command-preview run-history-log", "Loading…");
  item.append(log);
  openLogs.set(run.id, log);
  button.textContent = "Hide log";
  try {
    log.textContent = (await window.rcloneGui.getRunLog(run.id)) || "No output was kept for this run.";
    log.scrollTop = log.scrollHeight;
  } catch (error) {
    log.textContent = cleanError(error);
  }
}

function renderRun(run) {
  const item = el("li", `run-history-item is-${run.status}`);

  const row = el("div", "run-history-row");
  row.append(el("span", `job-badge ${STATUS_BADGES[run.status] || ""}`, STATUS_LABELS[run.status] || run.status));

  const main = el("div", "run-history-main");
  const operation = OPERATION_LABELS[run.operation] || run.operation;
  main.append(el("p", "run-history-name", run.name ? `${run.name} (${operation.toLowerCase()})` : `${operation} job`));
  const paths = el("p", "run-history-paths", `${run.source} → ${run.destination}`);
  paths.title = paths.textContent;
  main.append(paths);
  row.append(main);

  const when = el("div", "run-history-when");
  when.append(el("time", "", formatWhen(run.startedAt)));
  when.lastChild.dateTime = new Date(run.startedAt).toISOString();
  when.lastChild.title = new Date(run.startedAt).toLocaleString();
  when.append(el("span", "", formatDuration(run.finishedAt - run.startedAt)));
  row.append(when);
  item.append(row);

  item.append(el("p", "run-history-detail", runDetails(run)));
  if (run.status === "failed" && run.message) {
    item.append(el("p", "run-history-message", run.message));
  }

  const actions = el("div", "run-history-item-actions");
  const loadBtn = el("button", "secondary run-history-load", "Load job");
  loadBtn.type = "button";
  loadBtn.disabled = !canLoad();
  loadBtn.addEventListener("click", () => {
    if (canLoad()) {
      options.onLoad?.(run);
    }
  });
  actions.append(loadBtn);
  if (run.hasLog) {
    const logBtn = el("button", "secondary", "Show log");
    logBtn.type = "button";
    logBtn.addEventListener("click", () => void toggleLog(run, item, logBtn));
    actions.append(logBtn);
  }
  item.append(actions);
  return item;
}

function canLoad() {
  return options.canLoad ? options.canLoad() : true;
}

function renderTabAlert() {
  const lastFailed = runs[0]?.status === "failed";
  ui.tab?.classList.toggle("has-alert", lastFailed);
  if (ui.tab) {
    ui.tab.title = lastFailed ? `Last run failed: ${runs[0].name || `${runs[0].source} → ${runs[0].destination}`}` : "";
  }
}

function render() {
  renderTabAlert();
  if (!isVisible()) {
    return;
  }
  openLogs.clear();
  renderJobOptions();
  const visible = filteredRuns();
  ui.list.replaceChildren(...visible.map(renderRun));
  ui.empty.textContent = loadError || (runs.length ? "No runs match this filter." : "Nothing here yet. Finished jobs show up here.");
  ui.empty.classList.toggle("hidden", visible.length > 0);
  ui.clearBtn.disabled = runs.length === 0;
  renderSummary();
}

async function refresh() {
  try {
    runs = await window.rcloneGui.listRuns();
    loadError = "";
  } catch (error) {
    runs = [];
    loadError = cleanError(error);
  }
  render();
}

function isVisible() {
  return !ui.view.hidden;
}

function disarmClear() {
  clearTimeout(clearArmedTimer);
  clearArmedTimer = null;
  ui.clearBtn.textContent = "Clear history";
  ui.clearBtn.classList.remove("is-armed");
}

async function clearHistory() {
  if (!clearArmedTimer) {
    ui.clearBtn.textContent = "Click again to clear";
    ui.clearBtn.classList.add("is-armed");
    clearArmedTimer = setTimeout(disarmClear, CLEAR_CONFIRM_MS);
    return;
  }
  disarmClear();
  try {
    runs = await window.rcloneGui.clearRuns();
    loadError = "";
  } catch (error) {
    loadError = cleanError(error);
  }
  render();
}

function show() {
  ui.view.classList.remove("hidden");
  ui.view.hidden = false;
  render();
  void refresh();
}

function hide() {
  disarmClear();
  ui.view.classList.add("hidden");
  ui.view.hidden = true;
}

function syncLoadButtons() {
  const allowed = canLoad();
  for (const button of ui.list.querySelectorAll(".run-history-load")) {
    button.disabled = !allowed;
  }
}

ui.filter.addEventListener("change", render);
ui.job.addEventListener("change", render);
ui.clearBtn.addEventListener("click", () => void clearHistory());
window.rcloneGui.onRunsChanged?.(() => void refresh());
void refresh();

window.RunHistory = {
  show,
  hide,
  syncLoadButtons,
  setOptions(next) {
    options = { ...options, ...next };
  },
};
})();
