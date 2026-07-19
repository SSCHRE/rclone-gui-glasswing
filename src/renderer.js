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

  clearLog: document.getElementById("clear-log"),

  status: document.getElementById("status"),
  popupRoot: document.getElementById("popup-root"),
  popupCard: document.querySelector(".popup-card"),
  popupTitle: document.getElementById("popup-title"),
  popupMessage: document.getElementById("popup-message"),
  popupClose: document.getElementById("popup-close"),
};

const outputPanel = new JobOutputPanel(document.querySelector(".output-panel"));

let activeJobId = null;
let remotes = [];
let statusHideTimeout = null;
let statusFadeTimeout = null;
let popupHideTimeout = null;
const STATUS_FADE_MS = 450;
const POPUP_AUTO_CLOSE_MS = 3500;

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

function setStatus(text, tone = "", options = {}) {
  clearStatusTimeouts();
  elements.status.classList.remove("is-fading-out");
  elements.status.textContent = text;
  elements.status.className = `status ${tone}`.trim();

  if (text && !options.hideAfter) {
    queueMinimumWindowSizeSync();
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

  elements.deleteExcluded.disabled = isRunning;

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



let syncMinSizeQueued = false;
const MIN_SIZE_BUFFER = 64;

function withNaturalLayout(measureFn) {
  const targets = [
    document.querySelector(".app"),
    document.querySelector(".layout"),
    document.querySelector(".panel-form"),
    document.querySelector(".output-panel"),
  ].filter(Boolean);

  const saved = targets.map((element) => ({
    element,
    height: element.style.height,
    maxHeight: element.style.maxHeight,
    minHeight: element.style.minHeight,
    flex: element.style.flex,
    alignSelf: element.style.alignSelf,
  }));

  for (const { element } of saved) {
    element.style.height = "auto";
    element.style.maxHeight = "none";
    element.style.minHeight = "0";
    element.style.flex = "none";
    element.style.alignSelf = "start";
  }

  const result = measureFn();

  for (const { element, height, maxHeight, minHeight, flex, alignSelf } of saved) {
    element.style.height = height;
    element.style.maxHeight = maxHeight;
    element.style.minHeight = minHeight;
    element.style.flex = flex;
    element.style.alignSelf = alignSelf;
  }

  return result;
}

function measureRequiredContentSize() {
  return withNaturalLayout(() => {
    const app = document.querySelector(".app");
    const status = elements.status;

    if (!app) {
      return null;
    }

    const appRect = app.getBoundingClientRect();
    const appStyle = getComputedStyle(app);
    const paddingBottom = parseFloat(appStyle.paddingBottom);
    let height = appRect.height;

    if (status?.textContent) {
      const form = document.querySelector(".panel-form");
      const statusBottom = status.getBoundingClientRect().bottom - appRect.top + paddingBottom;

      if (form) {
        const formBottom = form.getBoundingClientRect().bottom - appRect.top + paddingBottom;
        height = Math.max(height, formBottom, statusBottom);
      } else {
        height = Math.max(height, statusBottom);
      }
    }

    return {
      width: Math.ceil(app.scrollWidth),
      height: Math.ceil(height + MIN_SIZE_BUFFER),
    };
  });
}

function measureStatusClipPadding() {
  const status = elements.status;
  const form = document.querySelector(".panel-form");

  if (!status?.textContent || !form) {
    return 0;
  }

  const overflow = status.getBoundingClientRect().bottom - form.getBoundingClientRect().bottom;
  return overflow > 0 ? Math.ceil(overflow) + 16 : 0;
}

async function syncMinimumWindowSize() {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let size = measureRequiredContentSize();
  if (!size) {
    return;
  }

  let probe = await window.rcloneGui.probeMinimumContentSize(size);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  let clipPadding = measureStatusClipPadding();
  if (clipPadding > 0) {
    size = {
      width: size.width,
      height: size.height + clipPadding,
    };
    probe = await window.rcloneGui.probeMinimumContentSize(size);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    clipPadding = measureStatusClipPadding();
    if (clipPadding > 0) {
      size.height += clipPadding;
      await window.rcloneGui.setMinimumContentSize(size);
    }
  }

  if (probe && probe.restoreHeight > probe.minHeight) {
    await window.rcloneGui.restoreContentSize({
      width: probe.restoreWidth,
      height: probe.restoreHeight,
    });
  }
}

function queueMinimumWindowSizeSync() {
  if (syncMinSizeQueued) {
    return;
  }

  syncMinSizeQueued = true;
  requestAnimationFrame(() => {
    syncMinSizeQueued = false;
    void syncMinimumWindowSize();
  });
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
      setStatus(`Loaded ${countLabel}.`);
    }

    await syncMinimumWindowSize();
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

    await syncMinimumWindowSize();
  } finally {
    elements.refreshRemotes.disabled = false;
  }
}



async function init() {
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
  elements.operation.dispatchEvent(new Event("change"));
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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.popupRoot.classList.contains("hidden")) {
    hidePopup();
  }
});

elements.clearLog.addEventListener("click", () => {

  outputPanel.clear();
});



elements.runJob.addEventListener("click", async () => {

  const source = elements.source.value.trim();

  const destination = elements.destination.value.trim();



  if (!source || !destination) {

    setStatus("Source and destination are required.", "error");

    return;

  }



  setRunning(true);

  try {

    const result = await window.rcloneGui.startJob({

      operation: elements.operation.value,

      source,

      destination,

      dryRun: elements.dryRun.checked,

      deleteExcluded: elements.deleteExcluded.checked,

    });



    activeJobId = result.id;

    outputPanel.startJob({
      operation: elements.operation.value,
      source,
      destination,
    });

    setStatus("Job running.", "running", { hideAfter: 5000 });
  } catch (error) {

    setRunning(false);

    setStatus(error.message, "error");

  }

});



elements.stopJob.addEventListener("click", async () => {
  setStatus("Job ending.", "running", { hideAfter: 5000 });
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
  setStatus("Job ended.", tone, { hideAfter: 5000 });
});



init();


