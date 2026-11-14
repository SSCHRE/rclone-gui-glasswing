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
  loadingCancelBtn: document.getElementById("browse-cancel"),
  selectionLabel: document.getElementById("browse-selection"),
  previewBtn: document.getElementById("browse-preview"),
  downloadBtn: document.getElementById("browse-download"),
  newFolderBtn: document.getElementById("browse-new-folder"),
  uploadBtn: document.getElementById("browse-upload"),
  tableWrap: document.querySelector("#browse-view .browse-table-wrap"),
  replaceDialog: document.getElementById("upload-replace-dialog"),
  replaceMessage: document.getElementById("upload-replace-message"),
  replaceCancelBtn: document.getElementById("upload-replace-cancel"),
  replaceConfirmBtn: document.getElementById("upload-replace-confirm"),
  useSourceBtn: document.getElementById("browse-use-source"),
  useDestBtn: document.getElementById("browse-use-dest"),
  deleteBtn: document.getElementById("browse-delete"),
  tableHead: document.querySelector(".browse-table thead"),
  searchInput: document.getElementById("browse-search"),
  searchGoBtn: document.getElementById("browse-search-go"),
  searchBar: document.getElementById("browse-search-bar"),
  searchSpinner: document.getElementById("browse-search-spinner"),
  searchSummary: document.getElementById("browse-search-summary"),
  searchStopBtn: document.getElementById("browse-search-stop"),
  searchExitBtn: document.getElementById("browse-search-exit"),
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
  previousBtn: document.getElementById("preview-previous"),
  nextBtn: document.getElementById("preview-next"),
};

const PREVIEW_EXTENSIONS = new Set([".txt", ".pdf", ".mp3", ".mp4", ".zip", ".7z", ".jpg", ".jpeg", ".png"]);

let browseRemotes = [];
let pendingUploads = [];
const LAST_UPLOAD_KEY = "glasswing.lastUploadTarget";
let vaultBacking = new Map();
let vaultLookup = 0;
let currentRemote = "";
let currentSubPath = "";
let entries = [];
let selectedPath = null;
let selectedIsDir = false;
let selectedSize = null;
const selection = new Map();
let selectionAnchor = null;
let loading = false;
let loadToken = 0;
let loadingContext = "";
let loadingAbortController = null;
let scrollPosition = 0;
let onUsePath = null;
let onNotify = null;
let previewBlobUrl = null;
let zipPreviewState = null;
let browseHistory = [];
let browseHistoryIndex = -1;
let sortBy = "name";
let sortDirection = "asc";
let previewableFiles = [];
let currentPreviewIndex = -1;
let statusHideTimer = null;
let previewToken = 0;
let activePreviewToken = 0;
let searchState = null;
let searchToken = 0;
let searchRenderQueued = false;

function beginPreview() {
  activePreviewToken = ++previewToken;
  return activePreviewToken;
}

function isPreviewCurrent(token) {
  return activePreviewToken === token;
}

function abandonPreview() {
  activePreviewToken = 0;
  void window.rcloneGui?.closeRemotePreview?.();
}

function releaseStalePreview() {
  if (activePreviewToken === 0) {
    void window.rcloneGui?.closeRemotePreview?.();
  }
}

const LISTING_CACHE_KEY = "glasswing.browseCache.v1";
const LISTING_CACHE_MAX_FOLDERS = 150;
const LISTING_CACHE_MAX_PERSISTED_ENTRIES = 5000;
const listingCache = readPersistedListingCache();
let listingCacheSaveTimer = null;

function readPersistedListingCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LISTING_CACHE_KEY) || "[]");
    return new Map(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Map();
  }
}

function persistListingCache() {
  listingCacheSaveTimer = null;
  const persisted = [...listingCache].filter(
    ([, cached]) => cached.entries.length <= LISTING_CACHE_MAX_PERSISTED_ENTRIES,
  );

  while (persisted.length) {
    try {
      localStorage.setItem(LISTING_CACHE_KEY, JSON.stringify(persisted));
      return;
    } catch {
      persisted.splice(0, Math.ceil(persisted.length / 2));
    }
  }

  try {
    localStorage.removeItem(LISTING_CACHE_KEY);
  } catch {}
}

function schedulePersistListingCache() {
  if (listingCacheSaveTimer) {
    clearTimeout(listingCacheSaveTimer);
  }
  listingCacheSaveTimer = setTimeout(persistListingCache, 750);
}

function getCachedListing(path) {
  const cached = listingCache.get(path);
  if (!cached) {
    return null;
  }
  listingCache.delete(path);
  listingCache.set(path, cached);
  return cached.entries;
}

function setCachedListing(path, listing) {
  listingCache.delete(path);
  listingCache.set(path, { entries: listing, fetchedAt: Date.now() });
  while (listingCache.size > LISTING_CACHE_MAX_FOLDERS) {
    listingCache.delete(listingCache.keys().next().value);
  }
  schedulePersistListingCache();
}

function dropCachedListings(path) {
  const prefix = path.endsWith(":") ? path : `${path}/`;
  for (const key of [...listingCache.keys()]) {
    if (key === path || key.startsWith(prefix)) {
      listingCache.delete(key);
    }
  }
  schedulePersistListingCache();
}

function sameListing(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return entry.name === other.name &&
      entry.isDir === other.isDir &&
      entry.size === other.size &&
      entry.modTime === other.modTime;
  });
}

function itemCountLabel(list) {
  return list.length ? `${list.length} item${list.length === 1 ? "" : "s"}` : "";
}

function notify(payload) {
  if (typeof onNotify === "function") {
    onNotify(payload);
  }
}

function getSortedEntries() {
  const sorted = [...entries];
  
  sorted.sort((a, b) => {
    const dirA = a.isDir || false;
    const dirB = b.isDir || false;
    
    if (dirA && !dirB) return -1;
    if (!dirA && dirB) return 1;
    
    const reverse = sortDirection === "desc" ? -1 : 1;
    
    if (sortBy === "name") {
      return reverse * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    
    if (sortBy === "size") {
      const sizeA = typeof a.size === "number" ? a.size : 0;
      const sizeB = typeof b.size === "number" ? b.size : 0;
      if (sizeA !== sizeB) return reverse * (sizeA - sizeB);
      return reverse * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    
    if (sortBy === "modified") {
      const timeA = a.modTime ? new Date(a.modTime).getTime() : 0;
      const timeB = b.modTime ? new Date(b.modTime).getTime() : 0;
      if (timeA !== timeB) return reverse * (timeA - timeB);
      return reverse * a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    }
    
    return 0;
  });
  
  return sorted;
}

function setSort(criteria, direction) {
  if (criteria === sortBy) {
    sortDirection = direction || (sortDirection === "asc" ? "desc" : "asc");
  } else {
    sortBy = criteria;
    sortDirection = direction || "asc";
  }
  
  updateTableSortIndicators();
  renderEntries();
}

function updateTableSortIndicators() {
  if (!remoteBrowser.tableHead) return;
  
  const headers = remoteBrowser.tableHead.querySelectorAll(".browse-col-sortable");
  for (const header of headers) {
    const criteria = header.dataset.sort;
    header.classList.remove("is-sorted-asc", "is-sorted-desc");
    
    if (criteria === sortBy) {
      header.classList.add(sortDirection === "asc" ? "is-sorted-asc" : "is-sorted-desc");
    }
  }
}

function getPreviewableFiles() {
  if (!currentRemote) return [];
  
  const sortedEntriesList = getSortedEntries();
  return sortedEntriesList.filter(entry => {
    if (entry.isDir) return false;
    const ext = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    return PREVIEW_EXTENSIONS.has(ext);
  });
}

function updatePreviewNavigation() {
  previewableFiles = getPreviewableFiles();
  
  if (!selectedPath || selectedIsDir) {
    currentPreviewIndex = -1;
    updatePreviewButtons();
    return;
  }
  
  const selectedFileName = selectedPath.split("/").pop() || selectedPath;
  currentPreviewIndex = previewableFiles.findIndex(f => 
    formatRemotePath(currentRemote, joinSubPath(currentSubPath, f.name)) === selectedPath
  );
  
  updatePreviewButtons();
}

function updatePreviewButtons() {
  if (!previewUi.previousBtn || !previewUi.nextBtn) return;
  
  const hasPreviewable = previewableFiles.length > 0 && currentPreviewIndex >= 0;
  const hasPrevious = hasPreviewable && currentPreviewIndex > 0;
  const hasNext = hasPreviewable && currentPreviewIndex < previewableFiles.length - 1;
  
  previewUi.previousBtn.disabled = !hasPrevious;
  previewUi.nextBtn.disabled = !hasNext;
}

function navigatePreview(direction) {
  if (previewableFiles.length === 0 || currentPreviewIndex < 0) return;
  
  const newIndex = currentPreviewIndex + direction;
  if (newIndex < 0 || newIndex >= previewableFiles.length) return;
  
  const targetFile = previewableFiles[newIndex];
  if (!targetFile) return;
  
  currentPreviewIndex = newIndex;
  selectEntry(targetFile);
  
  updatePreviewButtons();
  
  void previewSelectedFile();
}

function trimSlashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(start, end);
}

function formatRemotePath(remote, subPath = "") {
  const trimmed = trimSlashes(String(subPath || "").trim()).replace(/\\/g, "/");
  return trimmed ? `${remote}:${trimmed}` : `${remote}:`;
}

function joinSubPath(base, name) {
  const parts = [base, name]
    .filter(Boolean)
    .join("/")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
  return trimSlashes(parts);
}

function parentSubPath(subPath) {
  const trimmed = trimSlashes(String(subPath || "").replace(/\\/g, "/"));
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

const ENTRY_KINDS = {
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "heic", "heif", "avif", "tif", "tiff", "ico", "raw", "cr2", "nef", "dng", "psd"],
  video: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "flv", "mpg", "mpeg", "3gp", "ts"],
  audio: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "opus", "wma", "aiff", "mid", "midi"],
  archive: ["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst", "iso", "dmg", "cab"],
  pdf: ["pdf"],
  doc: ["doc", "docx", "odt", "rtf", "pages", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp", "key", "numbers", "epub"],
  text: ["txt", "md", "markdown", "log", "nfo", "ini", "cfg", "conf"],
  code: ["js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "html", "htm", "css", "scss", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "bat", "cmd", "lua", "sql", "xml", "yml", "yaml", "toml", "swift", "dart", "vue"],
  app: ["exe", "msi", "deb", "rpm", "appimage", "apk", "app", "pkg", "dll", "bin", "jar"],
};

const ENTRY_KIND_BY_EXTENSION = new Map(
  Object.entries(ENTRY_KINDS).flatMap(([kind, extensions]) => extensions.map((extension) => [extension, kind])),
);

function entryKind(name, isDir) {
  if (isDir) {
    return "folder";
  }
  const base = String(name || "").split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return "file";
  }
  return ENTRY_KIND_BY_EXTENSION.get(base.slice(dot + 1).toLowerCase()) || "file";
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
  if (statusHideTimer) {
    clearTimeout(statusHideTimer);
    statusHideTimer = null;
  }

  if (!message) {
    remoteBrowser.status.textContent = "";
    remoteBrowser.status.classList.remove("visible");
    remoteBrowser.status.classList.remove("is-error");
    statusHideTimer = setTimeout(() => {
      statusHideTimer = null;
      remoteBrowser.status.classList.add("hidden");
    }, 300);
    return;
  }

  remoteBrowser.status.textContent = message;
  remoteBrowser.status.classList.toggle("is-error", isError);
  remoteBrowser.status.classList.remove("hidden");
  requestAnimationFrame(() => {
    remoteBrowser.status.classList.add("visible");
  });
}

