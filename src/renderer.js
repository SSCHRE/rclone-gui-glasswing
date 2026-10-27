const operationHints = {

  copy: "Copy adds or updates files in the destination.",

  sync: "Sync makes the destination match the source. Destructive on the destination side.",

  move: "Move transfers files and deletes them from the source when done.",

  bisync: "Bisync keeps both sides in step: new, changed and deleted files on either side are applied to the other.",

};



const elements = {

  version: document.getElementById("rclone-version"),
  appVersion: document.getElementById("app-version"),

  operation: document.getElementById("operation"),

  operationHint: document.getElementById("operation-hint"),

  source: document.getElementById("source"),

  destination: document.getElementById("destination"),

  remotePicker: document.getElementById("remote-picker"),

  remotePath: document.getElementById("remote-path"),

  dryRun: document.getElementById("dry-run"),

  deleteExcluded: document.getElementById("delete-excluded"),
  resync: document.getElementById("resync"),
  resyncOption: document.getElementById("resync-option"),
  extraArgs: document.getElementById("extra-args"),

  runJob: document.getElementById("run-job"),

  stopJob: document.getElementById("stop-job"),

  refreshRemotes: document.getElementById("refresh-remotes"),
  manageRemotes: document.getElementById("manage-remotes"),
  checkForUpdates: document.getElementById("check-for-updates"),
  modeJobs: document.getElementById("mode-jobs"),
  modeBrowse: document.getElementById("mode-browse"),
  jobsView: document.getElementById("jobs-view"),
  browseView: document.getElementById("browse-view"),

  status: document.getElementById("status"),
  popupRoot: document.getElementById("popup-root"),
  popupCard: document.querySelector(".popup-card"),
  popupTitle: document.getElementById("popup-title"),
  popupMessage: document.getElementById("popup-message"),
  popupClose: document.getElementById("popup-close"),
  updateDialog: document.getElementById("update-dialog"),
  updateCurrent: document.getElementById("update-current"),
  updateLatest: document.getElementById("update-latest"),
  updateDate: document.getElementById("update-date"),
  updateLater: document.getElementById("update-later"),
  updateOpen: document.getElementById("update-open"),
  jobHistoryPicker: document.getElementById("job-history-picker"),
  loadJob: document.getElementById("load-job"),
  updateJob: document.getElementById("update-job"),
  saveJob: document.getElementById("save-job"),
  deleteJob: document.getElementById("delete-job"),
  scheduleJob: document.getElementById("schedule-job"),
  jobHistoryMeta: document.getElementById("job-history-meta"),
  jobHistoryCollapsible: document.getElementById("job-history-collapsible"),
  pathsCollapsible: document.getElementById("paths-collapsible"),
  remoteInsertCollapsible: document.getElementById("remote-insert-collapsible"),
  jobHistoryCount: document.getElementById("job-history-count"),
  saveJobDialog: document.getElementById("save-job-dialog"),
  saveJobName: document.getElementById("save-job-name"),
  saveJobConfirm: document.getElementById("save-job-confirm"),
  saveJobCancel: document.getElementById("save-job-cancel"),
  snackbarRoot: document.getElementById("snackbar-root"),
  snackbar: document.getElementById("snackbar"),
  snackbarIcon: document.getElementById("snackbar-icon"),
  snackbarTitle: document.getElementById("snackbar-title"),
  snackbarMessage: document.getElementById("snackbar-message"),
};

const outputPanel = new JobOutputPanel(document.querySelector(".output-panel"));

let activeJobId = null;
let remotes = [];
let jobHistory = [];
let statusHideTimeout = null;
let statusFadeTimeout = null;
let popupHideTimeout = null;
let snackbarHideTimeout = null;
let snackbarLeaveTimeout = null;
const STATUS_FADE_MS = 450;
const POPUP_AUTO_CLOSE_MS = 3500;
const SNACKBAR_DURATION_MS = 3400;
const SNACKBAR_LEAVE_MS = 220;

function hideSnackbar() {
  if (snackbarHideTimeout) {
    clearTimeout(snackbarHideTimeout);
    snackbarHideTimeout = null;
  }

  if (snackbarLeaveTimeout) {
    clearTimeout(snackbarLeaveTimeout);
    snackbarLeaveTimeout = null;
  }

  elements.snackbar.classList.remove("success", "error", "running", "is-leaving");
  elements.snackbarIcon.textContent = "";
  elements.snackbarTitle.textContent = "";
  elements.snackbarMessage.textContent = "";
  elements.snackbarRoot.classList.add("hidden");
  elements.snackbarRoot.setAttribute("aria-hidden", "true");
}

