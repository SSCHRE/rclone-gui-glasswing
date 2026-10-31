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
  if (remoteBrowser.newFolderBtn) {
    remoteBrowser.newFolderBtn.disabled = !currentRemote || loading || !window.rcloneGui?.createRemoteFolder;
  }
  if (remoteBrowser.uploadBtn) {
    remoteBrowser.uploadBtn.disabled = !canUpload();
  }
  remoteBrowser.useSourceBtn.disabled = !hasPath || loading;
  remoteBrowser.useDestBtn.disabled = !hasPath || loading;
  if (remoteBrowser.deleteBtn) {
    remoteBrowser.deleteBtn.disabled = !selectedPath || loading;
  }
  remoteBrowser.upBtn.disabled = !currentRemote || !currentSubPath || loading;
  remoteBrowser.refreshBtn.disabled = !currentRemote || loading;
  remoteBrowser.remotePicker.disabled = loading;
  renderPendingUpload();
  if (remoteBrowser.searchInput) {
    remoteBrowser.searchInput.disabled = !currentRemote;
    updateSearchButton();
  }

  if (!currentRemote) {
    remoteBrowser.selectionLabel.textContent = "Nothing selected";
    return;
  }

  if (selectedPath) {
    const displayPath = selectedPath.includes(":") ? selectedPath.split(":").slice(1).join(":") : selectedPath;
    remoteBrowser.selectionLabel.textContent = selectedIsDir
      ? `Folder: ${displayPath || "/"}`
      : `File: ${displayPath || "root"}`;
    return;
  }

  remoteBrowser.selectionLabel.textContent = "Nothing selected";
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

  if (vaultBacking.has(currentRemote)) {
    remoteBrowser.breadcrumbs.appendChild(vaultBadge(currentRemote));
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
  updatePreviewNavigation();
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
    const entryPath = formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
    row.dataset.path = entryPath;
    row.dataset.index = index;
    row.style.setProperty("--row-index", Math.min(index, 20));
    row.dataset.isdir = entry.isDir ? "1" : "0";
    row.className = `browse-row${entry.isDir ? " is-dir" : " is-file"}${animate ? "" : " is-static"}${entryPath === selectedPath ? " is-selected" : ""}`;
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

  if (scrollContainer && !animate) {
    scrollContainer.scrollTop = previousScrollTop;
  } else if (scrollContainer && wasAtBottom) {
    requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }
}