function cancelLoading() {
  if (loadingAbortController) {
    loadingAbortController.abort();
    loadingAbortController = null;
  }

  if (loadingContext === "preview") {
    abandonPreview();
  }

  if (loadingContext === "navigate") {
    if (browseHistoryIndex >= 0) {
      const current = browseHistory[browseHistoryIndex];
      currentSubPath = current.subPath;
    } else {
      currentSubPath = "";
    }
  }
  
  loadToken++;
  setLoading(false);
  setStatus("Loading cancelled.", false);
}

function setLoading(isLoading, label = "Loading…", context = "") {
  loading = isLoading;
  loadingContext = context;
  if (!remoteBrowser.loading) {
    return;
  }

  const textEl = remoteBrowser.loading.querySelector(".browse-loading-text");
  const spinnerEl = remoteBrowser.loading.querySelector(".browse-loading-spinner");
  const cancelBtn = remoteBrowser.loadingCancelBtn;

  if (textEl) {
    textEl.textContent = label;
  }

  if (spinnerEl) {
    spinnerEl.classList.toggle("pulse", context === "delete");
  }

  if (cancelBtn) {
    cancelBtn.classList.toggle("hidden", !isLoading);
  }

  remoteBrowser.loading.classList.toggle("visible", isLoading);
  remoteBrowser.loading.classList.toggle("hidden", !isLoading);
  remoteBrowser.loading.setAttribute("aria-busy", String(isLoading));
}

