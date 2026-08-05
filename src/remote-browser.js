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
  previewBtn: document.getElementById("browse-preview"),
  downloadBtn: document.getElementById("browse-download"),
  copyPathBtn: document.getElementById("browse-copy-path"),
  useSourceBtn: document.getElementById("browse-use-source"),
  useDestBtn: document.getElementById("browse-use-dest"),
};

const previewUi = {
  dialog: document.getElementById("preview-dialog"),
  title: document.getElementById("preview-title"),
  subtitle: document.getElementById("preview-subtitle"),
  text: document.getElementById("preview-text"),
  pdf: document.getElementById("preview-pdf"),
  image: document.getElementById("preview-image"),
  video: document.getElementById("preview-video"),
  audioWrap: document.getElementById("preview-audio-wrap"),
  audio: document.getElementById("preview-audio"),
  zip: document.getElementById("preview-zip"),
  zipBreadcrumbs: document.getElementById("preview-zip-breadcrumbs"),
  zipSummary: document.getElementById("preview-zip-summary"),
  zipLoading: document.getElementById("preview-zip-loading"),
  zipEntries: document.getElementById("preview-zip-entries"),
  closeBtn: document.getElementById("preview-close"),
};

const PREVIEW_EXTENSIONS = new Set([".txt", ".pdf", ".mp3", ".mp4", ".zip", ".7z", ".jpg", ".jpeg", ".png"]);

let browseRemotes = [];
let currentRemote = "";
let currentSubPath = "";
let entries = [];
let selectedPath = null;
let selectedIsDir = false;
let selectedSize = null;
let loading = false;
let loadToken = 0;
let onUsePath = null;
let onNotify = null;
let previewBlobUrl = null;
let zipPreviewState = null;
let browseHistory = [];
let browseHistoryIndex = -1;

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

