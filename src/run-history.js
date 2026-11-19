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
  detail: document.getElementById("run-detail-dialog"),
  detailTitle: document.getElementById("run-detail-title"),
  detailTags: document.getElementById("run-detail-tags"),
  detailBody: document.getElementById("run-detail-body"),
  detailNewer: document.getElementById("run-detail-newer"),
  detailOlder: document.getElementById("run-detail-older"),
  detailX: document.getElementById("run-detail-x"),
  detailCopyLog: document.getElementById("run-detail-copy-log"),
  detailLoad: document.getElementById("run-detail-load"),
  detailClose: document.getElementById("run-detail-close"),
};

const STATUS_LABELS = { success: "Done", failed: "Failed", cancelled: "Cancelled" };
const STATUS_BADGES = { success: "success", failed: "error", cancelled: "cancelled" };
const OPERATION_LABELS = { copy: "Copy", sync: "Sync", move: "Move", bisync: "Bisync" };
const CLEAR_CONFIRM_MS = 4000;
const MAX_STAGGER_INDEX = 14;

let runs = [];
let loadError = "";
let options = {};
let clearArmedTimer = null;
const openLogs = new Map();
const ERROR_LINE = /\b(ERROR|CRITICAL|FATAL)\b|\bfailed\b/i;
let detailRunId = null;
let detailLog = "";
let detailToken = 0;

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

function formatDay(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) {
    return "Today";
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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
    details.push({
      kind: "size",
      text: run.total && run.total !== run.transferred ? `${run.transferred} of ${run.total}` : run.transferred,
    });
  }
  if (run.files) {
    details.push({ kind: "files", text: plural(run.files, "file") });
  }
  if (run.errors) {
    details.push({ kind: "errors", text: plural(run.errors, "error") });
  }
  if (run.scheduled) {
    details.push({ kind: "scheduled", text: "Scheduled" });
  }
  if (run.dryRun) {
    details.push({ kind: "dry-run", text: "Dry run" });
  }
  return details.length ? details : [{ kind: "empty", text: "Nothing transferred" }];
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
  const log = el("pre", "run-history-log", "Loading…");
  item.querySelector(".run-history-body").append(log);
  openLogs.set(run.id, log);
  button.textContent = "Hide log";
  try {
    log.textContent = (await window.rcloneGui.getRunLog(run.id)) || "No output was kept for this run.";
    log.scrollTop = log.scrollHeight;
  } catch (error) {
    log.textContent = cleanError(error);
  }
}

function renderRun(run, index) {
  const item = el("li", `run-history-item is-${run.status}`);
  item.style.setProperty("--i", String(Math.min(index, MAX_STAGGER_INDEX)));
  item.append(el("span", "run-history-dot"));

  const body = el("div", "run-history-body");
  body.tabIndex = 0;
  body.setAttribute("role", "button");
  body.setAttribute("aria-haspopup", "dialog");
  body.dataset.runId = run.id;
  body.setAttribute("aria-label", `Show details for ${jobLabel(run)}`);
  body.addEventListener("click", (event) => {
    if (!event.target.closest("button")) {
      openDetail(run.id);
    }
  });
  body.addEventListener("keydown", (event) => {
    if (event.target === body && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      openDetail(run.id);
    }
  });
  const row = el("div", "run-history-row");

  const main = el("div", "run-history-main");
  const operation = OPERATION_LABELS[run.operation] || run.operation;
  const heading = el("p", "run-history-name");
  heading.append(
    el("span", "run-history-title", run.name || `${operation} job`),
    el("span", "run-history-op", operation),
  );
  main.append(heading);
  const paths = el("p", "run-history-paths", `${run.source} → ${run.destination}`);
  paths.title = paths.textContent;
  main.append(paths);
  row.append(main);

  const when = el("div", "run-history-when");
  const time = el("time", "", formatTime(run.startedAt));
  time.dateTime = new Date(run.startedAt).toISOString();
  time.title = new Date(run.startedAt).toLocaleString();
  when.append(time, el("span", "run-history-duration", formatDuration(run.finishedAt - run.startedAt)));
  row.append(when);
  body.append(row);

  const foot = el("div", "run-history-foot");
  const detail = el("p", "run-history-detail");
  detail.append(
    el("span", `job-badge ${STATUS_BADGES[run.status] || ""}`, STATUS_LABELS[run.status] || run.status),
    ...runDetails(run).map(({ kind, text }) => el("span", `run-history-chip is-${kind}`, text)),
  );
  foot.append(detail);

  const actions = el("div", "run-history-item-actions");
  const loadBtn = el("button", "secondary run-history-load", "Load job");
  loadBtn.type = "button";
  loadBtn.disabled = !canLoad();
  loadBtn.addEventListener("click", () => loadRun(run));
  actions.append(loadBtn);
  if (run.hasLog) {
    const logBtn = el("button", "secondary run-history-log-toggle", "Show log");
    logBtn.type = "button";
    logBtn.addEventListener("click", () => void toggleLog(run, item, logBtn));
    actions.append(logBtn);
  }
  foot.append(actions);
  body.append(foot);

  if (run.status === "failed" && run.message) {
    body.append(el("p", "run-history-message", run.message));
  }

  item.append(body);
  return item;
}