function selectedExtension() {
  const name = selectedFileName();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function canPreviewSelection() {
  return Boolean(selectedPath) && !selectedIsDir && !loading && PREVIEW_EXTENSIONS.has(selectedExtension());
}

function countedLabel(button, base, count) {
  const label = button?.querySelector(".browse-action-label");
  if (label) {
    label.textContent = count > 1 ? `${base} ${count}` : base;
  }
}

function contextMenuLabel(button, base, count, noun) {
  const label = button?.querySelector(".context-menu-label");
  if (label) {
    label.textContent = count > 1 ? `${base} ${count} ${noun}s` : base;
  }
}

function canDownloadSelection() {
  return !loading && downloadableItems().length > 0;
}

function canDeleteSelection() {
  return !loading && selection.size > 0;
}

function updateActionState() {
  const path = activePath();
  const multiple = selection.size > 1;
  const hasPath = Boolean(path) && !multiple;
  if (remoteBrowser.previewBtn) {
    remoteBrowser.previewBtn.disabled = !canPreviewSelection();
  }
  if (remoteBrowser.downloadBtn) {
    remoteBrowser.downloadBtn.disabled = !canDownloadSelection();
    countedLabel(remoteBrowser.downloadBtn, "Download", downloadableItems().length);
  }
  if (remoteBrowser.newFolderBtn) {
    remoteBrowser.newFolderBtn.disabled = !currentRemote || loading || !window.rcloneGui?.createRemoteFolder;
  }
  if (remoteBrowser.uploadBtn) {
    remoteBrowser.uploadBtn.disabled = !canUpload();
  }
  remoteBrowser.useSourceBtn.disabled = !hasPath || loading;
  remoteBrowser.useDestBtn.disabled = !hasPath || loading;
  if (remoteBrowser.deleteBtn) {
    remoteBrowser.deleteBtn.disabled = !canDeleteSelection();
    countedLabel(remoteBrowser.deleteBtn, "Delete", selection.size);
  }
  remoteBrowser.upBtn.disabled = !currentRemote || !currentSubPath || loading;
  remoteBrowser.refreshBtn.disabled = !currentRemote || loading;
  remoteBrowser.remotePicker.disabled = loading;
  renderPendingUpload();
  if (remoteBrowser.searchInput) {
    remoteBrowser.searchInput.disabled = !currentRemote;
    updateSearchButton();
  }

  renderSelectionSummary();
}

function selectionBreakdown(items) {
  const files = items.filter((item) => !item.isDir);
  const folders = items.length - files.length;
  const bytes = files.reduce((sum, item) => sum + (item.size || 0), 0);
  const parts = [];
  if (files.length) {
    parts.push(`${files.length} file${files.length === 1 ? "" : "s"}`, formatBytes(bytes));
  }
  if (folders) {
    parts.push(`${folders} folder${folders === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function renderMultiSelectionSummary(label) {
  const items = selectedItems();
  const icon = document.createElement("span");
  icon.className = "browse-entry-icon browse-selection-icon";
  icon.dataset.kind = "multi";
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "browse-selection-name";
  name.textContent = `${items.length} selected`;
  const meta = document.createElement("span");
  meta.className = "browse-selection-meta";
  meta.textContent = selectionBreakdown(items);
  const names = items.slice(0, 12).map((item) => item.name);
  label.title = items.length > names.length ? `${names.join("\n")}\n…and ${items.length - names.length} more` : names.join("\n");
  label.replaceChildren(icon, name, meta);
}

function renderSelectionSummary() {
  const label = remoteBrowser.selectionLabel;
  label.classList.toggle("has-selection", Boolean(currentRemote && selection.size));

  if (currentRemote && selection.size > 1) {
    renderMultiSelectionSummary(label);
    return;
  }

  if (!currentRemote || !selectedPath) {
    label.removeAttribute("title");
    label.textContent = "Nothing selected";
    return;
  }

  const displayPath = selectedPath.includes(":") ? selectedPath.split(":").slice(1).join(":") : selectedPath;
  const displayName = displayPath.split("/").filter(Boolean).pop() || displayPath || "/";
  const icon = document.createElement("span");
  icon.className = "browse-entry-icon browse-selection-icon";
  icon.dataset.kind = entryKind(displayName, selectedIsDir);
  icon.setAttribute("aria-hidden", "true");
  const name = document.createElement("span");
  name.className = "browse-selection-name";
  name.textContent = displayName;
  const meta = document.createElement("span");
  meta.className = "browse-selection-meta";
  meta.textContent = selectedIsDir ? "Folder" : formatBytes(selectedSize);
  label.title = selectedPath;
  label.replaceChildren(icon, name, meta);
}

const browseStorageSlot = document.getElementById("browse-storage");
const browseMeter = browseStorageSlot && window.StorageMeter ? new window.StorageMeter(browseStorageSlot) : null;

function renderBreadcrumbs() {
  browseMeter?.setTarget(currentRemote ? `${currentRemote}:` : null);
  remoteBrowser.breadcrumbs.innerHTML = "";

  if (!currentRemote) {
    return;
  }

  const root = document.createElement("button");
  root.type = "button";
  root.className = "browse-crumb is-root";
  root.textContent = currentRemote;
  root.title = `${currentRemote}:`;
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

  if (vaultBacking.has(currentRemote)) {
    remoteBrowser.breadcrumbs.appendChild(vaultBadge(currentRemote));
  }
  remoteBrowser.breadcrumbs.scrollLeft = remoteBrowser.breadcrumbs.scrollWidth;
}

function entryPath(entry) {
  return formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
}

function selectionItem(entry) {
  return {
    path: entryPath(entry),
    name: entry.name,
    isDir: Boolean(entry.isDir),
    size: typeof entry.size === "number" ? entry.size : null,
  };
}

function syncPrimarySelection() {
  const only = selection.size === 1 ? selection.values().next().value : null;
  selectedPath = only ? only.path : null;
  selectedIsDir = only ? only.isDir : false;
  selectedSize = only ? only.size : null;
}

function clearSelectionState() {
  selection.clear();
  selectionAnchor = null;
  syncPrimarySelection();
}

function pruneSelection(visibleEntries) {
  const visible = new Set(visibleEntries.map(entryPath));
  for (const path of [...selection.keys()]) {
    if (!visible.has(path)) {
      selection.delete(path);
    }
  }
  if (selectionAnchor && !visible.has(selectionAnchor)) {
    selectionAnchor = null;
  }
  syncPrimarySelection();
}

function applySelection() {
  syncPrimarySelection();
  for (const row of remoteBrowser.entriesBody.querySelectorAll("tr[data-path]")) {
    row.classList.toggle("is-selected", selection.has(row.dataset.path));
  }
  updateActionState();
  updatePreviewNavigation();
}

function selectEntry(entry) {
  selection.clear();
  selectionAnchor = null;
  if (entry) {
    const item = selectionItem(entry);
    selection.set(item.path, item);
    selectionAnchor = item.path;
  }
  applySelection();
}

function toggleEntry(entry) {
  const item = selectionItem(entry);
  if (selection.has(item.path)) {
    selection.delete(item.path);
  } else {
    selection.set(item.path, item);
  }
  selectionAnchor = item.path;
  applySelection();
}

function selectRangeTo(entry, { additive = false } = {}) {
  const sorted = getSortedEntries();
  const targetIndex = sorted.indexOf(entry);
  const anchorIndex = selectionAnchor ? sorted.findIndex((item) => entryPath(item) === selectionAnchor) : -1;
  if (targetIndex < 0 || anchorIndex < 0) {
    selectEntry(entry);
    return;
  }
  if (!additive) {
    selection.clear();
  }
  const from = Math.min(anchorIndex, targetIndex);
  const to = Math.max(anchorIndex, targetIndex);
  for (const item of sorted.slice(from, to + 1)) {
    const selected = selectionItem(item);
    selection.set(selected.path, selected);
  }
  applySelection();
}

function selectAllEntries() {
  selection.clear();
  for (const entry of getSortedEntries()) {
    const item = selectionItem(entry);
    selection.set(item.path, item);
  }
  applySelection();
}

function selectedItems() {
  return [...selection.values()];
}

function downloadableItems() {
  return selectedItems().filter((item) => !item.isDir);
}

function handleRowClick(event, entry) {
  if (event.shiftKey) {
    selectRangeTo(entry, { additive: event.ctrlKey || event.metaKey });
  } else if (event.ctrlKey || event.metaKey) {
    toggleEntry(entry);
  } else {
    selectEntry(entry);
  }
}

const MARQUEE_THRESHOLD = 4;
const MARQUEE_EDGE = 36;
const MARQUEE_MAX_SPEED = 22;
let marqueeDrag = null;

function marqueeScroller() {
  return remoteBrowser.tableWrap?.querySelector(".browse-table-scroll") || null;
}

function canStartMarquee(event, scroller) {
  if (event.button !== 0 || !entries.length || event.target.closest("thead, button, a, input, select, textarea")) {
    return false;
  }
  const rect = scroller.getBoundingClientRect();
  return (
    event.clientX < rect.left + scroller.clientLeft + scroller.clientWidth &&
    event.clientY < rect.top + scroller.clientTop + scroller.clientHeight
  );
}

function clientToContent(scroller, clientX, clientY) {
  const rect = scroller.getBoundingClientRect();
  const x = clientX - rect.left - scroller.clientLeft + scroller.scrollLeft;
  const y = clientY - rect.top - scroller.clientTop + scroller.scrollTop;
  return {
    x: Math.min(Math.max(x, 0), scroller.scrollWidth),
    y: Math.min(Math.max(y, 0), scroller.scrollHeight),
  };
}

function collectMarqueeRows(scroller) {
  const entriesByPath = new Map(getSortedEntries().map((entry) => [entryPath(entry), entry]));
  const bounds = scroller.getBoundingClientRect();
  const offsetX = bounds.left + scroller.clientLeft - scroller.scrollLeft;
  const offsetY = bounds.top + scroller.clientTop - scroller.scrollTop;
  const rows = [];
  for (const row of remoteBrowser.entriesBody.querySelectorAll("tr[data-path]")) {
    const entry = entriesByPath.get(row.dataset.path);
    if (!entry) {
      continue;
    }
    const rect = row.getBoundingClientRect();
    rows.push({
      entry,
      path: row.dataset.path,
      left: rect.left - offsetX,
      right: rect.right - offsetX,
      top: rect.top - offsetY,
      bottom: rect.bottom - offsetY,
    });
  }
  return rows;
}

function applyMarqueeHits(drag, hits) {
  const hitItems = hits.map((hit) => selectionItem(hit.entry));
  const next = new Map();
  if (drag.mode === "toggle") {
    const hitPaths = new Set(hitItems.map((item) => item.path));
    for (const [path, item] of drag.base) {
      if (!hitPaths.has(path)) {
        next.set(path, item);
      }
    }
    for (const item of hitItems) {
      if (!drag.base.has(item.path)) {
        next.set(item.path, item);
      }
    }
  } else {
    if (drag.mode === "add") {
      for (const [path, item] of drag.base) {
        next.set(path, item);
      }
    }
    for (const item of hitItems) {
      next.set(item.path, item);
    }
  }
  selection.clear();
  for (const [path, item] of next) {
    selection.set(path, item);
  }
  if (hits.length) {
    const draggedDown = drag.pointerY >= drag.startY;
    selectionAnchor = hits[draggedDown ? hits.length - 1 : 0].path;
  } else if (drag.mode === "replace") {
    selectionAnchor = null;
  }
  applySelection();
}

function restoreMarqueeBase(drag) {
  selection.clear();
  for (const [path, item] of drag.base) {
    selection.set(path, item);
  }
  selectionAnchor = drag.baseAnchor;
  applySelection();
}

function stepMarquee() {
  const drag = marqueeDrag;
  if (!drag) {
    return;
  }
  drag.frame = requestAnimationFrame(stepMarquee);
  const { scroller } = drag;
  const bounds = scroller.getBoundingClientRect();
  const headerHeight = scroller.querySelector("thead")?.offsetHeight || 0;
  const topEdge = bounds.top + scroller.clientTop + headerHeight + MARQUEE_EDGE;
  const bottomEdge = bounds.top + scroller.clientTop + scroller.clientHeight - MARQUEE_EDGE;
  let speed = 0;
  if (drag.clientY < topEdge) {
    speed = -Math.min((topEdge - drag.clientY) / MARQUEE_EDGE, 1.5) * MARQUEE_MAX_SPEED;
  } else if (drag.clientY > bottomEdge) {
    speed = Math.min((drag.clientY - bottomEdge) / MARQUEE_EDGE, 1.5) * MARQUEE_MAX_SPEED;
  }
  if (speed) {
    scroller.scrollTop += speed;
  }

  const point = clientToContent(scroller, drag.clientX, drag.clientY);
  drag.pointerY = point.y;
  const box = {
    left: Math.min(drag.startX, point.x),
    right: Math.max(drag.startX, point.x),
    top: Math.min(drag.startY, point.y),
    bottom: Math.max(drag.startY, point.y),
  };
  const style = drag.element.style;
  style.left = `${box.left}px`;
  style.top = `${box.top}px`;
  style.width = `${box.right - box.left}px`;
  style.height = `${box.bottom - box.top}px`;

  const hits = drag.rows.filter(
    (row) => row.right > box.left && row.left < box.right && row.bottom > box.top && row.top < box.bottom,
  );
  const key = hits.map((hit) => hit.path).join("\n");
  if (key !== drag.hitKey) {
    drag.hitKey = key;
    applyMarqueeHits(drag, hits);
  }
}

function beginMarquee(drag) {
  drag.started = true;
  drag.rows = collectMarqueeRows(drag.scroller);
  drag.element = document.createElement("div");
  drag.element.className = "browse-marquee";
  drag.scroller.append(drag.element);
  remoteBrowser.tableWrap.classList.add("is-marquee-selecting");
  drag.frame = requestAnimationFrame(stepMarquee);
}

function endMarquee({ cancel = false, buttonStillDown = false } = {}) {
  const drag = marqueeDrag;
  if (!drag) {
    return;
  }
  marqueeDrag = null;
  window.removeEventListener("mousemove", handleMarqueeMove, true);
  window.removeEventListener("mouseup", handleMarqueeUp, true);
  window.removeEventListener("keydown", handleMarqueeKey, true);
  window.removeEventListener("blur", handleMarqueeBlur);
  if (!drag.started) {
    return;
  }
  cancelAnimationFrame(drag.frame);
  drag.element.remove();
  remoteBrowser.tableWrap.classList.remove("is-marquee-selecting");
  if (cancel) {
    restoreMarqueeBase(drag);
  }
  swallowNextClick(buttonStillDown);
}

function swallowNextClick(buttonStillDown) {
  const swallowClick = (event) => event.stopPropagation();
  const stopSwallowing = () => setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
  window.addEventListener("click", swallowClick, { capture: true, once: true });
  if (buttonStillDown) {
    window.addEventListener("mouseup", stopSwallowing, { capture: true, once: true });
  } else {
    stopSwallowing();
  }
}

function handleMarqueeMove(event) {
  const drag = marqueeDrag;
  if (!drag) {
    return;
  }
  if (!(event.buttons & 1)) {
    endMarquee();
    return;
  }
  drag.clientX = event.clientX;
  drag.clientY = event.clientY;
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) < MARQUEE_THRESHOLD) {
      return;
    }
    beginMarquee(drag);
  }
  event.preventDefault();
}

function handleMarqueeUp() {
  endMarquee();
}

function handleMarqueeBlur() {
  endMarquee({ cancel: true });
}

function handleMarqueeKey(event) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    endMarquee({ cancel: true, buttonStillDown: true });
  }
}

function handleMarqueeDown(event) {
  const scroller = marqueeScroller();
  if (marqueeDrag || !scroller || !canStartMarquee(event, scroller)) {
    return;
  }
  const start = clientToContent(scroller, event.clientX, event.clientY);
  marqueeDrag = {
    scroller,
    started: false,
    mode: event.ctrlKey || event.metaKey ? "toggle" : event.shiftKey ? "add" : "replace",
    base: new Map(selection),
    baseAnchor: selectionAnchor,
    originX: event.clientX,
    originY: event.clientY,
    clientX: event.clientX,
    clientY: event.clientY,
    startX: start.x,
    startY: start.y,
    pointerY: start.y,
    hitKey: null,
    rows: [],
    element: null,
    frame: 0,
  };
  window.addEventListener("mousemove", handleMarqueeMove, true);
  window.addEventListener("mouseup", handleMarqueeUp, true);
  window.addEventListener("keydown", handleMarqueeKey, true);
  window.addEventListener("blur", handleMarqueeBlur);
}

function renderEntries({ animate = true } = {}) {
  const scrollContainer = remoteBrowser.entriesBody.parentElement;
  const previousScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
  const wasAtBottom= scrollContainer ? scrollContainer.scrollHeight - scrollContainer.scrollTop <= scrollContainer.clientHeight + 10 : false;
  
  const sortedEntries = getSortedEntries();
  
  remoteBrowser.entriesBody.innerHTML = "";

  if (!currentRemote) {
    remoteBrowser.empty.textContent = "Select a remote to browse its files and folders.";
    remoteBrowser.empty.classList.remove("hidden");
  } else if (loading) {
    remoteBrowser.empty.classList.add("hidden");
  } else if (sortedEntries.length === 0) {
    remoteBrowser.empty.textContent = searchEmptyText();
    remoteBrowser.empty.classList.toggle("hidden", !remoteBrowser.empty.textContent);
  } else {
    remoteBrowser.empty.classList.add("hidden");
  }

  for (const [index, entry] of sortedEntries.entries()) {
    const row = document.createElement("tr");
    const rowPath = entryPath(entry);
    row.dataset.path = rowPath;
    row.dataset.index = index;
    row.style.setProperty("--row-index", Math.min(index, 30));
    row.dataset.isdir = entry.isDir ? "1" : "0";
    row.className = `browse-row${entry.isDir ? " is-dir" : " is-file"}${animate ? "" : " is-static"}${selection.has(rowPath) ? " is-selected" : ""}`;
    row.tabIndex = 0;

    const nameCell = document.createElement("td");
    nameCell.className = "browse-col-name";
    const nameWrap = document.createElement("div");
    nameWrap.className = "browse-name-wrap";
    const icon = document.createElement("span");
    icon.className = `browse-entry-icon${entry.isDir ? " is-dir" : " is-file"}`;
    icon.dataset.kind = entryKind(entry.name, entry.isDir);
    icon.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "browse-entry-name";
    if (searchState && entry.name.includes("/")) {
      const slash = entry.name.lastIndexOf("/");
      const label = document.createElement("span");
      label.className = "browse-entry-label";
      label.textContent = entry.name.slice(slash + 1);
      const folder = document.createElement("span");
      folder.className = "browse-entry-folder";
      folder.textContent = entry.name.slice(0, slash);
      name.append(label, folder);
      name.title = entry.name;
    } else {
      name.textContent = entry.name;
    }
    nameWrap.append(icon, name);
    if (searchState) {
      nameWrap.append(createGoToFolderButton(entry));
    }
    nameCell.append(nameWrap);

    const sizeCell = document.createElement("td");
    sizeCell.className = "browse-col-size";
    sizeCell.textContent = entry.isDir ? "—" : formatBytes(entry.size);

    const modCell = document.createElement("td");
    modCell.className = "browse-col-modified";
    modCell.textContent = formatModTime(entry.modTime);

    row.append(nameCell, sizeCell, modCell);

    row.addEventListener("mousedown", (event) => {
      if (event.shiftKey) {
        event.preventDefault();
      }
    });
    row.addEventListener("click", (event) => handleRowClick(event, entry));
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

  if (scrollContainer && !animate) {
    scrollContainer.scrollTop = previousScrollTop;
  } else if (scrollContainer && wasAtBottom) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }
}

async function loadListingForPath(subPath, token) {
  clearSelectionState();
  
  const path = formatRemotePath(currentRemote, subPath);
  
  loadingAbortController = new AbortController();
  const signal = loadingAbortController.signal;
  
  try {
    const result = await window.rcloneGui.listRemotePath(path, { signal });
    setCachedListing(path, result.entries || []);
    if (token !== loadToken) {
      return;
    }
    entries = result.entries || [];
    setStatus(itemCountLabel(entries));
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    if (error.name === "AbortError") {
      entries = [];
      return;
    }
    entries = [];
    setStatus(error.message || "Failed to list remote path.", true);
    notify({
      title: "Browse failed",
      message: error.message || "Failed to list remote path.",
      type: "error",
    });
  }
}

function showCachedListing(path, cached, token) {
  entries = cached;
  setLoading(false);
  currentPreviewIndex = -1;
  renderBreadcrumbs();
  renderEntries();
  updateActionState();
  setStatus(itemCountLabel(entries) ? `${itemCountLabel(entries)} · updating…` : "Updating…");
  void revalidateListing(path, token);
}

async function revalidateListing(path, token) {
  try {
    const result = await window.rcloneGui.listRemotePath(path);
    const fresh = result.entries || [];
    setCachedListing(path, fresh);
    if (token !== loadToken) {
      return;
    }

    if (!sameListing(entries, fresh)) {
      entries = fresh;
      pruneSelection(fresh);
      currentPreviewIndex = -1;
      renderEntries({ animate: false });
      updatePreviewNavigation();
    }
    setStatus(itemCountLabel(entries));
  } catch (error) {
    dropCachedListings(path);
    if (token !== loadToken) {
      return;
    }
    setStatus(error.message || "Failed to list remote path.", true);
  }
}

async function loadListing(context = "") {
  endSearchMode();
  if (!currentRemote || !window.rcloneGui?.listRemotePath) {
    entries = [];
    setLoading(false);
    renderBreadcrumbs();
    renderEntries();
    updateActionState();
    return;
  }

  const token = ++loadToken;
  clearSelectionState();
  setStatus("");

  const listingPath = currentPath();
  const cached = context === "navigate" ? getCachedListing(listingPath) : null;
  if (cached) {
    showCachedListing(listingPath, cached, token);
    return;
  }

  let loadingMessage = "Loading folder…";
  if (context === "refresh") {
    loadingMessage = "Refreshing…";
  } else if (context === "navigate") {
    loadingMessage = "Loading…";
  } else if (context === "delete") {
    loadingMessage = "Updating list…";
  }
  
  setLoading(true, loadingMessage, context);
  renderBreadcrumbs();
  updateActionState();

  loadingAbortController = new AbortController();
  const signal = loadingAbortController.signal;

  try {
    const result = await window.rcloneGui.listRemotePath(listingPath, { signal });
    setCachedListing(listingPath, result.entries || []);
    if (token !== loadToken) {
      return;
    }
    entries = result.entries || [];
    setStatus(itemCountLabel(entries));
  } catch (error) {
    if (token !== loadToken) {
      return;
    }
    if (error.name === "AbortError") {
      entries = [];
      setStatus("Loading cancelled.", false);
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
    loadingAbortController = null;
    if (token === loadToken) {
      setLoading(false);
      currentPreviewIndex = -1;
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
    subPath: trimSlashes(String(subPath || "").replace(/\\/g, "/")),
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
  endSearchMode();
  const targetSubPath = trimSlashes(String(subPath || "").replace(/\\/g, "/"));
  
  const token = ++loadToken;
  const targetPath = formatRemotePath(currentRemote, targetSubPath);
  const cached = getCachedListing(targetPath);
  if (cached) {
    clearSelectionState();
    currentSubPath = targetSubPath;
    if (recordHistory) {
      pushBrowseHistory(currentRemote, currentSubPath);
    }
    showCachedListing(targetPath, cached, token);
    return;
  }

  setLoading(true, "Loading…", "navigate");
  updateActionState();

  try {
    await loadListingForPath(targetSubPath, token);
    
    if (token === loadToken) {
      currentSubPath = targetSubPath;
      if (recordHistory) {
        pushBrowseHistory(currentRemote, currentSubPath);
      }
      renderBreadcrumbs();
    }
  } finally {
    if (token === loadToken) {
      setLoading(false);
      currentPreviewIndex = -1;
      renderEntries();
      updateActionState();
    }
  }
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
  await loadListing("navigate");
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
  await loadListing("navigate");
  return true;
}

function fillRemotePicker() {
  const previous = remoteBrowser.remotePicker.value || currentRemote;
  remoteBrowser.remotePicker.innerHTML =
    '<option value="">Select a configured remote...</option>';

  for (const remote of browseRemotes) {
    const option = document.createElement("option");
    option.value = remote;
    remoteBrowser.remotePicker.appendChild(option);
  }
  labelRemoteOptions();

  if (browseRemotes.includes(previous)) {
    remoteBrowser.remotePicker.value = previous;
    currentRemote = previous;
  } else {
    remoteBrowser.remotePicker.value = "";
    currentRemote = "";
    currentSubPath = "";
    entries = [];
    clearSelectionState();
    resetBrowseHistory("");
  }

  renderBreadcrumbs();
  renderEntries();
  updateActionState();
}

function setRemotes(names) {
  browseRemotes = Array.isArray(names) ? [...names] : [];
  fillRemotePicker();
  restoreLastUploadTarget();
  void refreshVaults();
}

function labelRemoteOptions() {
  for (const option of remoteBrowser.remotePicker.options) {
    if (option.value) {
      option.textContent = vaultBacking.has(option.value) ? `${option.value} 🔒` : option.value;
    }
  }
}

async function refreshVaults() {
  const lookup = ++vaultLookup;
  let entries = [];
  try {
    entries = (await window.rcloneGui?.listRemoteEntries?.()) || [];
  } catch {
    return;
  }
  if (lookup !== vaultLookup) {
    return;
  }
  vaultBacking = new Map(entries.filter((entry) => entry.type === "crypt").map((entry) => [entry.name, entry.backing || ""]));
  labelRemoteOptions();
  renderBreadcrumbs();
}

function vaultBadge(remote) {
  const badge = document.createElement("span");
  badge.className = "browse-vault-badge";
  const backing = vaultBacking.get(remote);
  badge.title = backing
    ? `Files here are encrypted on this PC before they're stored in ${backing}`
    : "Files here are encrypted on this PC before they're stored";
  badge.innerHTML =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>';
  badge.append(document.createTextNode("Encrypted vault"));
  return badge;
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
  if (!path || selection.size > 1 || typeof onUsePath !== "function") {
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

const PREVIEW_KINDS = new Set(["text", "pdf", "image", "audio", "video", "zip"]);
const PREVIEW_KIND_LABELS = {
  text: "Text",
  pdf: "PDF document",
  image: "Image",
  audio: "Audio",
  video: "Video",
  zip: "Archive",
};
const PREVIEW_EXIT_MS = 340;
const previewExtras = {
  meta: document.getElementById("preview-meta"),
  position: document.getElementById("preview-position"),
  loaderText: document.getElementById("preview-loader-text"),
  audioTitle: document.getElementById("preview-audio-title"),
  audioSub: document.getElementById("preview-audio-sub"),
};
let previewCleanupTimer = 0;
let previewSwap = null;

function previewCard() {
  return previewUi.dialog?.querySelector(".popup-card-preview") || null;
}

function isPreviewDialogOpen() {
  return Boolean(previewUi.dialog && !previewUi.dialog.classList.contains("hidden"));
}

function setPreviewPending(pending, label) {
  const card = previewCard();
  if (!card) {
    return;
  }
  if (pending && previewExtras.loaderText) {
    previewExtras.loaderText.textContent = label || "Loading…";
  }
  card.classList.toggle("is-pending", Boolean(pending));
}

function stopPreviewMedia() {
  if (previewUi.video) {
    previewUi.video.pause();
    previewUi.video.removeAttribute("src");
    previewUi.video.replaceChildren();
    previewUi.video.load();
  }
  if (previewUi.audio) {
    previewUi.audio.pause();
    previewUi.audio.removeAttribute("src");
    previewUi.audio.load();
  }
  previewUi.audioWrap?.classList.remove("is-playing");
}

function previewFileExtension(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : "";
}

function renderPreviewMeta(payload) {
  const ext = previewFileExtension(payload.name);
  const kindLabel = PREVIEW_KIND_LABELS[payload.kind] || "File";
  const bytes = payload.kind === "zip" && typeof payload.archiveBytes === "number" ? payload.archiveBytes : selectedSize;
  const chips = [ext || kindLabel];
  if (typeof bytes === "number" && bytes >= 0) {
    chips.push(formatBytes(bytes));
  }

  if (previewExtras.meta) {
    previewExtras.meta.replaceChildren(
      ...chips.map((text) => {
        const chip = document.createElement("span");
        chip.className = "preview-chip";
        chip.textContent = text;
        return chip;
      }),
    );
  }

  if (previewExtras.position) {
    const total = previewableFiles.length;
    const showPosition = currentPreviewIndex >= 0 && total > 1;
    previewExtras.position.textContent = showPosition ? `${currentPreviewIndex + 1} / ${total}` : "";
    previewExtras.position.classList.toggle("hidden", !showPosition);
  }

  if (payload.kind === "audio") {
    if (previewExtras.audioTitle) {
      previewExtras.audioTitle.textContent = payload.name || "Audio";
    }
    if (previewExtras.audioSub) {
      previewExtras.audioSub.textContent = [ext ? `${ext} audio` : kindLabel, chips[1]].filter(Boolean).join(" · ");
    }
  }
}

function wirePreviewMediaState() {
  const settle = () => setPreviewPending(false);
  for (const media of [previewUi.video, previewUi.audio]) {
    media?.addEventListener("loadeddata", settle);
    media?.addEventListener("error", settle);
  }
  previewUi.audio?.addEventListener("play", () => previewUi.audioWrap?.classList.add("is-playing"));
  previewUi.audio?.addEventListener("pause", () => previewUi.audioWrap?.classList.remove("is-playing"));
  previewUi.audio?.addEventListener("ended", () => previewUi.audioWrap?.classList.remove("is-playing"));
  previewUi.image?.addEventListener("load", () => previewUi.image.classList.add("is-loaded"));
  previewUi.image?.addEventListener("error", () => previewUi.image.classList.add("is-loaded"));
}

wirePreviewMediaState();

function clearPreviewContent() {
  clearTimeout(previewCleanupTimer);
  if (previewBlobUrl) {
    URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = null;
  }

  stopPreviewMedia();
  previewUi.video?.classList.add("hidden");
  previewUi.image?.classList.remove("is-loaded");
  setPreviewPending(false);

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
  activePreviewToken = 0;
  stopPreviewMedia();
  void window.rcloneGui?.closeRemotePreview?.();
  if (!previewUi.dialog) {
    clearPreviewContent();
    return;
  }
  previewUi.dialog.classList.add("hidden");
  previewUi.dialog.setAttribute("aria-hidden", "true");
  clearTimeout(previewCleanupTimer);
  previewCleanupTimer = setTimeout(() => {
    if (!isPreviewDialogOpen()) {
      clearPreviewContent();
    }
  }, PREVIEW_EXIT_MS);
}

function shouldAnimatePreviewSwap() {
  return (
    isPreviewDialogOpen() &&
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function openPreviewDialog(payload) {
  if (!PREVIEW_KINDS.has(payload?.kind)) {
    throw new Error("Unsupported preview type.");
  }
  clearTimeout(previewCleanupTimer);

  if (!shouldAnimatePreviewSwap()) {
    renderPreviewPayload(payload);
    return;
  }

  const swap = document.startViewTransition(() => renderPreviewPayload(payload));
  previewSwap = swap;
  swap.ready.catch(() => {});
  swap.finished.catch(() => {});
  swap.updateCallbackDone
    .catch(() => {})
    .finally(() => {
      if (previewSwap === swap) {
        previewSwap = null;
      }
    });
}

function renderPreviewPayload(payload) {
  clearPreviewContent();

  previewUi.title.textContent = payload.name || "Preview";
  previewUi.title.title = payload.name || "";
  previewUi.subtitle.textContent = payload.statusText || selectedPath || "";
  const card = previewCard();
  card?.classList.toggle("is-video", payload.kind === "video");
  if (card) {
    card.dataset.kind = payload.kind;
  }
  renderPreviewMeta(payload);
  if ((payload.kind === "audio" || payload.kind === "video") && !payload.streamUrl && !payload.data) {
    setPreviewPending(true, payload.statusText || "Connecting stream…");
  }

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
  return trimSlashes(String(name || "").replace(/\\/g, "/"));
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

  const next = trimSlashes(String(path || "").replace(/\\/g, "/"));

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
  const parts = [
    `${listing.length.toLocaleString()} item${listing.length === 1 ? "" : "s"} here`,
    `${total.toLocaleString()} in archive`,
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
    cell.className = "preview-zip-empty";
    cell.textContent = zipPreviewState.currentPath ? "This folder is empty." : "This archive is empty.";
    row.appendChild(cell);
    previewUi.zipEntries.appendChild(row);
    return;
  }

  for (const [index, entry] of listing.entries()) {
    const row = document.createElement("tr");
    row.className = `preview-zip-row${entry.isDir ? " is-dir" : " is-file"}`;
    row.style.setProperty("--i", String(Math.min(index, 14)));
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
    icon.className = `browse-entry-icon preview-zip-icon${entry.isDir ? " is-dir" : " is-file"}`;
    icon.dataset.kind = entryKind(entry.name, entry.isDir);
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
    const ratio = entry.isDir || !(entry.size > 0) || !(entry.compressedSize >= 0) ? null : entry.compressedSize / entry.size;
    if (ratio !== null) {
      const meter = document.createElement("span");
      meter.className = "preview-zip-ratio";
      meter.style.setProperty("--ratio", String(Math.min(ratio, 1)));
      meter.setAttribute("aria-hidden", "true");
      packedCell.title = `${Math.round(Math.min(ratio, 1) * 100)}% of original size`;
      packedCell.prepend(meter);
    }

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
  if (previewSwap) {
    const token = activePreviewToken;
    previewSwap.updateCallbackDone
      .catch(() => {})
      .then(() => {
        if (activePreviewToken === token) {
          bindStreamMedia(kind, streamUrl, mime);
        }
      });
    return;
  }

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

  void media.play().catch(() => setPreviewPending(false));
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
    const token = beginPreview();
    updateActionState();
    try {
      const payload = await window.rcloneGui.openRemotePreview(remotePath);
      if (!isPreviewCurrent(token)) {
        releaseStalePreview();
        return;
      }
      if (previewUi.subtitle) {
        previewUi.subtitle.textContent = selectedPath || "";
      }
      bindStreamMedia(kind, payload.streamUrl, payload.mime);
    } catch (error) {
      if (!isPreviewCurrent(token)) {
        return;
      }
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
    const token = beginPreview();
    updateActionState();
    try {
      const payload = await window.rcloneGui.openRemotePreview(remotePath, { size: fileSize });
      if (!isPreviewCurrent(token)) {
        return;
      }
      if (previewUi.subtitle) {
        previewUi.subtitle.textContent = selectedPath || "";
      }
      openPreviewDialog(payload);
    } catch (error) {
      if (!isPreviewCurrent(token)) {
        return;
      }
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

  const token = beginPreview();
  setLoading(true, "Preparing preview…", "preview");
  if (isPreviewDialogOpen()) {
    setPreviewPending(true, "Loading preview…");
  }
  updateActionState();

  try {
    const payload = await window.rcloneGui.openRemotePreview(remotePath, { size: fileSize });
    if (!isPreviewCurrent(token) || payload?.cancelled) {
      return;
    }
    openPreviewDialog(payload);
  } catch (error) {
    if (!isPreviewCurrent(token)) {
      return;
    }
    activePreviewToken = 0;
    void window.rcloneGui?.closeRemotePreview?.();
    notify({
      title: "Preview failed",
      message: error.message || "Could not open a preview.",
      type: "error",
    });
  } finally {
    if (isPreviewCurrent(token) || activePreviewToken === 0) {
      if (!previewSwap) {
        setPreviewPending(false);
      }
      if (loadingContext === "preview") {
        setLoading(false);
      }
    }
    updateActionState();
  }
}

function localJoin(folder, name) {
  const separator = window.rcloneGui?.platform === "win32" ? "\\" : "/";
  return /[\\/]$/.test(folder) ? folder + name : folder + separator + name;
}

function uniqueLocalNames(items) {
  const used = new Map();
  return items.map((item) => {
    const base = item.name.split("/").pop() || "download";
    const key = base.toLowerCase();
    const seen = used.get(key) || 0;
    used.set(key, seen + 1);
    if (!seen) {
      return base;
    }
    const dot = base.lastIndexOf(".");
    return dot > 0 ? `${base.slice(0, dot)} (${seen + 1})${base.slice(dot)}` : `${base} (${seen + 1})`;
  });
}

async function downloadSelection() {
  const files = downloadableItems();
  if (!files.length || loading) {
    return;
  }
  if (!window.rcloneGui?.pickFolder || !window.rcloneGui?.downloadRemoteFile) {
    notify({ title: "Download unavailable", message: "App bridge does not support downloads.", type: "error" });
    return;
  }

  let folder;
  try {
    folder = await window.rcloneGui.pickFolder();
  } catch (error) {
    notify({ title: "Download failed", message: error.message || "Could not open the folder picker.", type: "error" });
    return;
  }
  if (!folder || downloadPanel.cancelling) {
    return;
  }

  const names = uniqueLocalNames(files);
  files.forEach((item, index) => {
    downloadPanel.enqueue({
      remotePath: item.path,
      localPath: localJoin(folder, names[index]),
      items: [{ name: names[index], size: item.size || 0, isDir: false }],
    });
  });

  const skippedFolders = selection.size - files.length;
  if (skippedFolders) {
    notify({
      title: `Downloading ${files.length} file${files.length === 1 ? "" : "s"}`,
      message: `${skippedFolders} folder${skippedFolders === 1 ? " was" : "s were"} left out. Folders can be copied with a job instead.`,
      type: "success",
    });
  }
}

async function downloadSelectedFile() {
  if (selection.size > 1) {
    await downloadSelection();
    return;
  }
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
  const name = selectedFileName();
  const size = selectedSize || 0;
  let localPath;
  try {
    localPath = await window.rcloneGui.pickSaveFile(name);
  } catch (error) {
    notify({
      title: "Download failed",
      message: error.message || "Could not open the save dialog.",
      type: "error",
    });
    return;
  }

  if (!localPath || downloadPanel.cancelling) {
    return;
  }

  downloadPanel.enqueue({ remotePath, localPath, items: [{ name, size, isDir: false }] });
}


function canUpload() {
  return Boolean(currentRemote) && !loading && Boolean(window.rcloneGui?.uploadToRemote);
}

function canPickUpload() {
  return canUpload() && Boolean(window.rcloneGui?.pickUploadFiles);
}

function canCreateFolder() {
  return Boolean(currentRemote) && !loading && Boolean(window.rcloneGui?.createRemoteFolder);
}

async function pickAndUpload() {
  if (!canPickUpload()) {
    return;
  }
  const paths = await window.rcloneGui.pickUploadFiles();
  await uploadToCurrentFolder(paths);
}

function localBaseName(localPath) {
  return String(localPath).split(/[\\/]/).filter(Boolean).pop() || String(localPath);
}

const transferStack = document.getElementById("transfer-stack");

const uploadPanel = new TransferPanel(transferStack, {
  labels: { active: "Uploading", noun: "Upload", past: "uploaded", direction: "up" },
  formatBytes,
  subscribe: (onProgress) => window.rcloneGui.onUploadProgress?.(onProgress),
  runBatch: async (batch) => {
    const result = await window.rcloneGui.uploadToRemote({
      remotePath: batch.targetPath,
      localPaths: batch.items.map((item) => item.path),
    });
    return { completed: result.uploaded, failed: result.failed, cancelled: result.cancelled };
  },
  cancel: () => window.rcloneGui?.cancelUpload?.(),
  onBatchFinished: (batch) => {
    refreshAfterUpload(batch.targetPath);
    browseMeter?.refresh();
  },
});

const downloadPanel = new TransferPanel(transferStack, {
  labels: { active: "Downloading", noun: "Download", past: "downloaded", direction: "down" },
  formatBytes,
  subscribe: (onProgress) => window.rcloneGui.onDownloadProgress?.(onProgress),
  runBatch: async (batch) => {
    const result = await window.rcloneGui.downloadRemoteFile({
      remotePath: batch.remotePath,
      localPath: batch.localPath,
    });
    return result.cancelled
      ? { completed: 0, cancelled: true }
      : { completed: 1, detail: result.localPath };
  },
  cancel: () => window.rcloneGui?.cancelDownload?.(),
});

function refreshAfterUpload(targetPath) {
  if (currentPath() === targetPath && !loading) {
    void revalidateListing(targetPath, loadToken);
  } else {
    dropCachedListings(targetPath);
  }
}

function confirmReplace(names) {
  const { replaceDialog, replaceMessage, replaceCancelBtn, replaceConfirmBtn } = remoteBrowser;
  if (!replaceDialog) {
    return Promise.resolve(true);
  }

  if (names.length === 1) {
    replaceMessage.textContent = `"${names[0]}" already exists in this folder. Replace it?`;
  } else {
    const listed = names.slice(0, 3).map((name) => `"${name}"`).join(", ");
    const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
    replaceMessage.textContent = `${names.length} items already exist in this folder: ${listed}${more}. Replace them?`;
  }

  replaceDialog.classList.remove("hidden");
  replaceDialog.setAttribute("aria-hidden", "false");
  replaceConfirmBtn.focus();

  return new Promise((resolve) => {
    const backdrop = replaceDialog.querySelector("[data-upload-replace-close]");
    const finish = (confirmed) => {
      replaceDialog.classList.add("hidden");
      replaceDialog.setAttribute("aria-hidden", "true");
      replaceConfirmBtn.removeEventListener("click", onConfirm);
      replaceCancelBtn.removeEventListener("click", onCancel);
      backdrop?.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeydown, true);
      resolve(confirmed);
    };
    const onConfirm = () => finish(true);
    const onCancel = () => finish(false);
    const onKeydown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish(false);
      }
    };

    replaceConfirmBtn.addEventListener("click", onConfirm);
    replaceCancelBtn.addEventListener("click", onCancel);
    backdrop?.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeydown, true);
  });
}

async function uploadToCurrentFolder(localPaths) {
  const paths = (localPaths || []).filter(Boolean);
  if (!paths.length || !canUpload()) {
    return;
  }

  const targetPath = currentPath();
  const existing = new Set(entries.map((entry) => entry.name));
  const conflicts = paths.map(localBaseName).filter((name) => existing.has(name));
  if (conflicts.length && !(await confirmReplace(conflicts))) {
    return;
  }
  if (!canUpload() || currentPath() !== targetPath || uploadPanel.cancelling) {
    return;
  }

  const measured = window.rcloneGui.measureLocalPaths
    ? await window.rcloneGui.measureLocalPaths(paths).catch(() => null)
    : null;
  const items = paths.map((localPath, index) => ({
    path: localPath,
    name: localBaseName(localPath),
    isDir: Boolean(measured?.[index]?.isDir),
    size: Number(measured?.[index]?.size) || 0,
  }));

  uploadPanel.enqueue({ targetPath, items });
  try {
    localStorage.setItem(LAST_UPLOAD_KEY, JSON.stringify({ remote: currentRemote, subPath: currentSubPath }));
  } catch {}
  return true;
}

function restoreLastUploadTarget() {
  if (currentRemote || !pendingUploads.length) {
    return;
  }
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(LAST_UPLOAD_KEY) || "null");
  } catch {}
  if (!last?.remote || !browseRemotes.includes(last.remote)) {
    return;
  }
  remoteBrowser.remotePicker.value = last.remote;
  currentRemote = last.remote;
  resetBrowseHistory(last.remote, "");
  void navigateTo(last.subPath || "");
}

function renderPendingUpload() {
  const bar = document.getElementById("browse-pending-upload");
  if (!bar) {
    return;
  }
  bar.classList.toggle("hidden", pendingUploads.length === 0);
  if (!pendingUploads.length) {
    return;
  }
  const names = pendingUploads.map(localBaseName);
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const title = document.getElementById("browse-pending-title");
  title.textContent = `${names.length} item${names.length === 1 ? "" : "s"} from Explorer: ${shown}${more}`;
  title.title = pendingUploads.join("\n");
  document.getElementById("browse-pending-hint").textContent = currentRemote
    ? `Will upload to ${currentPath()}. Go to another folder first if you like.`
    : "Pick a remote, go to the folder you want, then click Upload here.";
  document.getElementById("browse-pending-go").disabled = !canUpload();
}

function queueUpload(paths) {
  for (const localPath of paths || []) {
    if (typeof localPath === "string" && localPath && !pendingUploads.includes(localPath)) {
      pendingUploads.push(localPath);
    }
  }
  restoreLastUploadTarget();
  renderPendingUpload();
}

function bindPendingUpload() {
  document.getElementById("browse-pending-cancel")?.addEventListener("click", () => {
    pendingUploads = [];
    renderPendingUpload();
  });
  document.getElementById("browse-pending-go")?.addEventListener("click", async () => {
    const paths = [...pendingUploads];
    if (await uploadToCurrentFolder(paths)) {
      pendingUploads = pendingUploads.filter((localPath) => !paths.includes(localPath));
      renderPendingUpload();
    }
  });
}

function bindUploadDrop() {
  const dropZone = remoteBrowser.tableWrap;
  if (!dropZone) {
    return;
  }

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  let dragDepth = 0;

  document.addEventListener("dragover", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });
  document.addEventListener("drop", (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
    }
  });

  dropZone.addEventListener("dragenter", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    dropZone.classList.toggle("is-drop-target", canUpload());
  });

  dropZone.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = canUpload() ? "copy" : "none";
  });

  dropZone.addEventListener("dragleave", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropZone.classList.remove("is-drop-target");
    }
  });

  dropZone.addEventListener("drop", (event) => {
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("is-drop-target");
    if (!canUpload() || !window.rcloneGui?.getPathForFile) {
      return;
    }
    const paths = Array.from(event.dataTransfer.files || [])
      .map((file) => window.rcloneGui.getPathForFile(file))
      .filter(Boolean);
    void uploadToCurrentFolder(paths);
  });
}

