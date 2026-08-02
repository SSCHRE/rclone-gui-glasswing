(() => {
const remoteBrowser = {
  view: document.getElementById("browse-view"),
  remotePicker: document.getElementById("browse-remote-picker"),
  upBtn: document.getElementById("browse-up"),
  refreshBtn: document.getElementById("browse-refresh"),
  breadcrumbs: document.getElementById("browse-breadcrumbs"),
  entriesBody: document.getElementById("browse-entries"),
  empty: document.getElementById("browse-empty"),
  status: document.getElementById("browse-status"),
  loading: document.getElementById("browse-loading"),
  selectionLabel: document.getElementById("browse-selection"),
  downloadBtn: document.getElementById("browse-download"),
  copyPathBtn: document.getElementById("browse-copy-path"),
  useSourceBtn: document.getElementById("browse-use-source"),
  useDestBtn: document.getElementById("browse-use-dest"),
};

let browseRemotes = [];
let currentRemote = "";
let currentSubPath = "";
let entries = [];
let selectedPath = null;
let selectedIsDir = false;
let loading = false;
let loadToken = 0;
let onUsePath = null;
let onNotify = null;

function notify(payload) {
  if (typeof onNotify === "function") {
    onNotify(payload);
  }
}

function formatRemotePath(remote, subPath = "") {
  const trimmed = String(subPath || "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\\/g, "/");
  return trimmed ? `${remote}:${trimmed}` : `${remote}:`;
}

function joinSubPath(base, name) {
  const parts = [base, name]
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  return parts;
}

function parentSubPath(subPath) {
  const trimmed = String(subPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split("/");
  parts.pop();
  return parts.join("/");
}

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

function formatModTime(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function currentPath() {
  if (!currentRemote) {
    return "";
  }
  return formatRemotePath(currentRemote, currentSubPath);
}

function activePath() {
  return selectedPath || currentPath();
}

function setStatus(message = "", isError = false) {
  if (!message) {
    remoteBrowser.status.textContent = "";
    remoteBrowser.status.classList.add("hidden");
    remoteBrowser.status.classList.remove("is-error");
    return;
  }

  remoteBrowser.status.textContent = message;
  remoteBrowser.status.classList.toggle("is-error", isError);
  remoteBrowser.status.classList.remove("hidden");
}

function setLoading(isLoading, label = "Loading…") {
  loading = isLoading;
  if (!remoteBrowser.loading) {
    return;
  }

  remoteBrowser.loading.classList.toggle("hidden", !isLoading);
  remoteBrowser.loading.setAttribute("aria-busy", String(isLoading));
  const text = remoteBrowser.loading.querySelector(".browse-loading-text");
  if (text) {
    text.textContent = label;
  }
}

function updateActionState() {
  const path = activePath();
  const hasPath = Boolean(path);
  const canDownload = Boolean(selectedPath) && !selectedIsDir && !loading;
  if (remoteBrowser.downloadBtn) {
    remoteBrowser.downloadBtn.disabled = !canDownload;
  }
  remoteBrowser.copyPathBtn.disabled = !hasPath || loading;
  remoteBrowser.useSourceBtn.disabled = !hasPath || loading;
  remoteBrowser.useDestBtn.disabled = !hasPath || loading;
  remoteBrowser.upBtn.disabled = !currentRemote || !currentSubPath || loading;
  remoteBrowser.refreshBtn.disabled = !currentRemote || loading;
  remoteBrowser.remotePicker.disabled = loading;

  if (!currentRemote) {
    remoteBrowser.selectionLabel.textContent = "Nothing selected";
    return;
  }

  if (selectedPath) {
    remoteBrowser.selectionLabel.textContent = selectedIsDir
      ? `Folder: ${selectedPath}`
      : `File: ${selectedPath}`;
    return;
  }

  remoteBrowser.selectionLabel.textContent = "Nothing selected";
}

function renderBreadcrumbs() {
  remoteBrowser.breadcrumbs.innerHTML = "";

  if (!currentRemote) {
    return;
  }

  const root = document.createElement("button");
  root.type = "button";
  root.className = "browse-crumb";
  root.textContent = `${currentRemote}:`;
  root.addEventListener("click", () => {
    if (currentSubPath) {
      void navigateTo("");
    }
  });
  remoteBrowser.breadcrumbs.appendChild(root);

  const parts = currentSubPath ? currentSubPath.split("/").filter(Boolean) : [];
  let built = "";
  for (const part of parts) {
    built = joinSubPath(built, part);
    const crumbPath = built;
    const separator = document.createElement("span");
    separator.className = "browse-crumb-sep";
    separator.textContent = "/";
    separator.setAttribute("aria-hidden", "true");
    remoteBrowser.breadcrumbs.appendChild(separator);

    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "browse-crumb";
    crumb.textContent = part;
    crumb.addEventListener("click", () => {
      if (crumbPath !== currentSubPath) {
        void navigateTo(crumbPath);
      }
    });
    remoteBrowser.breadcrumbs.appendChild(crumb);
  }
}

function selectEntry(entry) {
  if (!entry) {
    selectedPath = null;
    selectedIsDir = false;
  } else {
    selectedPath = formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
    selectedIsDir = entry.isDir;
  }

  for (const row of remoteBrowser.entriesBody.querySelectorAll("tr")) {
    row.classList.toggle("is-selected", row.dataset.path === selectedPath);
  }
  updateActionState();
}

function renderEntries() {
  remoteBrowser.entriesBody.innerHTML = "";

  if (!currentRemote) {
    remoteBrowser.empty.textContent = "Select a remote to browse its files and folders.";
    remoteBrowser.empty.classList.remove("hidden");
  } else if (loading) {
    remoteBrowser.empty.classList.add("hidden");
  } else if (entries.length === 0) {
    remoteBrowser.empty.textContent = "This folder is empty.";
    remoteBrowser.empty.classList.remove("hidden");
  } else {
    remoteBrowser.empty.classList.add("hidden");
  }

  for (const entry of entries) {
    const row = document.createElement("tr");
    const entryPath = formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
    row.dataset.path = entryPath;
    row.dataset.isdir = entry.isDir ? "1" : "0";
    row.className = `browse-row${entry.isDir ? " is-dir" : " is-file"}`;
    row.tabIndex = 0;

    const nameCell = document.createElement("td");
    nameCell.className = "browse-col-name";
    const nameWrap = document.createElement("div");
    nameWrap.className = "browse-name-wrap";
    const icon = document.createElement("span");
    icon.className = `browse-entry-icon${entry.isDir ? " is-dir" : " is-file"}`;
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "browse-entry-name";
    name.textContent = entry.name;
    nameWrap.append(icon, name);
    nameCell.append(nameWrap);

    const sizeCell = document.createElement("td");
    sizeCell.className = "browse-col-size";
    sizeCell.textContent = entry.isDir ? "—" : formatBytes(entry.size);

    const modCell = document.createElement("td");
    modCell.className = "browse-col-modified";
    modCell.textContent = formatModTime(entry.modTime);

    row.append(nameCell, sizeCell, modCell);

    row.addEventListener("click", () => selectEntry(entry));
    row.addEventListener("dblclick", () => {
      if (entry.isDir) {
        void navigateTo(joinSubPath(currentSubPath, entry.name));
      } else {
        selectEntry(entry);
        void downloadSelectedFile();
      }
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (entry.isDir) {
          void navigateTo(joinSubPath(currentSubPath, entry.name));
        } else {
          selectEntry(entry);
          void downloadSelectedFile();
        }
      }
    });

    remoteBrowser.entriesBody.appendChild(row);
  }

  updateActionState();
}

async function loadListing() {
  if (!currentRemote || !window.rcloneGui?.listRemotePath) {
    entries = [];
    setLoading(false);
    renderBreadcrumbs();
    renderEntries();
    updateActionState();
    return;
  }

  const token = ++loadToken;
  selectedPath = null;
  selectedIsDir = false;
  entries = [];
  setStatus("");
  setLoading(true, "Loading folder…");
  renderBreadcrumbs();
  renderEntries();
  updateActionState();

  try {
    const result = await window.rcloneGui.listRemotePath(currentPath());
    if (token !== loadToken) {
      return;
    }
    entries = result.entries || [];
    setStatus(entries.length ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : "");
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    entries = [];
    setStatus(error.message || "Failed to list remote path.", true);
    notify({
      title: "Browse failed",
      message: error.message || "Failed to list remote path.",
      type: "error",
    });
  } finally {
    if (token === loadToken) {
      setLoading(false);
      renderEntries();
      updateActionState();
    }
  }
}

async function navigateTo(subPath) {
  currentSubPath = String(subPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  await loadListing();
}

function fillRemotePicker() {
  const previous = remoteBrowser.remotePicker.value || currentRemote;
  remoteBrowser.remotePicker.innerHTML =
    '<option value="">Select a configured remote...</option>';

  for (const remote of browseRemotes) {
    const option = document.createElement("option");
    option.value = remote;
    option.textContent = remote;
    remoteBrowser.remotePicker.appendChild(option);
  }

  if (browseRemotes.includes(previous)) {
    remoteBrowser.remotePicker.value = previous;
    currentRemote = previous;
  } else {
    remoteBrowser.remotePicker.value = "";
    currentRemote = "";
    currentSubPath = "";
    entries = [];
    selectedPath = null;
  }

  renderBreadcrumbs();
  renderEntries();
  updateActionState();
}

function setRemotes(names) {
  browseRemotes = Array.isArray(names) ? [...names] : [];
  fillRemotePicker();
}

async function copyActivePath() {
  const path = activePath();
  if (!path) {
    return;
  }

  try {
    await navigator.clipboard.writeText(path);
    notify({
      title: "Path copied",
      message: path,
      type: "success",
    });
  } catch {
    notify({
      title: "Copy failed",
      message: "Could not copy path to the clipboard.",
      type: "error",
    });
  }
}

function useActivePath(target) {
  const path = activePath();
  if (!path || typeof onUsePath !== "function") {
    return;
  }
  onUsePath({ path, target, isDir: selectedIsDir || !selectedPath });
}

function selectedFileName() {
  if (!selectedPath || selectedIsDir) {
    return "download";
  }
  const parts = selectedPath.split(":");
  const remoteSide = parts.length > 1 ? parts.slice(1).join(":") : selectedPath;
  const name = remoteSide.split("/").filter(Boolean).pop();
  return name || "download";
}

async function downloadSelectedFile() {
  if (!selectedPath || selectedIsDir || loading) {
    return;
  }
  if (!window.rcloneGui?.pickSaveFile || !window.rcloneGui?.downloadRemoteFile) {
    notify({
      title: "Download unavailable",
      message: "App bridge does not support downloads.",
      type: "error",
    });
    return;
  }

  const remotePath = selectedPath;
  let localPath;
  try {
    localPath = await window.rcloneGui.pickSaveFile(selectedFileName());
  } catch (error) {
    notify({
      title: "Download failed",
      message: error.message || "Could not open the save dialog.",
      type: "error",
    });
    return;
  }

  if (!localPath) {
    return;
  }

  setLoading(true, "Downloading…");
  updateActionState();

  try {
    const result = await window.rcloneGui.downloadRemoteFile({
      remotePath,
      localPath,
    });
    notify({
      title: "Download complete",
      message: result.localPath,
      type: "success",
    });
  } catch (error) {
    notify({
      title: "Download failed",
      message: error.message || "Could not download the file.",
      type: "error",
    });
  } finally {
    setLoading(false);
    updateActionState();
  }
}

function bindEvents() {
  remoteBrowser.remotePicker.addEventListener("change", () => {
    currentRemote = remoteBrowser.remotePicker.value;
    currentSubPath = "";
    selectedPath = null;
    selectedIsDir = false;
    void loadListing();
  });

  remoteBrowser.upBtn.addEventListener("click", () => {
    void navigateTo(parentSubPath(currentSubPath));
  });

  remoteBrowser.refreshBtn.addEventListener("click", () => {
    void loadListing();
  });

  remoteBrowser.copyPathBtn.addEventListener("click", () => {
    void copyActivePath();
  });

  remoteBrowser.downloadBtn?.addEventListener("click", () => {
    void downloadSelectedFile();
  });

  remoteBrowser.useSourceBtn.addEventListener("click", () => useActivePath("source"));
  remoteBrowser.useDestBtn.addEventListener("click", () => useActivePath("destination"));
}

function init(options = {}) {
  onUsePath = options.onUsePath || null;
  onNotify = options.onNotify || null;
  bindEvents();
  fillRemotePicker();
}

function restartEnterAnimations() {
  const targets = remoteBrowser.view.querySelectorAll(
    ".browse-panel, .browse-toolbar, .browse-breadcrumbs, .browse-table-wrap, .browse-status, .browse-footer",
  );
  for (const el of targets) {
    el.style.animation = "none";
  }
  void remoteBrowser.view.offsetWidth;
  for (const el of targets) {
    el.style.animation = "";
  }
}

function show() {
  remoteBrowser.view.classList.remove("hidden");
  remoteBrowser.view.hidden = false;
  restartEnterAnimations();
  if (currentRemote) {
    void loadListing();
  } else {
    renderBreadcrumbs();
    renderEntries();
    updateActionState();
  }
}

function hide() {
  remoteBrowser.view.classList.add("hidden");
  remoteBrowser.view.hidden = true;
}

window.RemoteBrowser = {
  init,
  setRemotes,
  show,
  hide,
  reload: loadListing,
};
})();
