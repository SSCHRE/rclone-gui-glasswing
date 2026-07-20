const operationHints = {

  copy: "Copy adds or updates files in the destination.",

  sync: "Sync makes the destination match the source. Destructive on the destination side.",

  move: "Move transfers files and deletes them from the source when done.",

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

  runJob: document.getElementById("run-job"),

  stopJob: document.getElementById("stop-job"),

  refreshRemotes: document.getElementById("refresh-remotes"),

  status: document.getElementById("status"),
  popupRoot: document.getElementById("popup-root"),
  popupCard: document.querySelector(".popup-card"),
  popupTitle: document.getElementById("popup-title"),
  popupMessage: document.getElementById("popup-message"),
  popupClose: document.getElementById("popup-close"),
  jobHistoryPicker: document.getElementById("job-history-picker"),
  loadJob: document.getElementById("load-job"),
  runSavedJob: document.getElementById("run-saved-job"),
  saveJob: document.getElementById("save-job"),
  deleteJob: document.getElementById("delete-job"),
  jobHistoryMeta: document.getElementById("job-history-meta"),
  jobHistoryCollapsible: document.getElementById("job-history-collapsible"),
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

  elements.snackbar.classList.remove("success", "error", "is-leaving");
  elements.snackbarIcon.textContent = "";
  elements.snackbarTitle.textContent = "";
  elements.snackbarMessage.textContent = "";
  elements.snackbarRoot.classList.add("hidden");
  elements.snackbarRoot.setAttribute("aria-hidden", "true");
}

function showSnackbar({ title, message, type = "success" }) {
  hideSnackbar();

  elements.snackbarIcon.textContent = type === "success" ? "✓" : "!";
  elements.snackbarTitle.textContent = title;
  elements.snackbarMessage.textContent = message;
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
  elements.jobHistoryPicker.disabled = isRunning;
  elements.loadJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  elements.runSavedJob.disabled = isRunning || !elements.jobHistoryPicker.value;
  elements.saveJob.disabled = isRunning;
  elements.deleteJob.disabled = isRunning || !elements.jobHistoryPicker.value;
}