function showSnackbar({ title, message, type = "success" }) {
  hideSnackbar();

  const icons = {
    success: "✓",
    error: "!",
    running: "▶",
  };
  elements.snackbarIcon.textContent = icons[type] || "•";
  elements.snackbarTitle.textContent = title;
  elements.snackbarMessage.innerHTML = message;
  elements.snackbar.classList.add(type);
  elements.snackbarRoot.classList.remove("hidden");
  elements.snackbarRoot.setAttribute("aria-hidden", "false");

  snackbarHideTimeout = setTimeout(() => {
    elements.snackbar.classList.add("is-leaving");
    snackbarLeaveTimeout = setTimeout(hideSnackbar, SNACKBAR_LEAVE_MS);
    snackbarHideTimeout = null;
  }, SNACKBAR_DURATION_MS);
}

function hidePopup() {
  if (popupHideTimeout) {
    clearTimeout(popupHideTimeout);
    popupHideTimeout = null;
  }

  elements.popupRoot.classList.add("hidden");
  elements.popupRoot.setAttribute("aria-hidden", "true");
  elements.popupCard.classList.remove("success", "error");
}

function showPopup({ title, message, type = "success", autoClose = true }) {
  hidePopup();

  elements.popupTitle.textContent = title;
  elements.popupMessage.textContent = message;
  elements.popupCard.classList.add(type);
  elements.popupRoot.classList.remove("hidden");
  elements.popupRoot.setAttribute("aria-hidden", "false");
  elements.popupClose.focus();

  if (autoClose) {
    popupHideTimeout = setTimeout(hidePopup, POPUP_AUTO_CLOSE_MS);
  }
}

function clearStatusTimeouts() {
  if (statusHideTimeout) {
    clearTimeout(statusHideTimeout);
    statusHideTimeout = null;
  }

  if (statusFadeTimeout) {
    clearTimeout(statusFadeTimeout);
    statusFadeTimeout = null;
  }
}