function remoteSidePath(path) {
  return path.includes(":") ? path.split(":").slice(1).join(":") : path;
}

function describeDeleteTargets(items) {
  if (items.length === 1) {
    const [item] = items;
    const pathLabel = document.createElement("strong");
    pathLabel.className = "delete-card-path";
    pathLabel.textContent = remoteSidePath(item.path);
    return {
      title: item.isDir ? "Delete this folder?" : "Delete this file?",
      message: [
        pathLabel,
        item.isDir ? `Everything inside it will be removed from ${currentRemote}.` : `It will be removed from ${currentRemote}.`,
      ],
    };
  }

  const shown = items.slice(0, 3).map((item) => item.name.split("/").pop());
  const more = items.length - shown.length;
  const pathLabel = document.createElement("strong");
  pathLabel.className = "delete-card-path";
  pathLabel.textContent = more ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
  const hasFolders = items.some((item) => item.isDir);
  return {
    title: `Delete ${items.length} items?`,
    message: [
      pathLabel,
      hasFolders
        ? `They'll be removed from ${currentRemote}, folders with everything inside them.`
        : `They'll be removed from ${currentRemote}.`,
    ],
  };
}

function confirmDelete(items) {
  const deleteDialog = document.getElementById("delete-dialog");
  const deleteTitle = document.getElementById("delete-title");
  const deleteMessage = document.getElementById("delete-message");
  const deleteConfirmBtn = document.getElementById("delete-confirm");
  const deleteCancelBtn = document.getElementById("delete-cancel");

  if (!deleteDialog || !deleteTitle || !deleteMessage || !deleteConfirmBtn || !deleteCancelBtn) {
    notify({
      title: "Delete unavailable",
      message: "Delete dialog not available.",
      type: "error",
    });
    return Promise.resolve(false);
  }

  const { title, message } = describeDeleteTargets(items);
  deleteTitle.textContent = title;
  deleteMessage.replaceChildren(...message);
  deleteConfirmBtn.textContent = items.length > 1 ? `Delete ${items.length} items` : "Delete";
  deleteDialog.classList.remove("hidden");
  deleteDialog.setAttribute("aria-hidden", "false");
  deleteConfirmBtn.focus();

  return new Promise((resolve) => {
    const backdrop = deleteDialog.querySelector("[data-delete-close]");
    const finish = (confirmed) => {
      deleteDialog.classList.add("hidden");
      deleteDialog.setAttribute("aria-hidden", "true");
      deleteConfirmBtn.removeEventListener("click", handleConfirm);
      deleteCancelBtn.removeEventListener("click", handleCancel);
      backdrop?.removeEventListener("click", handleCancel);
      document.removeEventListener("keydown", handleKeydown);
      resolve(confirmed);
    };
    const handleConfirm = () => finish(true);
    const handleCancel = () => finish(false);
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        finish(false);
      }
    };

    deleteConfirmBtn.addEventListener("click", handleConfirm);
    deleteCancelBtn.addEventListener("click", handleCancel);
    backdrop?.addEventListener("click", handleCancel);
    document.addEventListener("keydown", handleKeydown);
  });
}