function renderRunList(visible) {
  const nodes = [];
  let lastDay = "";
  visible.forEach((run, index) => {
    const day = formatDay(run.startedAt);
    if (day !== lastDay) {
      lastDay = day;
      const header = el("li", "run-history-day", day);
      header.style.setProperty("--i", String(Math.min(index, MAX_STAGGER_INDEX)));
      nodes.push(header);
    }
    nodes.push(renderRun(run, index));
  });
  return nodes;
}

function loadRun(run) {
  if (canLoad()) {
    options.onLoad?.(run);
  }
}

function detailStat(label, value, tone) {
  const card = el("div", `stat-card run-detail-stat${tone ? ` is-${tone}` : ""}`);
  card.append(el("span", "stat-label", label), el("span", "stat-value", value));
  return card;
}

function copyButton(getText) {
  const button = el("button", "secondary run-detail-copy", "Copy");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
  return button;
}

function detailField(label, value, { copy = false, wide = false, mono = true } = {}) {
  const field = el("div", `run-detail-field${wide ? " is-wide" : ""}`);
  field.append(el("span", "run-detail-label", label));
  const line = el("div", "run-detail-value-row");
  line.append(el("span", `run-detail-value${mono ? " is-mono" : ""}`, value));
  if (copy) {
    line.append(copyButton(() => value));
  }
  field.append(line);
  return field;
}

function averageSpeed(run) {
  return run.speed && !/^0(\.0+)?\s*[A-Za-z]*\/s$/i.test(run.speed) ? run.speed : "—";
}

function detailFlags(run) {
  const flags = [];
  if (run.dryRun) {
    flags.push("Dry run");
  }
  if (run.deleteExcluded) {
    flags.push("Delete excluded");
  }
  return flags.length ? flags.join(", ") : "None";
}

function renderLogLines(box, text) {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  box.replaceChildren(
    ...lines.map((line) => el("span", ERROR_LINE.test(line) ? "run-detail-log-line is-error" : "run-detail-log-line", line || " ")),
  );
}

async function loadDetailLog(run, box) {
  const token = ++detailToken;
  detailLog = "";
  ui.detailCopyLog.disabled = true;
  box.classList.add("is-empty");
  if (!run.hasLog) {
    box.textContent = run.status === "success" ? "Logs are only kept for runs that failed or were cancelled." : "No output was kept for this run.";
    return;
  }
  box.textContent = "Loading…";
  try {
    const log = await window.rcloneGui.getRunLog(run.id);
    if (token !== detailToken) {
      return;
    }
    if (!log) {
      box.textContent = "No output was kept for this run.";
      return;
    }
    detailLog = log;
    box.classList.remove("is-empty");
    renderLogLines(box, log);
    box.scrollTop = box.scrollHeight;
    ui.detailCopyLog.disabled = false;
  } catch (error) {
    if (token === detailToken) {
      box.textContent = cleanError(error);
    }
  }
}

async function loadDetailCommand(run, holder) {
  try {
    const preview = await window.rcloneGui.previewJobCommand(run);
    if (preview?.command && detailRunId === run.id) {
      holder.append(detailField("Command (rebuilt with current limits)", preview.command, { copy: true, wide: true }));
    }
  } catch {
    return;
  }
}