function ensureStatusVisible() {
  if (!elements.status?.textContent) {
    return;
  }

  elements.status.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function setStatus(text, tone = "", options = {}) {
  clearStatusTimeouts();
  elements.status.classList.remove("is-fading-out");
  elements.status.textContent = text;
  elements.status.className = `status ${tone}`.trim();

  if (text && options.ensureVisible) {
    requestAnimationFrame(() => ensureStatusVisible());
  }

  if (options.hideAfter) {
    statusHideTimeout = setTimeout(() => {
      elements.status.classList.add("is-fading-out");
      statusFadeTimeout = setTimeout(() => {
        elements.status.textContent = "";
        elements.status.className = "status";
        statusFadeTimeout = null;
      }, STATUS_FADE_MS);
      statusHideTimeout = null;
    }, options.hideAfter);
  }
}



function setRunning(isRunning) {
  elements.runJob.disabled = isRunning;
  elements.stopJob.disabled = !isRunning;
  elements.operation.disabled = isRunning;
  elements.source.disabled = isRunning;
  elements.destination.disabled = isRunning;
  elements.dryRun.disabled = isRunning;
  elements.deleteExcluded.disabled = isRunning || elements.operation.value !== "sync";
  elements.resync.disabled = isRunning;
  elements.extraArgs.disabled = isRunning;
  elements.jobHistoryPicker.disabled = isRunning;
  elements.loadJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  elements.updateJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  elements.saveJob.disabled = isRunning;
  elements.deleteJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  elements.scheduleJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  if (elements.manageRemotes) {
    elements.manageRemotes.disabled = isRunning;
  }
}

function getCurrentJobConfig() {
  return {
    operation: elements.operation.value,
    source: elements.source.value.trim(),
    destination: elements.destination.value.trim(),
    dryRun: elements.dryRun.checked,
    deleteExcluded: elements.deleteExcluded.checked,
    resync: elements.operation.value === "bisync" && elements.resync.checked,
    extraArgs: elements.extraArgs.value.trim(),
  };
}

function formatRelativeTime(timestamp) {
  if (!timestamp) {
    return "never run";
  }

  const deltaMs = Date.now() - timestamp;
  const minutes = Math.floor(deltaMs / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatJobOptionLabel(entry) {
  return entry.schedule?.enabled ? `⏰ ${entry.name}` : entry.name;
}

function formatJobMeta(entry) {
  if (!entry) {
    return "";
  }

  const parts = [
    `${entry.operation} · ${entry.source} → ${entry.destination}`,
  ];

  if (entry.schedule?.enabled) {
    const next = entry.schedule.nextRunAt
      ? `, next run ${window.JobSchedule.formatNextRun(entry.schedule.nextRunAt)}`
      : "";
    parts.push(`⏰ ${entry.schedule.description || "Scheduled"}${next}`);
  }

  parts.push(`Last run ${formatRelativeTime(entry.lastRunAt)}`);

  if (entry.runCount > 0) {
    parts.push(`${entry.runCount} run${entry.runCount === 1 ? "" : "s"}`);
  }

  if (entry.lastRunSuccess === true) {
    parts.push("last: success");
  } else if (entry.lastRunSuccess === false) {
    parts.push("last: failed");
  }

  if (entry.dryRun) {
    parts.push("dry run");
  }

  if (entry.deleteExcluded) {
    parts.push("delete excluded");
  }

  if (entry.extraArgs) {
    const preview = entry.extraArgs.length > 48
      ? `${entry.extraArgs.slice(0, 47)}…`
      : entry.extraArgs;
    parts.push(`flags: ${preview}`);
  }

  return parts.join(" · ");
}

function getSelectedHistoryEntry() {
  const selectedId = elements.jobHistoryPicker.value;
  if (!selectedId) {
    return null;
  }

  return jobHistory.find((entry) => entry.id === selectedId) || null;
}

function savedJobMatchesForm(entry) {
  if (!entry) {
    return false;
  }

  const job = getCurrentJobConfig();
  return (
    entry.operation === job.operation &&
    entry.source === job.source &&
    entry.destination === job.destination &&
    entry.dryRun === job.dryRun &&
    entry.deleteExcluded === job.deleteExcluded &&
    (entry.extraArgs || "") === job.extraArgs
  );
}

function applyJobToForm(entry, { fromSavedJob = false } = {}) {
  elements.operation.value = entry.operation;
  elements.source.value = entry.source;
  elements.destination.value = entry.destination;
  elements.dryRun.checked = entry.dryRun;
  elements.deleteExcluded.checked = entry.deleteExcluded;
  elements.resync.checked = false;
  elements.extraArgs.value = entry.extraArgs || "";
  elements.operation.dispatchEvent(new Event("change"));

  if (fromSavedJob) {
    elements.pathsCollapsible.open = true;
    elements.remoteInsertCollapsible.open = false;
  }
}

function updateHistoryActions() {
  const entry = getSelectedHistoryEntry();
  const hasSelection = Boolean(entry);
  const isRunning = activeJobId !== null;

  elements.loadJob.disabled = isRunning || !hasSelection;
  elements.updateJob.disabled = isRunning || !hasSelection || savedJobMatchesForm(entry);
  elements.deleteJob.disabled = isRunning || !hasSelection;
  elements.scheduleJob.disabled = isRunning || !hasSelection;
  elements.jobHistoryMeta.textContent = entry ? formatJobMeta(entry) : "";
}

function updateJobHistoryCount() {
  if (jobHistory.length === 0) {
    elements.jobHistoryCount.textContent = "";
    return;
  }

  const scheduled = jobHistory.filter((entry) => entry.schedule?.enabled).length;
  elements.jobHistoryCount.textContent = `${jobHistory.length} job${jobHistory.length === 1 ? "" : "s"}${scheduled ? ` · ${scheduled} scheduled` : ""}`;
}

function fillJobHistoryPicker(selectedId = "") {
  const current = selectedId || elements.jobHistoryPicker.value;
  elements.jobHistoryPicker.innerHTML = '<option value="">Select a job to load…</option>';

  for (const entry of jobHistory) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = formatJobOptionLabel(entry);
    elements.jobHistoryPicker.appendChild(option);
  }

  if (jobHistory.some((entry) => entry.id === current)) {
    elements.jobHistoryPicker.value = current;
  }

  updateJobHistoryCount();
  updateHistoryActions();
}

async function refreshJobHistory(selectedId = "") {
  jobHistory = await window.rcloneGui.listJobs();
  fillJobHistoryPicker(selectedId);
}

const runWarnings = {
  sync: "Files in the destination that aren't in the source will be deleted.",
  move: "Files are deleted from the source after they're transferred.",
  bisync: "Changes and deletions on either side are applied to the other side.",
};

function confirmRunCommand(job, command) {
  const dialog = document.getElementById("run-confirm-dialog");
  const message = document.getElementById("run-confirm-message");
  const commandBlock = document.getElementById("run-confirm-command");
  const copyBtn = document.getElementById("run-confirm-copy");
  const cancelBtn = document.getElementById("run-confirm-cancel");
  const startBtn = document.getElementById("run-confirm-start");
  const remember = document.getElementById("run-confirm-remember");
  const backdrop = dialog.querySelector("[data-run-confirm-close]");

  message.textContent = job.dryRun
    ? "Dry run: rclone will only report what it would do. Nothing will be changed."
    : runWarnings[job.operation] || "This is the exact command Glasswing will run.";
  commandBlock.textContent = command;
  copyBtn.textContent = "Copy command";
  remember.checked = false;
  dialog.classList.remove("hidden");
  dialog.setAttribute("aria-hidden", "false");
  startBtn.focus();

  return new Promise((resolve) => {
    const finish = (confirmed) => {
      dialog.classList.add("hidden");
      dialog.setAttribute("aria-hidden", "true");
      startBtn.removeEventListener("click", onStart);
      cancelBtn.removeEventListener("click", onCancel);
      backdrop.removeEventListener("click", onCancel);
      copyBtn.removeEventListener("click", onCopy);
      document.removeEventListener("keydown", onKeydown, true);
      resolve({ confirmed, remember: confirmed && remember.checked });
    };
    const onStart = () => finish(true);
    const onCancel = () => finish(false);
    const onCopy = async () => {
      try {
        await navigator.clipboard.writeText(command);
        copyBtn.textContent = "Copied";
      } catch {
        copyBtn.textContent = "Copy failed";
      }
    };
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish(false);
      }
    };

    startBtn.addEventListener("click", onStart);
    cancelBtn.addEventListener("click", onCancel);
    backdrop.addEventListener("click", onCancel);
    copyBtn.addEventListener("click", onCopy);
    document.addEventListener("keydown", onKeydown, true);
  });
}