function notifyDeleteResult(deleted, failed, total) {
  if (!failed.length) {
    if (total === 1) {
      const deletedPath = remoteSidePath(deleted[0].path);
      notify({
        title: "Delete complete",
        message: [`${currentRemote}: `, { strong: deletedPath }],
        type: "success",
      });
    } else {
      notify({
        title: "Delete complete",
        message: [{ strong: `${total} items` }, ` removed from ${currentRemote}.`],
        type: "success",
      });
    }
    return;
  }

  const firstError = failed[0].error?.message || "Could not delete the file.";
  notify({
    title: deleted.length ? `Deleted ${deleted.length} of ${total}` : "Delete failed",
    message: total === 1 ? firstError : `${failed.length} couldn't be deleted. First error: ${firstError}`,
    type: "error",
  });
}

async function deleteSelectedFile() {
  const items = selectedItems();
  if (!items.length || loading) {
    return;
  }

  if (!window.rcloneGui?.deleteRemoteFile) {
    notify({
      title: "Delete unavailable",
      message: "App bridge does not support deleting.",
      type: "error",
    });
    return;
  }

  const confirmed = await confirmDelete(items);
  if (!confirmed) {
    return;
  }

  const rows = [...remoteBrowser.entriesBody.querySelectorAll("tr.is-selected")];
  if (rows.length) {
    rows.forEach((row) => row.classList.add("is-deleting"));
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const deleted = [];
  const failed = [];
  updateActionState();

  try {
    for (const [index, item] of items.entries()) {
      setLoading(true, items.length > 1 ? `Deleting ${index + 1} of ${items.length}…` : "Deleting…", "delete");
      try {
        await window.rcloneGui.deleteRemoteFile({ remotePath: item.path, isDir: item.isDir });
        dropCachedListings(item.path);
        deleted.push(item);
        if (searchState) {
          removeSearchResult(item.path);
        }
      } catch (error) {
        failed.push({ item, error });
      }
    }

    notifyDeleteResult(deleted, failed, items.length);
    if (deleted.length) {
      browseMeter?.refresh();
    }
    if (!searchState) {
      setLoading(false);
      await loadListing("delete");
    }
  } finally {
    setLoading(false);
    rows.forEach((row) => row.classList.remove("is-deleting"));
    updateActionState();
  }
}

function matchCount(count) {
  return `${count.toLocaleString()} ${count === 1 ? "match" : "matches"}`;
}

function searchEmptyText() {
  if (!searchState) {
    return "This folder is empty.";
  }
  if (searchState.running) {
    return "Searching…";
  }
  if (searchState.error) {
    return "";
  }
  return `Nothing named like “${searchState.query}” in this folder or its subfolders.`;
}

function renderSearchBar() {
  const bar = remoteBrowser.searchBar;
  if (!bar) {
    return;
  }
  if (!searchState) {
    bar.classList.add("hidden");
    return;
  }

  const { query, running, scanned, limited, stopped, warning, error } = searchState;
  const scope = currentPath().replace(/:$/, "");
  let text;
  if (error) {
    text = `Search failed: ${error}`;
  } else if (running) {
    text = `Searching for “${query}” in ${scope} · ${matchCount(entries.length)} so far, ${scanned.toLocaleString()} items checked`;
  } else {
    text = `${matchCount(entries.length)} for “${query}” in ${scope}`;
    if (limited) {
      text += " · only the first 1,000 are shown, try a more specific search";
    } else if (stopped) {
      text += " · stopped early";
    }
    if (warning) {
      text += ` · some folders couldn't be read: ${warning}`;
    }
  }

  bar.classList.remove("hidden");
  bar.classList.toggle("is-error", Boolean(error));
  remoteBrowser.searchSpinner.classList.toggle("hidden", !running);
  remoteBrowser.searchStopBtn.classList.toggle("hidden", !running);
  remoteBrowser.searchSummary.textContent = text;
}

function queueSearchRender() {
  if (searchRenderQueued) {
    return;
  }
  searchRenderQueued = true;
  requestAnimationFrame(() => {
    searchRenderQueued = false;
    if (searchState) {
      renderEntries({ animate: false });
      renderSearchBar();
    }
  });
}

function endSearchMode() {
  if (!searchState) {
    return false;
  }
  if (searchState.running) {
    void window.rcloneGui.cancelRemoteSearch?.();
  }
  searchState = null;
  searchToken += 1;
  if (remoteBrowser.searchInput) {
    remoteBrowser.searchInput.value = "";
    updateSearchButton();
  }
  renderSearchBar();
  return true;
}

function exitSearch() {
  if (endSearchMode()) {
    void loadListing("navigate");
  }
}

async function startSearch() {
  const query = remoteBrowser.searchInput.value.trim();
  if (!currentRemote || !window.rcloneGui?.searchRemote) {
    return;
  }
  if (!query) {
    exitSearch();
    return;
  }

  if (searchState?.running) {
    void window.rcloneGui.cancelRemoteSearch();
  }
  const token = ++searchToken;
  loadToken += 1;
  loadingAbortController?.abort();
  loadingAbortController = null;
  setLoading(false);
  searchState = { query, token, running: true, scanned: 0, limited: false, stopped: false, warning: "", error: "" };
  entries = [];
  clearSelectionState();
  setStatus("");
  renderEntries();
  renderSearchBar();

  const response = await window.rcloneGui.searchRemote({ remotePath: currentPath(), query, token });
  if (!searchState || searchState.token !== token) {
    return;
  }
  searchState.running = false;
  if (response.ok) {
    searchState.scanned = response.scanned;
    searchState.limited = response.limited;
    searchState.warning = response.warning || "";
  } else if (response.cancelled) {
    searchState.stopped = true;
  } else {
    searchState.error = response.message || "Unknown error.";
  }
  renderEntries({ animate: false });
  renderSearchBar();
}

function createGoToFolderButton(entry) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browse-goto-folder";
  button.title = "Open the folder this is in";
  button.setAttribute("aria-label", `Open the folder containing ${entry.name}`);
  button.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M10 13h6m-2-2 2 2-2 2" /></svg>';
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    void goToContainingFolder(entry);
  });
  button.addEventListener("dblclick", (event) => event.stopPropagation());
  button.addEventListener("keydown", (event) => event.stopPropagation());
  return button;
}