function getCurrentJobConfig() {
  return {
    operation: elements.operation.value,
    source: elements.source.value.trim(),
    destination: elements.destination.value.trim(),
    dryRun: elements.dryRun.checked,
    deleteExcluded: elements.deleteExcluded.checked,
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
  return entry.name;
}

function formatJobMeta(entry) {
  if (!entry) {
    return "";
  }

  const parts = [
    `${entry.operation} · ${entry.source} → ${entry.destination}`,
    `Last run ${formatRelativeTime(entry.lastRunAt)}`,
  ];

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

  return parts.join(" · ");
}

function getSelectedHistoryEntry() {
  const selectedId = elements.jobHistoryPicker.value;
  if (!selectedId) {
    return null;
  }

  return jobHistory.find((entry) => entry.id === selectedId) || null;
}

function applyJobToForm(entry) {
  elements.operation.value = entry.operation;
  elements.source.value = entry.source;
  elements.destination.value = entry.destination;
  elements.dryRun.checked = entry.dryRun;
  elements.deleteExcluded.checked = entry.deleteExcluded;
  elements.operation.dispatchEvent(new Event("change"));
}

function updateHistoryActions() {
  const entry = getSelectedHistoryEntry();
  const hasSelection = Boolean(entry);
  const isRunning = activeJobId !== null;

  elements.loadJob.disabled = isRunning || !hasSelection;
  elements.runSavedJob.disabled = isRunning || !hasSelection;
  elements.deleteJob.disabled = isRunning || !hasSelection;
  elements.jobHistoryMeta.textContent = entry ? formatJobMeta(entry) : "";
}

function updateJobHistoryCount() {
  if (jobHistory.length === 0) {
    elements.jobHistoryCount.textContent = "";
    return;
  }

  elements.jobHistoryCount.textContent = `${jobHistory.length} job${jobHistory.length === 1 ? "" : "s"}`;
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
        entry.deleteExcluded === job.deleteExcluded,
    );

    fillJobHistoryPicker(savedEntry?.id || "");
    setStatus("Job saved for quick access.", "success", { hideAfter: 4000, ensureVisible: true });
    showPopup({
      title: "Job saved",
      message: "You can load or run it anytime from Saved & recent jobs.",
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

  setRunning(true);

  try {
    const result = await window.rcloneGui.startJob(job);
    activeJobId = result.id;

    outputPanel.startJob({
      operation: job.operation,
      source: job.source,
      destination: job.destination,
    });

    setStatus("Job running.", "running", { hideAfter: 5000, ensureVisible: true });
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
  const layout = document.querySelector(".layout");
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


async function loadRemotes({ showFeedback = false } = {}) {
  if (!window.rcloneGui) {
    const message = "App bridge unavailable.";
    if (showFeedback) {
      showPopup({ title: "Reload failed", message, type: "error", autoClose: false });
    } else {
      setStatus(message, "error");
    }
    return;
  }

  elements.refreshRemotes.disabled = true;

  try {
    remotes = await window.rcloneGui.listRemotes();
    fillRemotePicker();

    const countLabel = `${remotes.length} remote${remotes.length === 1 ? "" : "s"}`;

    if (showFeedback) {
      showPopup({
        title: "Remotes reloaded",
        message: `Successfully loaded ${countLabel}.`,
        type: "success",
      });
    } else {
      setStatus(`Loaded ${countLabel}.`, "", { hideAfter: 5000 });
    }
  } catch (error) {
    if (showFeedback) {
      showPopup({
        title: "Reload failed",
        message: error.message || "Could not list remotes.",
        type: "error",
        autoClose: false,
      });
    } else {
      setStatus(`Could not list remotes: ${error.message}`, "error");
    }
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

    try {
      elements.appVersion.textContent = `v${await window.rcloneGui.getAppVersion()}`;
      elements.version.textContent = await window.rcloneGui.getRcloneVersion();
    } catch (error) {
      elements.version.textContent = "rclone not found on PATH";
      setStatus("Install rclone and ensure it is available on PATH.", "error");
      elements.runJob.disabled = true;
      return;
    }

    await loadRemotes();
    await refreshJobHistory();
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
elements.popupClose.addEventListener("click", hidePopup);
elements.popupRoot.querySelector("[data-popup-close]").addEventListener("click", hidePopup);

elements.jobHistoryPicker.addEventListener("change", updateHistoryActions);

elements.loadJob.addEventListener("click", () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  applyJobToForm(entry);
  elements.jobHistoryCollapsible.open = false;
  showSnackbar({
    title: "Job loaded",
    message: `"${entry.name}" has been loaded!.`,
    type: "success",
  });
});

elements.runSavedJob.addEventListener("click", async () => {
  const entry = getSelectedHistoryEntry();
  if (!entry) {
    return;
  }

  applyJobToForm(entry);
  await startJobFromForm();
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

    if (!elements.popupRoot.classList.contains("hidden")) {
      hidePopup();
    }
  }
});

elements.runJob.addEventListener("click", () => {
  void startJobFromForm();
});



elements.stopJob.addEventListener("click", async () => {
  setStatus("Job ending.", "running", { hideAfter: 5000, ensureVisible: true });
  await window.rcloneGui.stopJob();
});



window.rcloneGui.onJobOutput(({ id, text }) => {

  if (id !== activeJobId) {

    return;

  }



  outputPanel.appendOutput(text);

});



window.rcloneGui.onJobFinished(({ id, success, message, cancelled }) => {

  if (id !== activeJobId) {

    return;

  }



  outputPanel.flush();

  activeJobId = null;

  setRunning(false);

  outputPanel.finishJob({ success, message, cancelled });

  const tone = cancelled ? "running" : success ? "success" : "error";
  setStatus("Job ended.", tone, { hideAfter: 5000, ensureVisible: true });
  void refreshJobHistory(elements.jobHistoryPicker.value);
});



init();