function selectedExtension() {
  const name = selectedFileName();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function canPreviewSelection() {
  return Boolean(selectedPath) && !selectedIsDir && !loading && PREVIEW_EXTENSIONS.has(selectedExtension());
}

function updateActionState() {
  const path = activePath();
  const hasPath = Boolean(path);
  const canDownload = Boolean(selectedPath) && !selectedIsDir && !loading;
  if (remoteBrowser.previewBtn) {
    remoteBrowser.previewBtn.disabled = !canPreviewSelection();
  }
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
    selectedSize = null;
  } else {
    selectedPath = formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
    selectedIsDir = entry.isDir;
    selectedSize = typeof entry.size === "number" ? entry.size : null;
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
        if (canPreviewSelection()) {
          void previewSelectedFile();
        } else {
          void downloadSelectedFile();
        }
      }
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (entry.isDir) {
          void navigateTo(joinSubPath(currentSubPath, entry.name));
        } else {
          selectEntry(entry);
          if (canPreviewSelection()) {
            void previewSelectedFile();
          } else {
            void downloadSelectedFile();
          }
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
  selectedSize = null;
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

function pushBrowseHistory(remote, subPath) {
  if (!remote) {
    return;
  }

  const entry = {
    remote,
    subPath: String(subPath || "")
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, ""),
  };
  const current = browseHistory[browseHistoryIndex];
  if (current && current.remote === entry.remote && current.subPath === entry.subPath) {
    return;
  }

  browseHistory = browseHistory.slice(0, browseHistoryIndex + 1);
  browseHistory.push(entry);
  browseHistoryIndex = browseHistory.length - 1;
}

function resetBrowseHistory(remote, subPath = "") {
  browseHistory = [];
  browseHistoryIndex = -1;
  if (remote) {
    pushBrowseHistory(remote, subPath);
  }
}

async function navigateTo(subPath, { recordHistory = true } = {}) {
  currentSubPath = String(subPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (recordHistory) {
    pushBrowseHistory(currentRemote, currentSubPath);
  }
  await loadListing();
}

async function browseHistoryBack() {
  if (browseHistoryIndex <= 0 || loading) {
    return false;
  }

  browseHistoryIndex -= 1;
  const entry = browseHistory[browseHistoryIndex];
  currentRemote = entry.remote;
  if (remoteBrowser.remotePicker) {
    remoteBrowser.remotePicker.value = entry.remote;
  }
  currentSubPath = entry.subPath;
  await loadListing();
  return true;
}

async function browseHistoryForward() {
  if (browseHistoryIndex < 0 || browseHistoryIndex >= browseHistory.length - 1 || loading) {
    return false;
  }

  browseHistoryIndex += 1;
  const entry = browseHistory[browseHistoryIndex];
  currentRemote = entry.remote;
  if (remoteBrowser.remotePicker) {
    remoteBrowser.remotePicker.value = entry.remote;
  }
  currentSubPath = entry.subPath;
  await loadListing();
  return true;
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
    selectedIsDir = false;
    selectedSize = null;
    resetBrowseHistory("");
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

function previewCard() {
  return previewUi.dialog?.querySelector(".popup-card-preview") || null;
}

function clearPreviewContent() {
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }

  if (previewUi.text) {
    previewUi.text.textContent = "";
    previewUi.text.classList.add("hidden");
  }
  if (previewUi.pdf) {
    previewUi.pdf.removeAttribute("src");
    previewUi.pdf.classList.add("hidden");
  }
  if (previewUi.image) {
    previewUi.image.removeAttribute("src");
    previewUi.image.classList.add("hidden");
  }
  if (previewUi.video) {
    previewUi.video.pause();
    previewUi.video.removeAttribute("src");
    previewUi.video.replaceChildren();
    previewUi.video.load();
    previewUi.video.classList.add("hidden");
  }
  if (previewUi.audio) {
    previewUi.audio.pause();
    previewUi.audio.removeAttribute("src");
    previewUi.audio.load();
  }
  if (previewUi.audioWrap) {
    previewUi.audioWrap.classList.add("hidden");
  }
  if (previewUi.zip) {
    previewUi.zip.classList.add("hidden");
    previewUi.zip.classList.remove("is-loading");
  }
  if (previewUi.zipBreadcrumbs) {
    previewUi.zipBreadcrumbs.innerHTML = "";
  }
  if (previewUi.zipSummary) {
    previewUi.zipSummary.textContent = "";
  }
  if (previewUi.zipLoading) {
    previewUi.zipLoading.classList.add("hidden");
  }
  if (previewUi.zipEntries) {
    previewUi.zipEntries.innerHTML = "";
  }
  zipPreviewState = null;
  previewCard()?.classList.remove("is-video");
}

function closePreview() {
  clearPreviewContent();
  void window.rcloneGui?.closeRemotePreview?.();
  if (!previewUi.dialog) {
    return;
  }
  previewUi.dialog.classList.add("hidden");
  previewUi.dialog.setAttribute("aria-hidden", "true");
}

function openPreviewDialog(payload) {
  clearPreviewContent();

  previewUi.title.textContent = payload.name || "Preview";
  previewUi.subtitle.textContent = payload.statusText || selectedPath || "";
  previewCard()?.classList.toggle("is-video", payload.kind === "video");

  if (payload.kind === "text") {
    previewUi.text.textContent = payload.text ?? "";
    previewUi.text.classList.remove("hidden");
  } else if (payload.kind === "pdf") {
    const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
    const blob = new Blob([bytes], { type: payload.mime || "application/pdf" });
    previewBlobUrl = URL.createObjectURL(blob);
    previewUi.pdf.src = previewBlobUrl;
    previewUi.pdf.classList.remove("hidden");
  } else if (payload.kind === "image") {
    const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
    const blob = new Blob([bytes], { type: payload.mime || "image/jpeg" });
    previewBlobUrl = URL.createObjectURL(blob);
    previewUi.image.src = previewBlobUrl;
    previewUi.image.alt = payload.name || "Image preview";
    previewUi.image.classList.remove("hidden");
  } else if (payload.kind === "audio") {
    if (payload.streamUrl) {
      bindStreamMedia("audio", payload.streamUrl, payload.mime || "audio/mpeg");
    } else if (payload.data) {
      const bytes = payload.data instanceof Uint8Array ? payload.data : new Uint8Array(payload.data);
      const blob = new Blob([bytes], { type: payload.mime || "audio/mpeg" });
      previewBlobUrl = URL.createObjectURL(blob);
      previewUi.audio.src = previewBlobUrl;
    }
    previewUi.audioWrap.classList.remove("hidden");
  } else if (payload.kind === "video") {
    if (payload.streamUrl) {
      bindStreamMedia("video", payload.streamUrl, payload.mime || "video/mp4");
    }
    previewUi.video.classList.remove("hidden");
  } else if (payload.kind === "zip") {
    previewUi.zip.classList.remove("hidden");
    if (payload.pending) {
      previewUi.zip.classList.add("is-loading");
      if (previewUi.zipLoading) {
        previewUi.zipLoading.classList.remove("hidden");
      }
      if (previewUi.zipSummary) {
        previewUi.zipSummary.textContent = payload.statusText || "Reading archive index…";
      }
      if (previewUi.zipBreadcrumbs) {
        previewUi.zipBreadcrumbs.innerHTML = "";
        const root = document.createElement("span");
        root.className = "preview-zip-crumb";
        root.textContent = payload.name || "archive";
        previewUi.zipBreadcrumbs.appendChild(root);
      }
    } else {
      previewUi.zip.classList.remove("is-loading");
      if (previewUi.zipLoading) {
        previewUi.zipLoading.classList.add("hidden");
      }
      renderZipPreview(payload);
    }
  } else {
    throw new Error("Unsupported preview type.");
  }

  previewUi.dialog.classList.remove("hidden");
  previewUi.dialog.setAttribute("aria-hidden", "false");
}

function normalizeZipEntryPath(name) {
  return String(name || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function buildZipFolderListing(allEntries, currentPath) {
  const prefix = currentPath ? `${currentPath}/` : "";
  const folders = new Map();
  const files = [];

  for (const entry of allEntries) {
    const fullPath = normalizeZipEntryPath(entry.name);
    if (!fullPath) {
      continue;
    }

    if (prefix) {
      if (fullPath === currentPath) {
        continue;
      }
      if (!fullPath.startsWith(prefix)) {
        continue;
      }
    }

    const relative = prefix ? fullPath.slice(prefix.length) : fullPath;
    if (!relative) {
      continue;
    }

    const slash = relative.indexOf("/");
    if (slash >= 0) {
      const folderName = relative.slice(0, slash);
      if (!folders.has(folderName)) {
        folders.set(folderName, {
          name: folderName,
          path: prefix ? `${currentPath}/${folderName}` : folderName,
          isDir: true,
          size: null,
          compressedSize: null,
        });
      }
      continue;
    }

    if (entry.isDir) {
      if (!folders.has(relative)) {
        folders.set(relative, {
          name: relative,
          path: fullPath,
          isDir: true,
          size: null,
          compressedSize: null,
        });
      }
      continue;
    }

    files.push({
      name: relative,
      path: fullPath,
      isDir: false,
      size: entry.size,
      compressedSize: entry.compressedSize,
    });
  }

  return [...folders.values(), ...files].sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

function renderZipBreadcrumbs() {
  if (!previewUi.zipBreadcrumbs || !zipPreviewState) {
    return;
  }

  previewUi.zipBreadcrumbs.innerHTML = "";
  const root = document.createElement("button");
  root.type = "button";
  root.className = "preview-zip-crumb";
  root.textContent = zipPreviewState.name || "archive";
  root.title = zipPreviewState.name || "archive";
  root.disabled = !zipPreviewState.currentPath;
  root.addEventListener("click", () => {
    if (zipPreviewState.currentPath) {
      navigateZipTo("");
    }
  });
  previewUi.zipBreadcrumbs.appendChild(root);

  const parts = zipPreviewState.currentPath ? zipPreviewState.currentPath.split("/").filter(Boolean) : [];
  let path = "";
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    const sep = document.createElement("span");
    sep.className = "preview-zip-crumb-sep";
    sep.textContent = "/";
    sep.setAttribute("aria-hidden", "true");
    previewUi.zipBreadcrumbs.appendChild(sep);

    const crumbPath = path;
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "preview-zip-crumb";
    crumb.textContent = part;
    crumb.title = crumbPath;
    crumb.disabled = crumbPath === zipPreviewState.currentPath;
    crumb.addEventListener("click", () => {
      if (zipPreviewState.currentPath !== crumbPath) {
        navigateZipTo(crumbPath);
      }
    });
    previewUi.zipBreadcrumbs.appendChild(crumb);
  }
}

function navigateZipTo(path, { recordHistory = true } = {}) {
  if (!zipPreviewState) {
    return;
  }

  const next = String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");

  if (recordHistory) {
    const history = Array.isArray(zipPreviewState.history) ? zipPreviewState.history : [""];
    let index = Number.isInteger(zipPreviewState.historyIndex) ? zipPreviewState.historyIndex : 0;
    const current = history[index];
    if (current !== next) {
      const trimmed = history.slice(0, index + 1);
      trimmed.push(next);
      zipPreviewState.history = trimmed;
      zipPreviewState.historyIndex = trimmed.length - 1;
    }
  }

  zipPreviewState.currentPath = next;
  renderZipFolderView();
}

function zipHistoryBack() {
  if (!zipPreviewState || !Array.isArray(zipPreviewState.history)) {
    return false;
  }
  if (zipPreviewState.historyIndex <= 0) {
    return false;
  }
  zipPreviewState.historyIndex -= 1;
  zipPreviewState.currentPath = zipPreviewState.history[zipPreviewState.historyIndex] || "";
  renderZipFolderView();
  return true;
}

function zipHistoryForward() {
  if (!zipPreviewState || !Array.isArray(zipPreviewState.history)) {
    return false;
  }
  if (zipPreviewState.historyIndex >= zipPreviewState.history.length - 1) {
    return false;
  }
  zipPreviewState.historyIndex += 1;
  zipPreviewState.currentPath = zipPreviewState.history[zipPreviewState.historyIndex] || "";
  renderZipFolderView();
  return true;
}

function isZipPreviewOpen() {
  return Boolean(
    zipPreviewState &&
      previewUi.dialog &&
      !previewUi.dialog.classList.contains("hidden") &&
      previewUi.zip &&
      !previewUi.zip.classList.contains("hidden") &&
      !previewUi.zip.classList.contains("is-loading"),
  );
}

function isBrowseViewVisible() {
  return Boolean(remoteBrowser.view && !remoteBrowser.view.classList.contains("hidden") && !remoteBrowser.view.hidden);
}

function handleHistoryNavigate(direction) {
  if (direction === "back") {
    if (isZipPreviewOpen()) {
      zipHistoryBack();
      return;
    }
    if (isBrowseViewVisible()) {
      void browseHistoryBack();
    }
    return;
  }

  if (direction === "forward") {
    if (isZipPreviewOpen()) {
      zipHistoryForward();
      return;
    }
    if (isBrowseViewVisible()) {
      void browseHistoryForward();
    }
  }
}

function renderZipFolderView() {
  if (!zipPreviewState || !previewUi.zipEntries) {
    return;
  }

  const listing = buildZipFolderListing(zipPreviewState.entries, zipPreviewState.currentPath);
  const total = zipPreviewState.totalEntries;
  const archiveLabel = formatBytes(zipPreviewState.archiveBytes);
  const parts = [
    `${listing.length.toLocaleString()} item${listing.length === 1 ? "" : "s"} here`,
    `${total.toLocaleString()} in archive`,
    archiveLabel,
  ];
  if (zipPreviewState.truncated) {
    parts.push("index truncated");
  }
  if (previewUi.zipSummary) {
    previewUi.zipSummary.textContent = parts.filter(Boolean).join(" · ");
  }

  renderZipBreadcrumbs();
  previewUi.zipEntries.innerHTML = "";

  if (listing.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 3;
    cell.textContent = zipPreviewState.currentPath ? "This folder is empty." : "This archive is empty.";
    cell.style.color = "var(--muted)";
    row.appendChild(cell);
    previewUi.zipEntries.appendChild(row);
    return;
  }

  for (const entry of listing) {
    const row = document.createElement("tr");
    row.className = `preview-zip-row${entry.isDir ? " is-dir" : " is-file"}`;
    if (entry.isDir) {
      row.tabIndex = 0;
      const openFolder = () => {
        navigateZipTo(entry.path);
      };
      row.addEventListener("click", openFolder);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openFolder();
        }
      });
    }

    const nameCell = document.createElement("td");
    nameCell.className = "preview-zip-col-name";
    const nameWrap = document.createElement("div");
    nameWrap.className = "preview-zip-name";
    const icon = document.createElement("span");
    icon.className = `browse-entry-icon${entry.isDir ? " is-dir" : " is-file"}`;
    icon.setAttribute("aria-hidden", "true");
    const nameText = document.createElement("span");
    nameText.className = "preview-zip-name-text";
    nameText.textContent = entry.name;
    nameText.title = entry.path || entry.name;
    nameWrap.append(icon, nameText);
    nameCell.appendChild(nameWrap);

    const sizeCell = document.createElement("td");
    sizeCell.className = "preview-zip-col-size";
    sizeCell.textContent = entry.isDir ? "—" : formatBytes(entry.size);

    const packedCell = document.createElement("td");
    packedCell.className = "preview-zip-col-packed";
    packedCell.textContent = entry.isDir ? "—" : formatBytes(entry.compressedSize);

    row.append(nameCell, sizeCell, packedCell);
    previewUi.zipEntries.appendChild(row);
  }
}

function renderZipPreview(payload) {
  zipPreviewState = {
    name: payload.name || "archive",
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    totalEntries: typeof payload.totalEntries === "number" ? payload.totalEntries : (payload.entries || []).length,
    truncated: Boolean(payload.truncated),
    archiveBytes: payload.archiveBytes,
    currentPath: "",
    history: [""],
    historyIndex: 0,
  };
  renderZipFolderView();
}

function bindStreamMedia(kind, streamUrl, mime) {
  const media = kind === "video" ? previewUi.video : previewUi.audio;
  if (!media || !streamUrl) {
    return;
  }

  media.preload = "none";

  media.addEventListener(
    "error",
    () => {
      notify({
        title: "Stream failed",
        message: kind === "video" ? "Could not stream this .mp4 file." : "Could not stream this .mp3 file.",
        type: "error",
      });
    },
    { once: true },
  );

  if (kind === "video") {
    media.removeAttribute("src");
    media.replaceChildren();
    const source = document.createElement("source");
    source.src = streamUrl;
    source.type = mime || "video/mp4";
    media.appendChild(source);
    media.load();
  } else {
    media.src = streamUrl;
  }

  // Starts the ranged fetch; if autoplay is blocked, native controls still work.
  void media.play().catch(() => {});
}

async function previewSelectedFile() {
  if (!canPreviewSelection()) {
    return;
  }
  if (!window.rcloneGui?.openRemotePreview) {
    notify({
      title: "Preview unavailable",
      message: "App bridge does not support previews.",
      type: "error",
    });
    return;
  }

  const remotePath = selectedPath;
  const fileSize = selectedSize;
  const ext = selectedExtension();
  const streaming = ext === ".mp3" || ext === ".mp4";
  const kind = ext === ".mp4" ? "video" : ext === ".mp3" ? "audio" : null;

  if (streaming && kind) {
    // Show the player immediately; only wait on the local stream URL, not the whole file.
    openPreviewDialog({
      kind,
      name: selectedFileName(),
      streamUrl: null,
      statusText: "Connecting stream…",
    });
    updateActionState();
    try {
      const payload = await window.rcloneGui.openRemotePreview(remotePath);
      if (previewUi.subtitle) {
        previewUi.subtitle.textContent = selectedPath || "";
      }
      bindStreamMedia(kind, payload.streamUrl, payload.mime);
    } catch (error) {
      closePreview();
      notify({
        title: "Preview failed",
        message: error.message || "Could not open a preview.",
        type: "error",
      });
    } finally {
      updateActionState();
    }
    return;
  }

  if (ext === ".zip" || ext === ".7z") {
    openPreviewDialog({
      kind: "zip",
      name: selectedFileName(),
      pending: true,
      statusText: ext === ".7z" ? "Reading 7z index…" : "Reading zip index…",
    });
    updateActionState();
    try {
      const payload = await window.rcloneGui.openRemotePreview(remotePath, { size: fileSize });
      if (previewUi.subtitle) {
        previewUi.subtitle.textContent = selectedPath || "";
      }
      openPreviewDialog(payload);
    } catch (error) {
      closePreview();
      notify({
        title: "Preview failed",
        message: error.message || "Could not open a preview.",
        type: "error",
      });
    } finally {
      updateActionState();
    }
    return;
  }

  setLoading(true, "Preparing preview…");
  updateActionState();

  try {
    const payload = await window.rcloneGui.openRemotePreview(remotePath, { size: fileSize });
    openPreviewDialog(payload);
  } catch (error) {
    void window.rcloneGui?.closeRemotePreview?.();
    notify({
      title: "Preview failed",
      message: error.message || "Could not open a preview.",
      type: "error",
    });
  } finally {
    setLoading(false);
    updateActionState();
  }
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
    selectedSize = null;
    resetBrowseHistory(currentRemote, "");
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

  remoteBrowser.previewBtn?.addEventListener("click", () => {
    void previewSelectedFile();
  });

  remoteBrowser.downloadBtn?.addEventListener("click", () => {
    void downloadSelectedFile();
  });

  remoteBrowser.useSourceBtn.addEventListener("click", () => useActivePath("source"));
  remoteBrowser.useDestBtn.addEventListener("click", () => useActivePath("destination"));

  previewUi.closeBtn?.addEventListener("click", closePreview);
  for (const closer of previewUi.dialog?.querySelectorAll("[data-preview-close]") || []) {
    closer.addEventListener("click", closePreview);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewUi.dialog && !previewUi.dialog.classList.contains("hidden")) {
      closePreview();
    }
  });

  // Mouse 4/5 (back/forward). Also covered by Electron app-command on Windows.
  document.addEventListener("mousedown", (event) => {
    if (event.button === 3 || event.button === 4) {
      event.preventDefault();
    }
  });
  document.addEventListener("mouseup", (event) => {
    if (event.button === 3) {
      event.preventDefault();
      handleHistoryNavigate("back");
    } else if (event.button === 4) {
      event.preventDefault();
      handleHistoryNavigate("forward");
    }
  });
  window.rcloneGui?.onHistoryNavigate?.(handleHistoryNavigate);
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
    if (browseHistoryIndex < 0) {
      resetBrowseHistory(currentRemote, currentSubPath);
    }
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