async function goToContainingFolder(entry) {
  const itemSubPath = joinSubPath(currentSubPath, entry.name);
  await navigateTo(parentSubPath(itemSubPath));
  const itemPath = formatRemotePath(currentRemote, itemSubPath);
  const target = entries.find((candidate) => formatRemotePath(currentRemote, joinSubPath(currentSubPath, candidate.name)) === itemPath);
  if (!target) {
    return;
  }
  selectEntry(target);
  const row = [...remoteBrowser.entriesBody.querySelectorAll("tr")].find((candidate) => candidate.dataset.path === itemPath);
  row?.scrollIntoView({ block: "center" });
  row?.focus({ preventScroll: true });
}

function removeSearchResult(remotePath) {
  entries = entries.filter((entry) => {
    const path = entryPath(entry);
    return path !== remotePath && !path.startsWith(`${remotePath}/`);
  });
  pruneSelection(entries);
  renderEntries({ animate: false });
  renderSearchBar();
}

function updateSearchButton() {
  if (remoteBrowser.searchGoBtn) {
    remoteBrowser.searchGoBtn.disabled = !currentRemote || !remoteBrowser.searchInput.value.trim();
  }
}

function bindSearch() {
  const input = remoteBrowser.searchInput;
  if (!input || !window.rcloneGui?.searchRemote) {
    return;
  }

  input.addEventListener("input", updateSearchButton);
  remoteBrowser.searchGoBtn?.addEventListener("click", () => void startSearch());

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void startSearch();
    } else if (event.key === "Escape" && (searchState || input.value)) {
      event.preventDefault();
      event.stopPropagation();
      if (searchState) {
        exitSearch();
      } else {
        input.value = "";
      }
    }
  });
  input.addEventListener("search", () => {
    if (!input.value && searchState) {
      exitSearch();
    }
  });

  remoteBrowser.searchStopBtn?.addEventListener("click", () => {
    void window.rcloneGui.cancelRemoteSearch();
  });
  remoteBrowser.searchExitBtn?.addEventListener("click", exitSearch);

  window.rcloneGui.onRemoteSearchResults(({ token, items, scanned }) => {
    if (!searchState || token !== searchState.token) {
      return;
    }
    entries.push(...items);
    searchState.scanned = scanned;
    queueSearchRender();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f" && isBrowseViewVisible() && !input.disabled) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

function showNewFolderDialog() {
  const newFolderDialog = document.getElementById("new-folder-dialog");
  const newFolderNameInput = document.getElementById("new-folder-name");
  const newFolderTitle = document.getElementById("new-folder-title");
  const newFolderCreateBtn = document.getElementById("new-folder-create");
  const newFolderCancelBtn = document.getElementById("new-folder-cancel");

  if (!newFolderDialog || !newFolderNameInput || !newFolderTitle || !newFolderCreateBtn || !newFolderCancelBtn) {
    notify({
      title: "Error",
      message: "New folder dialog elements not found.",
      type: "error",
    });
    return;
  }

  // Set up the dialog
  newFolderNameInput.value = "Untitled folder";
  newFolderNameInput.select();
  newFolderDialog.classList.remove("hidden");
  newFolderDialog.setAttribute("aria-hidden", "false");
  newFolderCreateBtn.focus();

  const cleanup = () => {
    newFolderDialog.classList.add("hidden");
    newFolderDialog.setAttribute("aria-hidden", "true");
    newFolderCreateBtn.removeEventListener("click", handleCreate);
    newFolderCancelBtn.removeEventListener("click", handleCancel);
    const backdrop = newFolderDialog.querySelector("[data-new-folder-close]");
    if (backdrop) {
      backdrop.removeEventListener("click", handleCancel);
    }
  };

  const handleCreate = async () => {
    const folderName = newFolderNameInput.value.trim();
    if (!folderName) {
      notify({
        title: "Error",
        message: "Folder name cannot be empty.",
        type: "error",
      });
      return;
    }

    cleanup();

    if (!currentRemote) {
      notify({
        title: "Error",
        message: "Please select a remote first.",
        type: "error",
      });
      return;
    }

    setLoading(true, "Creating folder…");
    updateActionState();

    try {
      const result = await window.rcloneGui.createRemoteFolder({
        remotePath: currentPath(),
        folderName,
      });
      notify({
        title: "Folder created",
        message: result.folderPath,
        type: "success",
      });
      await loadListing("refresh");
    } catch (error) {
      notify({
        title: "Failed to create folder",
        message: error.message || "Could not create the folder.",
        type: "error",
      });
    } finally {
      setLoading(false);
      updateActionState();
    }
  };

  const handleCancel = () => {
    cleanup();
  };

  newFolderCreateBtn.addEventListener("click", handleCreate, { once: true });
  newFolderCancelBtn.addEventListener("click", handleCancel, { once: true });

  const backdrop = newFolderDialog.querySelector("[data-new-folder-close]");
  if (backdrop) {
    backdrop.addEventListener("click", handleCancel, { once: true });
  }

  // Handle Enter key
  newFolderNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleCreate();
    }
    if (event.key === "Escape") {
      cleanup();
    }
  }, { once: false });
}