function renderDetail() {
  const visible = filteredRuns();
  const index = visible.findIndex((run) => run.id === detailRunId);
  const run = visible[index] || runs.find((entry) => entry.id === detailRunId);
  if (!run) {
    closeDetail();
    return;
  }
  const operation = OPERATION_LABELS[run.operation] || run.operation;
  const stamp = (time) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  ui.detailTitle.textContent = run.name || `${run.source} → ${run.destination}`;
  ui.detailTags.replaceChildren(
    el("span", `job-badge ${STATUS_BADGES[run.status] || ""}`, STATUS_LABELS[run.status] || run.status),
    ...(run.dryRun ? [el("span", "run-history-chip is-dry-run", "Dry run")] : []),
    ...(run.scheduled ? [el("span", "run-history-chip is-scheduled", "Scheduled")] : []),
  );
  ui.detailNewer.disabled = index <= 0;
  ui.detailOlder.disabled = index < 0 || index >= visible.length - 1;
  ui.detailLoad.disabled = !canLoad();

  const stats = el("div", "run-detail-stats");
  const transferred = run.total && run.total !== run.transferred ? `${run.transferred} of ${run.total}` : run.transferred || "—";
  stats.append(
    detailStat("Started", stamp(run.startedAt)),
    detailStat("Finished", stamp(run.finishedAt)),
    detailStat("Duration", formatDuration(run.finishedAt - run.startedAt)),
    detailStat("Transferred", transferred),
    detailStat("Average speed", averageSpeed(run)),
    detailStat("Files", String(run.files || 0)),
    detailStat("Errors", String(run.errors || 0), run.errors ? "danger" : ""),
  );

  const fields = el("div", "run-detail-fields");
  fields.append(
    detailField("Operation", operation, { mono: false }),
    detailField("Flags", detailFlags(run), { mono: false }),
    detailField("Source", run.source, { copy: true, wide: true }),
    detailField("Destination", run.destination, { copy: true, wide: true }),
  );
  if (run.extraArgs) {
    fields.append(detailField("Extra args", run.extraArgs, { copy: true, wide: true }));
  }

  const nodes = [stats];
  if (run.status === "failed" && run.message) {
    nodes.push(el("p", "run-history-message run-detail-error", run.message));
  }
  const logBox = el("pre", "run-history-log run-detail-log");
  nodes.push(fields, el("p", "run-detail-label run-detail-log-head", "Log"), logBox);
  ui.detailBody.replaceChildren(...nodes);
  ui.detailBody.scrollTop = 0;
  void loadDetailCommand(run, fields);
  void loadDetailLog(run, logBox);
}

function openDetail(runId) {
  detailRunId = runId;
  renderDetail();
  ui.detail.classList.remove("hidden");
  ui.detail.setAttribute("aria-hidden", "false");
  document.addEventListener("keydown", onDetailKeydown, true);
  ui.detailClose.focus();
}

function closeDetail() {
  const runId = detailRunId;
  detailRunId = null;
  detailToken += 1;
  ui.detail.classList.add("hidden");
  ui.detail.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onDetailKeydown, true);
  const row = [...ui.list.querySelectorAll(".run-history-body")].find((node) => node.dataset.runId === runId);
  row?.focus({ preventScroll: true });
}

function stepDetail(offset) {
  const visible = filteredRuns();
  const next = visible[visible.findIndex((run) => run.id === detailRunId) + offset];
  if (next) {
    detailRunId = next.id;
    renderDetail();
  }
}

function onDetailKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeDetail();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    stepDetail(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    stepDetail(1);
  }
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
  ui.list.replaceChildren(...renderRunList(visible));
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
  if (detailRunId) {
    closeDetail();
  }
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
ui.detail.querySelector("[data-run-detail-close]").addEventListener("click", closeDetail);
ui.detailClose.addEventListener("click", closeDetail);
ui.detailX.addEventListener("click", closeDetail);
ui.detailNewer.addEventListener("click", () => stepDetail(-1));
ui.detailOlder.addEventListener("click", () => stepDetail(1));
ui.detailLoad.addEventListener("click", () => {
  const run = runs.find((entry) => entry.id === detailRunId);
  closeDetail();
  if (run) {
    loadRun(run);
  }
});
ui.detailCopyLog.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(detailLog);
    ui.detailCopyLog.textContent = "Copied";
  } catch {
    ui.detailCopyLog.textContent = "Copy failed";
  }
  setTimeout(() => {
    ui.detailCopyLog.textContent = "Copy log";
  }, 1600);
});
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