async function loadListingForPath(subPath, token) {
  selectedPath = null;
  selectedIsDir = false;
  selectedSize = null;
  
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
      if (selectedPath && !fresh.some((entry) => formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name)) === selectedPath)) {
        selectedPath = null;
        selectedIsDir = false;
        selectedSize = null;
      }
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
  selectedPath = null;
  selectedIsDir = false;
  selectedSize = null;
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
  endSearchMode();
  const targetSubPath = String(subPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  
  const token = ++loadToken;
  const targetPath = formatRemotePath(currentRemote, targetSubPath);
  const cached = getCachedListing(targetPath);
  if (cached) {
    selectedPath = null;
    selectedIsDir = false;
    selectedSize = null;
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
  activePreviewToken = 0;
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
    if (loadingContext === "preview" && (isPreviewCurrent(token) || activePreviewToken === 0)) {
      setLoading(false);
    }
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

function localBaseName(localPath) {
  return String(localPath).split(/[\\/]/).filter(Boolean).pop() || String(localPath);
}

const transferStack = document.getElementById("transfer-stack");

const uploadPanel = new TransferPanel(transferStack, {
  labels: { active: "Uploading", noun: "Upload", past: "uploaded" },
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
  labels: { active: "Downloading", noun: "Download", past: "downloaded" },
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

async function deleteSelectedFile() {
  if (!selectedPath || loading) {
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

  // Show built-in confirmation dialog
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
    return;
  }

  // Set up the dialog
  deleteTitle.textContent = "Delete file";
  // Extract just the path part without the remote name
  const pathOnly = selectedPath.includes(':') ? selectedPath.split(':').slice(1).join(':') : selectedPath;
  const pathLabel = document.createElement("strong");
  pathLabel.textContent = pathOnly;
  deleteMessage.replaceChildren("Are you sure you want to delete ", pathLabel, "? This cannot be undone.");
  deleteDialog.classList.remove("hidden");
  deleteDialog.setAttribute("aria-hidden", "false");
  
  // Focus the confirm button for accessibility
  deleteConfirmBtn.focus();

  // Return a promise that resolves when the user makes a choice
  return new Promise((resolve) => {
    const cleanup = () => {
      deleteDialog.classList.add("hidden");
      deleteDialog.setAttribute("aria-hidden", "true");
      deleteConfirmBtn.removeEventListener("click", handleConfirm);
      deleteCancelBtn.removeEventListener("click", handleCancel);
      // Remove backdrop click handler
      const backdrop = deleteDialog.querySelector("[data-delete-close]");
      if (backdrop) {
        backdrop.removeEventListener("click", handleCancel);
      }
    };

    const handleConfirm = () => {
      cleanup();
      resolve(true);
    };

    const handleCancel = () => {
      cleanup();
      resolve(false);
    };

    deleteConfirmBtn.addEventListener("click", handleConfirm, { once: true });
    deleteCancelBtn.addEventListener("click", handleCancel, { once: true });
    
    const backdrop = deleteDialog.querySelector("[data-delete-close]");
    if (backdrop) {
      backdrop.addEventListener("click", handleCancel, { once: true });
    }
    
    // Also handle Escape key
    const handleKeydown = (event) => {
      if (event.key === "Escape") {
        cleanup();
        resolve(false);
      }
    };
    document.addEventListener("keydown", handleKeydown, { once: true });
  }).then(async (confirmed) => {
    if (!confirmed) {
      return;
    }

    const selectedRow = remoteBrowser.entriesBody.querySelector("tr.is-selected");
    
    if (selectedRow) {
      selectedRow.classList.add("is-deleting");
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    setLoading(true, "Deleting…", "delete");
    updateActionState();

    try {
      const deletedRemotePath = selectedPath;
      const result = await window.rcloneGui.deleteRemoteFile({
        remotePath: selectedPath,
        isDir: selectedIsDir,
      });
      dropCachedListings(deletedRemotePath);
      // Format the deleted path with folder in bold
      const deletedParts = result.source.split(':');
      const deletedRemote = deletedParts[0];
      const deletedPath = deletedParts.length > 1 ? deletedParts.slice(1).join(':') : '';
      notify({
        title: "Delete complete",
        message: [`${deletedRemote}: `, { strong: deletedPath }],
        type: "success",
      });
      browseMeter?.refresh();
      if (searchState) {
        removeSearchResult(deletedRemotePath);
      } else {
        await loadListing("delete");
      }
    } catch (error) {
      notify({
        title: "Delete failed",
        message: error.message || "Could not delete the file.",
        type: "error",
      });
    } finally {
      setLoading(false);
      updateActionState();
    }
  });
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
  selectedPath = null;
  selectedIsDir = false;
  selectedSize = null;
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
    const entryPath = formatRemotePath(currentRemote, joinSubPath(currentSubPath, entry.name));
    return entryPath !== remotePath && !entryPath.startsWith(`${remotePath}/`);
  });
  selectedPath = null;
  selectedIsDir = false;
  selectedSize = null;
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
    selectedPath = null;
    selectedIsDir = false;
    selectedSize = null;
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

  remoteBrowser.uploadBtn?.addEventListener("click", async () => {
    if (!canUpload() || !window.rcloneGui?.pickUploadFiles) {
      return;
    }
    const paths = await window.rcloneGui.pickUploadFiles();
    await uploadToCurrentFolder(paths);
  });

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
      const entriesBodyEvent = new MouseEvent("contextmenu", {
        clientX: event.clientX,
        clientY: event.clientY,
        bubbles: true,
        cancelable: true,
      });
      remoteBrowser.entriesBody.dispatchEvent(entriesBodyEvent);
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
    remoteBrowser.entriesBody.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      
      // Find the row that was clicked
      const row = event.target.closest("tr");

      // Close any existing menu before showing new one
      closeContextMenu();

      if (row) {
        // Get the path from the row
        const path = row.dataset.path;
        const isDir = row.dataset.isdir === "1";
        
        if (!path) return;

        // Store the target for the menu actions
        contextTargetPath = path;
        contextTargetIsDir = isDir;

        // Select the row
        const entryIndex = entries.findIndex(e => formatRemotePath(currentRemote, joinSubPath(currentSubPath, e.name)) === path);
        if (entryIndex >= 0) {
          selectEntry(entries[entryIndex]);
        }
      } else {
        // Clicked on blank space - clear selection but allow new folder creation
        contextTargetPath = null;
        contextTargetIsDir = false;
        selectedPath = null;
        selectedIsDir = false;
        selectedSize = null;
        updateActionState();
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
      const canDownload = selectedPath && !selectedIsDir && window.rcloneGui?.downloadRemoteFile && !loading;
      contextDownloadBtn.classList.toggle("hidden", !canDownload);
      contextDownloadBtn.disabled = !canDownload;
      
      // Delete: hide if nothing selected or on blank space
      const canDelete = selectedPath && !loading;
      contextDeleteBtn.classList.toggle("hidden", !canDelete);
      contextDeleteBtn.disabled = !canDelete;
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
      if (selectedPath && !selectedIsDir && !loading && window.rcloneGui?.downloadRemoteFile) {
        closeContextMenu();
        void downloadSelectedFile();
      }
    });

    contextDeleteBtn.addEventListener("click", () => {
      if (selectedPath && !loading) {
        closeContextMenu();
        // Entry is already selected from the contextmenu handler
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
  if (wasHidden) {
    restartEnterAnimations();
  }
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