function bindEvents() {
  remoteBrowser.remotePicker.addEventListener("change", () => {
    currentRemote = remoteBrowser.remotePicker.value;
    currentSubPath = "";
    clearSelectionState();
    resetBrowseHistory(currentRemote, "");
    void loadListing("navigate");
  });

  remoteBrowser.upBtn.addEventListener("click", () => {
    void navigateTo(parentSubPath(currentSubPath));
  });

  remoteBrowser.refreshBtn.addEventListener("click", () => {
    if (searchState) {
      void startSearch();
    } else {
      void loadListing("refresh");
    }
  });

  bindSearch();

  if (remoteBrowser.loadingCancelBtn) {
    remoteBrowser.loadingCancelBtn.addEventListener("click", () => {
      cancelLoading();
    });
  }

  if (remoteBrowser.newFolderBtn) {
    remoteBrowser.newFolderBtn.addEventListener("click", () => {
      if (currentRemote && !loading && window.rcloneGui?.createRemoteFolder) {
        void showNewFolderDialog();
      }
    });
  }

  remoteBrowser.uploadBtn?.addEventListener("click", () => void pickAndUpload());

  bindUploadDrop();
  bindPendingUpload();

  remoteBrowser.previewBtn?.addEventListener("click", () => {
    void previewSelectedFile();
  });

  remoteBrowser.downloadBtn?.addEventListener("click", () => {
    void downloadSelectedFile();
  });

  remoteBrowser.deleteBtn?.addEventListener("click", () => {
    void deleteSelectedFile();
  });

  marqueeScroller()?.addEventListener("mousedown", handleMarqueeDown);

  remoteBrowser.tableWrap?.addEventListener("click", (event) => {
    if (selection.size && !event.target.closest("tr[data-path], thead, button, a, input")) {
      selectEntry(null);
    }
  });

  remoteBrowser.tableWrap?.addEventListener("keydown", (event) => {
    if (event.target.closest("input, textarea, select") || document.querySelector(".popup-root:not(.hidden)")) {
      return;
    }
    const contextMenuOpen = !document.getElementById("browse-context-menu")?.classList.contains("hidden");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && entries.length) {
      event.preventDefault();
      selectAllEntries();
    } else if (event.key === "Escape" && selection.size && !contextMenuOpen) {
      event.preventDefault();
      selectEntry(null);
    } else if (event.key === "Delete" && canDeleteSelection()) {
      event.preventDefault();
      void deleteSelectedFile();
    }
  });

  remoteBrowser.useSourceBtn.addEventListener("click", () => useActivePath("source"));
  remoteBrowser.useDestBtn.addEventListener("click", () => useActivePath("destination"));

  document.addEventListener("click", (event) => {
    const header = event.target.closest(".browse-col-sortable");
    if (header) {
      event.preventDefault();
      const criteria = header.dataset.sort;
      if (criteria) {
        setSort(criteria);
      }
    }
  });

  if (previewUi.previousBtn) {
    previewUi.previousBtn.addEventListener("click", () => {
      navigatePreview(-1);
    });
  }
  
  if (previewUi.nextBtn) {
    previewUi.nextBtn.addEventListener("click", () => {
      navigatePreview(1);
    });
  }

  previewUi.closeBtn?.addEventListener("click", closePreview);
  for (const closer of previewUi.dialog?.querySelectorAll("[data-preview-close]") || []) {
    closer.addEventListener("click", closePreview);
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && previewUi.dialog && !previewUi.dialog.classList.contains("hidden")) {
      closePreview();
    }
    
    if (previewUi.dialog && !previewUi.dialog.classList.contains("hidden")) {
      if (event.key === "ArrowLeft") {
        navigatePreview(-1);
      } else if (event.key === "ArrowRight") {
        navigatePreview(1);
      }
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

  // Context menu handling
  const contextMenu = document.getElementById("browse-context-menu");
  const contextDownloadBtn = document.getElementById("context-download");
  const contextDeleteBtn = document.getElementById("context-delete");
  const contextPreviewBtn = document.getElementById("context-preview");
  const contextNewFolderBtn = document.getElementById("context-new-folder");
  const contextUploadBtn = document.getElementById("context-upload");

  if (contextMenu && contextDownloadBtn && contextPreviewBtn && contextDeleteBtn) {
    let contextTargetPath = null;
    let contextTargetIsDir = false;

    // Close context menu helper
    const closeContextMenu = () => {
      contextMenu.classList.add("hidden");
      contextMenu.setAttribute("aria-hidden", "true");
      contextTargetPath = null;
      contextTargetIsDir = false;
    };

    // Close context menu when clicking backdrop
    const backdrop = contextMenu.querySelector("[data-context-close]");
    if (backdrop) {
      backdrop.addEventListener("click", closeContextMenu);
    }

    // Close context menu when clicking ANYWHERE outside of it
    document.addEventListener("click", (event) => {
      if (!contextMenu.classList.contains("hidden")) {
        const isClickInsideMenu = contextMenu.contains(event.target);
        if (!isClickInsideMenu) {
          closeContextMenu();
        }
      }
    });

    // Close context menu on right-click to allow opening a new menu on a different row
    contextMenu.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      closeContextMenu();
      // Dispatch a new contextmenu event to entriesBody so a new menu can open
      const underneath = document.elementFromPoint(event.clientX, event.clientY);
      if (!underneath || !remoteBrowser.tableWrap?.contains(underneath)) {
        return;
      }
      underneath.dispatchEvent(new MouseEvent("contextmenu", {
        clientX: event.clientX,
        clientY: event.clientY,
        bubbles: true,
        cancelable: true,
      }));
    });

    // Close on escape key
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !contextMenu.classList.contains("hidden")) {
        closeContextMenu();
      }
    });


    // Close menu when clicking on a row in the entries table
    remoteBrowser.entriesBody.addEventListener("click", (event) => {
      if (!contextMenu.classList.contains("hidden")) {
        const row = event.target.closest("tr");
        if (row) {
          closeContextMenu();
        }
      }
    });


    // Show context menu on right-click
    remoteBrowser.tableWrap?.addEventListener("contextmenu", (event) => {
      event.preventDefault();

      // Find the row that was clicked
      const row = event.target.closest("tr[data-path]");

      // Close any existing menu before showing new one
      closeContextMenu();

      const onBlankSpace = !row;
      if (onBlankSpace && !canCreateFolder() && !canPickUpload()) {
        return;
      }

      if (row) {
        // Get the path from the row
        const path = row.dataset.path;
        const isDir = row.dataset.isdir === "1";

        // Store the target for the menu actions
        contextTargetPath = path;
        contextTargetIsDir = isDir;

        // Select the row
        const entry = entries.find((item) => entryPath(item) === path);
        if (entry && !selection.has(path)) {
          selectEntry(entry);
        }
      } else {
        // Clicked on blank space - clear selection but allow new folder creation
        contextTargetPath = null;
        contextTargetIsDir = false;
        selectEntry(null);
      }

      // Position the menu near the mouse
      // Make sure it doesn't go off-screen
      const menuWidth = 220;
      const menuHeight = 120;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      let left = event.clientX;
      let top = event.clientY;

      // Adjust if menu would go off right edge
      if (left + menuWidth > viewportWidth) {
        left = viewportWidth - menuWidth - 10;
      }
      
      // Adjust if menu would go off bottom edge
      if (top + menuHeight > viewportHeight) {
        top = viewportHeight - menuHeight - 10;
      }

      contextMenu.style.left = left + "px";
      contextMenu.style.top = top + "px";

      // Show the menu
      contextMenu.classList.remove("hidden");
      contextMenu.setAttribute("aria-hidden", "false");

      // Hide/unhide and disable menu items based on availability
      // Preview: hide for directories, unsupported file types, or blank space
      const canPreview = selectedPath && canPreviewSelection();
      contextPreviewBtn.classList.toggle("hidden", !canPreview || loading);
      contextPreviewBtn.disabled = !canPreview || loading;
      
      // Download: hide for directories, blank space, or if not supported
      const canDownload = canDownloadSelection() && Boolean(window.rcloneGui?.downloadRemoteFile);
      contextDownloadBtn.classList.toggle("hidden", !canDownload);
      contextDownloadBtn.disabled = !canDownload;
      contextMenuLabel(contextDownloadBtn, "Download", downloadableItems().length, "file");

      // Delete: hide if nothing selected or on blank space
      const canDelete = canDeleteSelection();
      contextDeleteBtn.classList.toggle("hidden", !canDelete);
      contextDeleteBtn.disabled = !canDelete;
      contextMenuLabel(contextDeleteBtn, "Delete", selection.size, "item");

      const canNewFolderHere = onBlankSpace && canCreateFolder();
      contextNewFolderBtn?.classList.toggle("hidden", !canNewFolderHere);
      if (contextNewFolderBtn) {
        contextNewFolderBtn.disabled = !canNewFolderHere;
      }

      const canUploadHere = onBlankSpace && canPickUpload();
      contextUploadBtn?.classList.toggle("hidden", !canUploadHere);
      if (contextUploadBtn) {
        contextUploadBtn.disabled = !canUploadHere;
      }
    });

    contextNewFolderBtn?.addEventListener("click", () => {
      closeContextMenu();
      if (canCreateFolder()) {
        void showNewFolderDialog();
      }
    });

    contextUploadBtn?.addEventListener("click", () => {
      closeContextMenu();
      void pickAndUpload();
    });

    // Preview action
    contextPreviewBtn.addEventListener("click", () => {
      closeContextMenu();
      // Use selectedPath which was set when right-clicking
      if (selectedPath && !selectedIsDir && !loading && canPreviewSelection()) {
        void previewSelectedFile();
      }
    });

    // Context menu actions
    contextDownloadBtn.addEventListener("click", () => {
      if (canDownloadSelection() && window.rcloneGui?.downloadRemoteFile) {
        closeContextMenu();
        void downloadSelectedFile();
      }
    });

    contextDeleteBtn.addEventListener("click", () => {
      if (canDeleteSelection()) {
        closeContextMenu();
        void deleteSelectedFile();
      }
    });
  }
}

function init(options = {}) {
  onUsePath = options.onUsePath || null;
  onNotify = options.onNotify || null;
  bindEvents();
  fillRemotePicker();
  updateTableSortIndicators();
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
  const wasHidden = remoteBrowser.view.classList.contains("hidden") || remoteBrowser.view.hidden;
  remoteBrowser.view.classList.remove("hidden");
  remoteBrowser.view.hidden = false;
  if (!wasHidden) {
    return;
  }
  restartEnterAnimations();
  if (currentRemote) {
    if (browseHistoryIndex < 0) {
      resetBrowseHistory(currentRemote, currentSubPath);
    }
    void loadListing("navigate");
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
  queueUpload,
  show,
  hide,
  reload: (context) => loadListing(context || "refresh"),
};
})();