function hideSaveJobDialog() {
  elements.saveJobDialog.classList.add("hidden");
  elements.saveJobDialog.setAttribute("aria-hidden", "true");
  elements.saveJobName.value = "";
}

function showSaveJobDialog() {
  const job = getCurrentJobConfig();
  if (!job.source || !job.destination) {
    setStatus("Source and destination are required before saving.", "error");
    return;
  }

  elements.saveJobName.value = "";
  elements.saveJobDialog.classList.remove("hidden");
  elements.saveJobDialog.setAttribute("aria-hidden", "false");
  elements.saveJobName.focus();
}

async function confirmSaveJob() {
  const job = getCurrentJobConfig();
  if (!job.source || !job.destination) {
    setStatus("Source and destination are required before saving.", "error");
    return;
  }

  try {
    jobHistory = await window.rcloneGui.saveJob({
      ...job,
      name: elements.saveJobName.value.trim(),
    });
    hideSaveJobDialog();

    const savedEntry = jobHistory.find(
      (entry) =>
        entry.operation === job.operation &&
        entry.source === job.source &&
        entry.destination === job.destination &&
        entry.dryRun === job.dryRun &&
        entry.deleteExcluded === job.deleteExcluded &&
        (entry.extraArgs || "") === job.extraArgs,
    );

    fillJobHistoryPicker(savedEntry?.id || "");
    setStatus("Job saved for quick access.", "success", { hideAfter: 4000, ensureVisible: true });
    showPopup({
      title: "Job saved",
      message: "You can load or update it anytime from Saved jobs.",
      type: "success",
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
}

async function startJobFromForm() {
  const job = getCurrentJobConfig();

  if (!job.source || !job.destination) {
    setStatus("Source and destination are required.", "error");
    return;
  }

  let preview;
  try {
    preview = await window.rcloneGui.previewJobCommand(job);
  } catch (error) {
    setStatus(String(error.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""), "error");
    return;
  }

  if (!preview.approved) {
    const choice = await confirmRunCommand(job, preview.command);
    if (!choice.confirmed) {
      return;
    }
    if (choice.remember) {
      await window.rcloneGui.approveJobCommand(job).catch(() => {});
    }
  }

  setRunning(true);

  try {
    const result = await window.rcloneGui.startJob(job);
    activeJobId = result.id;

    outputPanel.startJob({
      operation: job.operation,
      source: job.source,
      destination: job.destination,
    });

    showSnackbar({
      title: "Job running",
      message: `${job.operation.charAt(0).toUpperCase() + job.operation.slice(1)} job started.`,
      type: "running",
    });
    await refreshJobHistory(elements.jobHistoryPicker.value);
  } catch (error) {
    setRunning(false);
    setStatus(error.message, "error");
  }
}



function formatRemotePath(remote, subPath) {

  const trimmedPath = subPath.trim().replace(/^\/+|\/+$/g, "");

  return trimmedPath ? `${remote}:${trimmedPath}` : `${remote}:`;

}



function fillRemotePicker() {

  const current = elements.remotePicker.value;

  elements.remotePicker.innerHTML = '<option value="">Select a configured remote...</option>';



  for (const remote of remotes) {

    const option = document.createElement("option");

    option.value = remote;

    option.textContent = remote;

    elements.remotePicker.appendChild(option);

  }



  if (remotes.includes(current)) {

    elements.remotePicker.value = current;

  }

}



function measureRequiredContentSize() {
  const app = document.querySelector(".app");
  const layout =
    document.querySelector(".layout:not(.hidden)") || document.querySelector(".layout");
  if (!app || !layout) {
    return null;
  }

  const panels = [...layout.querySelectorAll(":scope > .panel")];
  const savedStyles = [
    { element: app, minHeight: app.style.minHeight, height: app.style.height, flex: app.style.flex },
    { element: layout, minHeight: layout.style.minHeight, height: layout.style.height, flex: layout.style.flex },
    ...panels.map((panel) => ({
      element: panel,
      minHeight: panel.style.minHeight,
      height: panel.style.height,
      flex: panel.style.flex,
    })),
  ];

  app.style.minHeight = "0";
  app.style.height = "auto";
  app.style.flex = "0 0 auto";
  layout.style.minHeight = "0";
  layout.style.height = "auto";
  layout.style.flex = "0 0 auto";
  for (const panel of panels) {
    panel.style.minHeight = "0";
    panel.style.height = "auto";
  }

  void app.offsetHeight;

  const appTop = app.getBoundingClientRect().top;
  const paddingBottom = parseFloat(getComputedStyle(app).paddingBottom) || 0;
  let contentBottom = layout.getBoundingClientRect().bottom - appTop;

  if (elements.status?.textContent) {
    contentBottom = Math.max(
      contentBottom,
      elements.status.getBoundingClientRect().bottom - appTop,
    );
  }

  for (const { element, minHeight, height, flex } of savedStyles) {
    element.style.minHeight = minHeight;
    element.style.height = height;
    element.style.flex = flex;
  }

  return {
    width: Math.ceil(Math.max(app.scrollWidth, app.getBoundingClientRect().width)),
    height: Math.ceil(contentBottom + paddingBottom),
  };
}

async function checkRcloneVersion(retries = 3, delayMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const rcloneVersion = await window.rcloneGui.getRcloneVersion();
      return rcloneVersion;
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function syncMinimumWindowSize(forceSnap = false) {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const size = measureRequiredContentSize();
  if (!size || !window.rcloneGui?.fitWindowToContent) {
    return;
  }

  await window.rcloneGui.fitWindowToContent(
    { width: size.width },
    forceSnap,
  );
}



let updateReleaseUrl = "";

function hideUpdateDialog() {
  elements.updateDialog.classList.add("hidden");
  elements.updateDialog.setAttribute("aria-hidden", "true");
}

function showUpdateDialog({ currentVersion, latestVersion, publishedAt, releaseUrl }) {
  updateReleaseUrl = releaseUrl || "";
  elements.updateCurrent.textContent = `v${currentVersion}`;
  elements.updateLatest.textContent = `v${latestVersion}`;

  const published = publishedAt ? new Date(publishedAt) : null;
  elements.updateDate.textContent = published && !Number.isNaN(published.getTime())
    ? `Released ${published.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}`
    : "";

  elements.updateOpen.hidden = !updateReleaseUrl;
  elements.updateDialog.classList.remove("hidden");
  elements.updateDialog.setAttribute("aria-hidden", "false");
  (updateReleaseUrl ? elements.updateOpen : elements.updateLater).focus();
}

async function checkForUpdates() {
  try {
    const result = await window.rcloneGui.checkForUpdates();
    
    if (result.hasUpdate) {
      showUpdateDialog(result);
    } else {
      showSnackbar({
        title: "Up to date",
        message: `You're on the latest version (v${result.currentVersion}).`,
        type: "success",
      });
    }
  } catch (error) {
    showSnackbar({
      title: "Update check failed",
      message: error.message || "Could not check for updates",
      type: "error",
    });
  }
}
function setAppMode(mode) {
  const nextMode = mode === "browse" ? "browse" : "jobs";
  const browsing = nextMode === "browse";

  elements.jobsView?.classList.toggle("hidden", browsing);
  if (elements.jobsView) {
    elements.jobsView.hidden = browsing;
  }

  elements.modeJobs?.classList.toggle("is-active", !browsing);
  elements.modeBrowse?.classList.toggle("is-active", browsing);
  elements.modeJobs?.setAttribute("aria-selected", String(!browsing));
  elements.modeBrowse?.setAttribute("aria-selected", String(browsing));

  if (browsing) {
    // Re-sync in case remotes loaded while Browse was hidden, or init raced.
    window.RemoteBrowser?.setRemotes(remotes);
    window.RemoteBrowser?.show();
  } else {
    window.RemoteBrowser?.hide();
  }

  void syncMinimumWindowSize(false);
}

function useBrowsePath({ path, target }) {
  if (!path) {
    return;
  }

  if (target === "destination") {
    elements.destination.value = path;
  } else {
    elements.source.value = path;
  }

  setAppMode("jobs");
  updateHistoryActions();
  showSnackbar({
    title: target === "destination" ? "Destination set" : "Source set",
    message: path,
    type: "success",
  });
}

async function loadRemotes({ showFeedback = false } = {}) {
  if (!window.rcloneGui) {
    showSnackbar({
      title: "Reload failed",
      message: "App bridge unavailable.",
      type: "error",
    });
    return;
  }

  elements.refreshRemotes.disabled = true;

  try {
    remotes = await window.rcloneGui.listRemotes();
    fillRemotePicker();
    window.RemoteBrowser?.setRemotes(remotes);

    const countLabel = `${remotes.length} remote${remotes.length === 1 ? "" : "s"}`;

    if (showFeedback) {
      showSnackbar({
        title: "Remotes reloaded",
        message: `Successfully loaded ${countLabel}.`,
        type: "success",
      });
    }
  } catch (error) {
    showSnackbar({
      title: "Reload failed",
      message: error.message || "Could not list remotes.",
      type: "error",
    });
  } finally {
    elements.refreshRemotes.disabled = false;
  }
}



async function init() {
  try {
    if (!window.rcloneGui) {
      elements.version.textContent = "App bridge unavailable";
      setStatus("Restart the app to reload the interface.", "error");
      elements.runJob.disabled = true;
      return;
    }

    // Show the window immediately — never block the first paint on rclone I/O.
    await window.rcloneGui.showMainWindow();

    let rcloneVersion = "";
    elements.version.textContent = "Checking rclone…";
    window.rcloneGui.getAppVersion().then((version) => {
      elements.appVersion.textContent = `v${version}`;
    });
    const historyLoad = refreshJobHistory().catch(() => {});
    const remotesLoad = window.rcloneGui.listRemotes().then(
      (names) => ({ names }),
      (error) => ({ error }),
    );
    try {
      rcloneVersion = await checkRcloneVersion();
      elements.version.textContent = `${rcloneVersion} · loading remotes…`;
    } catch (error) {
      elements.version.textContent = "rclone not found on PATH";
      setStatus("Install rclone and ensure it is available on PATH.", "error");
      elements.runJob.disabled = true;
      return;
    }

    const [remotesResult] = await Promise.all([remotesLoad, historyLoad]);
    attachToRunningJob(await window.rcloneGui.getActiveJob().catch(() => null));
    if (remotesResult.error) {
      await loadRemotes({ showFeedback: false });
    } else {
      remotes = remotesResult.names;
      fillRemotePicker();
    }
    window.RemoteBrowser?.setRemotes(remotes);
    elements.version.textContent = rcloneVersion;
    elements.operation.dispatchEvent(new Event("change"));
  } finally {
    if (window.rcloneGui) {
      await syncMinimumWindowSize(true);
      await window.rcloneGui.showMainWindow();
    }
  }
}



elements.operation.addEventListener("change", () => {

  const operation = elements.operation.value;

  elements.operationHint.textContent = operationHints[operation];

  elements.deleteExcluded.disabled = operation !== "sync" || activeJobId !== null;

  elements.resyncOption.classList.toggle("hidden", operation !== "bisync");

  if (operation !== "bisync") {
    elements.resync.checked = false;
  }

});



document.querySelectorAll("[data-target]").forEach((button) => {

  button.addEventListener("click", async () => {

    const targetId = button.getAttribute("data-target");

    const folder = await window.rcloneGui.pickFolder();

    if (folder) {

      document.getElementById(targetId).value = folder;

    }

  });

});



document.getElementById("insert-remote-source").addEventListener("click", () => {

  const remote = elements.remotePicker.value;

  if (!remote) {

    setStatus("Pick a remote first.", "error");

    return;

  }



  elements.source.value = formatRemotePath(remote, elements.remotePath.value);

});



document.getElementById("insert-remote-dest").addEventListener("click", () => {

  const remote = elements.remotePicker.value;

  if (!remote) {

    setStatus("Pick a remote first.", "error");

    return;

  }



  elements.destination.value = formatRemotePath(remote, elements.remotePath.value);

});



elements.refreshRemotes.addEventListener("click", () => loadRemotes({ showFeedback: true }));

elements.modeJobs?.addEventListener("click", () => setAppMode("jobs"));
elements.modeBrowse?.addEventListener("click", () => setAppMode("browse"));

window.RemoteBrowser?.init({
  onUsePath: useBrowsePath,
  onNotify: showSnackbar,
});

elements.manageRemotes?.addEventListener("click", () => {
  window.RemoteManager?.open({
    onChanged: async (names) => {
      remotes = names;
      fillRemotePicker();
      window.RemoteBrowser?.setRemotes(remotes);
    },
    onBrowse: (name) => {
      setAppMode("browse");
      const picker = document.getElementById("browse-remote-picker");
      if (picker && [...picker.options].some((option) => option.value === name)) {
        picker.value = name;
        picker.dispatchEvent(new Event("change"));
      }
    },
  });
});
elements.popupClose.addEventListener("click", hidePopup);
elements.updateLater.addEventListener("click", hideUpdateDialog);
elements.updateDialog.querySelector("[data-update-close]").addEventListener("click", hideUpdateDialog);
elements.updateOpen.addEventListener("click", () => {
  if (updateReleaseUrl) {
    void window.rcloneGui.openReleasePage(updateReleaseUrl);
  }
  hideUpdateDialog();
});
elements.popupRoot.querySelector("[data-popup-close]").addEventListener("click", hidePopup);

elements.jobHistoryPicker.addEventListener("change", updateHistoryActions);

for (const input of [
  elements.operation,
  elements.source,
  elements.destination,
  elements.dryRun,
  elements.deleteExcluded,
  elements.extraArgs,
]) {
  input.addEventListener("input", updateHistoryActions);
  input.addEventListener("change", updateHistoryActions);
}

elements.loadJob.addEventListener("click", () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  applyJobToForm(entry, { fromSavedJob: true });
  elements.jobHistoryCollapsible.open = false;
  showSnackbar({
    title: "Job loaded",
    message: `"${entry.name}" has been loaded.`,
    type: "success",
  });
});

elements.updateJob.addEventListener("click", async () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  const job = getCurrentJobConfig();
  if (!job.source || !job.destination) {
    setStatus("Source and destination are required.", "error");
    return;
  }

  try {
    jobHistory = await window.rcloneGui.updateJob(entry.id, job);
    fillJobHistoryPicker(entry.id);
    showSnackbar({
      title: "Job updated",
      message: `"${entry.name}" now matches the current form.`,
      type: "success",
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.saveJob.addEventListener("click", showSaveJobDialog);
elements.saveJobConfirm.addEventListener("click", () => {
  void confirmSaveJob();
});
elements.saveJobCancel.addEventListener("click", hideSaveJobDialog);
elements.saveJobDialog.querySelector("[data-save-dialog-close]").addEventListener("click", hideSaveJobDialog);

elements.saveJobName.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void confirmSaveJob();
  }
});

elements.scheduleJob.addEventListener("click", () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  void window.JobSchedule.open(entry, {
    onSaved: (saved, jobs) => {
      jobHistory = jobs;
      fillJobHistoryPicker(entry.id);
      showSnackbar({
        title: saved?.schedule?.enabled ? "Job scheduled" : "Schedule turned off",
        message: saved?.schedule?.enabled
          ? `<strong>${escapeHtml(entry.name)}</strong> runs next ${escapeHtml(window.JobSchedule.formatNextRun(saved.schedule.nextRunAt))}.`
          : `<strong>${escapeHtml(entry.name)}</strong> only runs when you start it.`,
        type: "success",
      });
    },
  });
});

elements.deleteJob.addEventListener("click", async () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  try {
    jobHistory = await window.rcloneGui.deleteJob(entry.id);
    fillJobHistoryPicker();
    setStatus("Saved job removed.", "success", {
      hideAfter: 4000,
      ensureVisible: true,
    });
  } catch (error) {
    setStatus(error.message, "error");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!elements.saveJobDialog.classList.contains("hidden")) {
      hideSaveJobDialog();
      return;
    }

    if (!elements.updateDialog.classList.contains("hidden")) {
      hideUpdateDialog();
      return;
    }

    if (!elements.popupRoot.classList.contains("hidden")) {
      hidePopup();
    }
  }
});

elements.runJob.addEventListener("click", () => {
  void startJobFromForm();
});



elements.stopJob.addEventListener("click", async () => {
  showSnackbar({
    title: "Stopping job",
    message: "Waiting for rclone to finish…",
    type: "running",
  });
  await window.rcloneGui.stopJob();
});

elements.checkForUpdates.addEventListener("click", () => {
  void checkForUpdates();
});



function attachToRunningJob(job) {
  if (!job || activeJobId !== null) {
    return;
  }

  activeJobId = job.id;
  setRunning(true);
  outputPanel.startJob({
    operation: job.operation,
    source: job.source,
    destination: job.destination,
  });

  if (job.scheduled) {
    showSnackbar({
      title: "Scheduled job running",
      message: `<strong>${escapeHtml(job.scheduled.name)}</strong> started on schedule.`,
      type: "running",
    });
  }
}

window.rcloneGui.onJobStarted((job) => {
  if (!job.scheduled) {
    return;
  }

  attachToRunningJob(job);
  void refreshJobHistory(elements.jobHistoryPicker.value);
});

window.rcloneGui.onSchedulesChanged(() => {
  void refreshJobHistory(elements.jobHistoryPicker.value);
});

window.rcloneGui.onJobOutput(({ id, text }) => {

  if (id !== activeJobId) {

    return;

  }



  outputPanel.appendOutput(text);

});



function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

window.rcloneGui.onMountsChanged?.(({ event }) => {
  if (!event) {
    return;
  }

  const remote = escapeHtml(event.remote);
  const mountPoint = escapeHtml(event.mountPoint);
  if (event.type === "mounted") {
    showSnackbar({
      title: "Drive mounted",
      message: `<strong>${remote}</strong> is now available as ${mountPoint}`,
      type: "success",
    });
  } else if (event.unexpected) {
    showPopup({
      title: `${event.mountPoint} was unmounted`,
      message: `The mount for "${event.remote}" stopped unexpectedly. ${event.message}`,
      type: "error",
      autoClose: false,
    });
  } else {
    showSnackbar({
      title: "Drive unmounted",
      message: `${mountPoint} (<strong>${remote}</strong>) is no longer mounted`,
      type: "success",
    });
  }
});

window.rcloneGui.onJobFinished(({ id, success, message, cancelled, needsResync }) => {

  if (id !== activeJobId) {

    return;

  }



  outputPanel.flush();

  activeJobId = null;

  setRunning(false);

  outputPanel.finishJob({ success, message, cancelled });

  if (needsResync && elements.operation.value === "bisync") {
    elements.resync.checked = true;
  } else if (success) {
    elements.resync.checked = false;
  }

  if (cancelled) {
    showSnackbar({
      title: "Job cancelled",
      message: message || "The job was stopped.",
      type: "running",
    });
  } else if (success) {
    showSnackbar({
      title: "Job completed",
      message: message || "The job finished successfully.",
      type: "success",
    });
  } else {
    showSnackbar({
      title: "Job failed",
      message: message || "The job ended with errors.",
      type: "error",
    });
  }

  void refreshJobHistory(elements.jobHistoryPicker.value);
});



init();


