(() => {
const browseUi = {
  view: document.getElementById("browse-view"),
  panesHost: document.getElementById("browse-panes"),
  divider: document.getElementById("browse-divider"),
  paneTemplate: document.getElementById("browse-pane-template"),
  status: document.getElementById("browse-status"),
  selectionLabel: document.getElementById("browse-selection"),
  previewBtn: document.getElementById("browse-preview"),
  downloadBtn: document.getElementById("browse-download"),
  newFolderBtn: document.getElementById("browse-new-folder"),
  uploadBtn: document.getElementById("browse-upload"),
  useSourceBtn: document.getElementById("browse-use-source"),
  useDestBtn: document.getElementById("browse-use-dest"),
  deleteBtn: document.getElementById("browse-delete"),
  transferGroup: document.getElementById("browse-transfer-group"),
  copyAcrossBtn: document.getElementById("browse-copy-across"),
  moveAcrossBtn: document.getElementById("browse-move-across"),
  replaceDialog: document.getElementById("upload-replace-dialog"),
  replaceTitle: document.getElementById("upload-replace-title"),
  replaceMessage: document.getElementById("upload-replace-message"),
  replaceCancelBtn: document.getElementById("upload-replace-cancel"),
  replaceConfirmBtn: document.getElementById("upload-replace-confirm"),
};

const PANE_REFS = {
  remotePicker: "remote-picker",
  upBtn: "up",
  refreshBtn: "refresh",
  splitBtn: "split",
  breadcrumbs: "breadcrumbs",
  storageSlot: "storage",
  searchInput: "search",
  searchGoBtn: "search-go",
  searchBar: "search-bar",
  searchSpinner: "search-spinner",
  searchSummary: "search-summary",
  searchStopBtn: "search-stop",
  searchExitBtn: "search-exit",
  entriesBody: "entries",
  empty: "empty",
  loading: "loading",
  loadingCancelBtn: "cancel",
  tableWrap: "table-wrap",
};

function paneElements(root) {
  const refs = {};
  for (const [key, ref] of Object.entries(PANE_REFS)) {
    refs[key] = root.querySelector(`[data-ref="${ref}"]`);
  }
  refs.tableHead = root.querySelector("thead");
  return refs;
}

const contextUi = {
  menu: document.getElementById("browse-context-menu"),
  downloadBtn: document.getElementById("context-download"),
  deleteBtn: document.getElementById("context-delete"),
  previewBtn: document.getElementById("context-preview"),
  newFolderBtn: document.getElementById("context-new-folder"),
  uploadBtn: document.getElementById("context-upload"),
  copyAcrossBtn: document.getElementById("context-copy-across"),
  moveAcrossBtn: document.getElementById("context-move-across"),
  renameBtn: document.getElementById("context-rename"),
};
let contextPane = null;

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
const SPLIT_KEY = "glasswing.browseSplit.v1";
let vaultBacking = new Map();
let vaultLookup = 0;
let onUsePath = null;
let onNotify = null;
let previewBlobUrl = null;
let zipPreviewState = null;
let statusHideTimer = null;
let previewToken = 0;
let activePreviewToken = 0;
let previewOwner = null;
let searchTokenCounter = 0;
const panes = [];
const pendingRenames = new Map();

function applyPendingRenames(list, folder) {
  const pending = pendingRenames.get(folder);
  if (!pending || !pending.size) {
    return list;
  }
  const names = new Set(list.map((item) => item.name));
  const result = [];
  for (const item of list) {
    if (pending.has(item.name)) {
      const newName = pending.get(item.name);
      if (names.has(newName)) {
        continue;
      }
      result.push({ ...item, name: newName, pendingRename: true });
    } else if ([...pending.values()].includes(item.name)) {
      result.push({ ...item, pendingRename: true });
    } else {
      result.push(item);
    }
  }
  return result;
}
let activePane = null;
let splitOn = false;
let splitRatio = 0.5;
let splitStateReady = false;
let rowDrag = null;

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
  const context = previewOwner?.previewContext() || { size: null, total: 0, index: -1, path: "" };
  const ext = previewFileExtension(payload.name);
  const kindLabel = PREVIEW_KIND_LABELS[payload.kind] || "File";
  const bytes = payload.kind === "zip" && typeof payload.archiveBytes === "number" ? payload.archiveBytes : context.size;
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
    const total = context.total;
    const showPosition = context.index >= 0 && total > 1;
    previewExtras.position.textContent = showPosition ? `${context.index + 1} / ${total}` : "";
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
  previewUi.subtitle.textContent = payload.statusText || previewOwner?.previewContext().path || "";
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
  return Boolean(browseUi.view && !browseUi.view.classList.contains("hidden") && !browseUi.view.hidden);
}

function handleHistoryNavigate(direction) {
  if (direction === "back") {
    if (isZipPreviewOpen()) {
      zipHistoryBack();
      return;
    }
    if (isBrowseViewVisible()) {
      void activePane?.historyBack();
    }
    return;
  }

  if (direction === "forward") {
    if (isZipPreviewOpen()) {
      zipHistoryForward();
      return;
    }
    if (isBrowseViewVisible()) {
      void activePane?.historyForward();
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

function localBaseName(localPath) {
  return String(localPath).split(/[\\/]/).filter(Boolean).pop() || String(localPath);
}

function remoteSidePath(path) {
  return path.includes(":") ? path.split(":").slice(1).join(":") : path;
}

function parentRemotePath(path) {
  const colon = path.indexOf(":");
  const slash = path.lastIndexOf("/");
  return slash > colon ? path.slice(0, slash) : path.slice(0, colon + 1);
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
    refreshAfterChange([batch.targetPath]);
    refreshAllMeters();
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

function transferRunBatch(method) {
  return async (batch) => {
    const result = await window.rcloneGui[method]({
      items: batch.items.map((item) => ({ path: item.path, isDir: item.isDir })),
      destination: batch.destination,
    });
    return { completed: result.completed, failed: result.failed, cancelled: result.cancelled };
  };
}

function onTransferFinished(batch) {
  refreshAfterChange([batch.destination, ...batch.sources.map(parentRemotePath)]);
  refreshAllMeters();
}

const copyPanel = new TransferPanel(transferStack, {
  labels: { active: "Copying", noun: "Copy", past: "copied", direction: "across" },
  formatBytes,
  subscribe: (onProgress) => window.rcloneGui.onRemoteTransferProgress?.(onProgress),
  runBatch: transferRunBatch("copyRemoteItems"),
  cancel: () => window.rcloneGui?.cancelRemoteTransfer?.(),
  onBatchFinished: onTransferFinished,
});

const movePanel = new TransferPanel(transferStack, {
  labels: { active: "Moving", noun: "Move", past: "moved", direction: "across" },
  formatBytes,
  subscribe: (onProgress) => window.rcloneGui.onRemoteTransferProgress?.(onProgress),
  runBatch: transferRunBatch("moveRemoteItems"),
  cancel: () => window.rcloneGui?.cancelRemoteTransfer?.(),
  onBatchFinished: onTransferFinished,
});

function refreshAllMeters() {
  for (const pane of panes) {
    pane.refreshMeter();
  }
}

function refreshAfterChange(paths) {
  for (const path of paths) {
    const handled = panes.map((pane) => pane.softRefresh(path)).some(Boolean);
    if (!handled) {
      dropCachedListings(path);
    }
  }
}

function confirmAction({ title, message, confirmLabel }) {
  const { replaceDialog, replaceTitle, replaceMessage, replaceCancelBtn, replaceConfirmBtn } = browseUi;
  if (!replaceDialog) {
    return Promise.resolve(true);
  }

  const previousTitle = replaceTitle.textContent;
  const previousLabel = replaceConfirmBtn.textContent;
  replaceTitle.textContent = title;
  replaceMessage.textContent = message;
  replaceConfirmBtn.textContent = confirmLabel;

  replaceDialog.classList.remove("hidden");
  replaceDialog.setAttribute("aria-hidden", "false");
  replaceConfirmBtn.focus();

  return new Promise((resolve) => {
    const backdrop = replaceDialog.querySelector("[data-upload-replace-close]");
    const finish = (confirmed) => {
      replaceDialog.classList.add("hidden");
      replaceDialog.setAttribute("aria-hidden", "true");
      replaceTitle.textContent = previousTitle;
      replaceConfirmBtn.textContent = previousLabel;
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

function confirmReplace(names, where = "this folder") {
  const message = names.length === 1
    ? `"${names[0]}" already exists in ${where}. Replace it?`
    : `${names.length} items already exist in ${where}: ${names.slice(0, 3).map((name) => `"${name}"`).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}. Replace them?`;
  return confirmAction({ title: "Replace existing files?", message, confirmLabel: "Replace" });
}

function otherPaneOf(pane) {
  return panes.find((candidate) => candidate !== pane) || null;
}

function transferNames(items) {
  return items.map((item) => item.name.split("/").pop());
}

function describeCount(count) {
  return count === 1 ? "1 item" : `${count} items`;
}

async function transferItems(source, target, operation) {
  if (!splitOn || !source || !target || source === target) {
    return;
  }
  const items = source.selectedItems();
  const destination = target.currentPath();
  if (!items.length || !destination) {
    return;
  }

  const moving = operation === "move";
  const method = moving ? "moveRemoteItems" : "copyRemoteItems";
  if (!window.rcloneGui?.[method]) {
    notify({ title: moving ? "Move unavailable" : "Copy unavailable", message: "App bridge does not support this.", type: "error" });
    return;
  }

  const panel = moving ? movePanel : copyPanel;
  const otherPanel = moving ? copyPanel : movePanel;
  if (otherPanel.running || uploadPanel.running || downloadPanel.running) {
    notify({ title: "Hang on", message: "Another transfer is still running. Try again once it's done.", type: "error" });
    return;
  }
  if (panel.cancelling) {
    return;
  }
  if (!source.isSearching() && source.currentPath() === destination) {
    notify({ title: "Same folder", message: "Both panes are looking at the same folder, pick another one on the other side.", type: "error" });
    return;
  }

  const existing = target.existingNames();
  const conflicts = transferNames(items).filter((name) => existing.has(name));
  if (moving) {
    const where = `${source.isSearching() ? "search results" : source.currentPath()} to ${destination}`;
    const overwrite = conflicts.length ? ` ${conflicts.length === 1 ? "One of them already exists" : `${conflicts.length} of them already exist`} there and will be replaced.` : "";
    const confirmed = await confirmAction({
      title: `Move ${describeCount(items.length)}?`,
      message: `They'll be moved from ${where}.${overwrite}`,
      confirmLabel: "Move",
    });
    if (!confirmed) {
      return;
    }
  } else if (conflicts.length && !(await confirmReplace(conflicts, destination))) {
    return;
  }

  panel.enqueue({
    destination,
    sources: items.map((item) => item.path),
    items: items.map((item) => ({
      path: item.path,
      name: item.name.split("/").pop(),
      isDir: item.isDir,
      size: item.size || 0,
    })),
  });
}

function beginRowDrag(pane, event, entry) {
  const items = pane.prepareDrag(entry);
  if (!items.length || !splitOn) {
    event.preventDefault();
    return;
  }
  rowDrag = { pane, count: items.length };
  event.dataTransfer.effectAllowed = "copyMove";
  event.dataTransfer.setData("application/x-glasswing-items", String(items.length));
  const ghost = document.createElement("div");
  ghost.className = "browse-drag-ghost";
  ghost.textContent = describeCount(items.length);
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, -8, -8);
  setTimeout(() => ghost.remove(), 0);
}

function endRowDrag() {
  rowDrag = null;
  for (const pane of panes) {
    pane.setTransferTarget(false);
  }
}

function saveSplitState() {
  if (!splitStateReady) {
    return;
  }
  try {
    localStorage.setItem(
      SPLIT_KEY,
      JSON.stringify({
        on: splitOn,
        ratio: splitRatio,
        active: Math.max(0, panes.indexOf(activePane)),
        panes: panes.map((pane) => pane.getLocation()),
      }),
    );
  } catch {}
}

function readSplitState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SPLIT_KEY) || "null");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function applySplitRatio(ratio) {
  splitRatio = Math.min(0.75, Math.max(0.25, ratio));
  browseUi.panesHost.style.setProperty("--split-ratio", String(splitRatio));
  browseUi.divider.setAttribute("aria-valuenow", String(Math.round(splitRatio * 100)));
}

function setActivePane(pane) {
  if (!pane || activePane === pane) {
    return;
  }
  activePane = pane;
  for (const candidate of panes) {
    candidate.root.classList.toggle("is-active", candidate === pane);
  }
  pane.updateActionState();
  pane.applyStatus();
  saveSplitState();
}

function setSplit(on) {
  if (on === splitOn) {
    return;
  }
  splitOn = on;
  const [first, second] = panes;
  browseUi.panesHost.classList.toggle("is-split", on);
  second.root.hidden = !on;
  browseUi.divider.hidden = !on;
  if (on) {
    if (!second.getRemote() && first.getRemote()) {
      second.openLocation(first.getRemote(), first.getSubPath());
    } else {
      second.onViewShown();
    }
  } else {
    setActivePane(first);
  }
  for (const pane of panes) {
    pane.onSplitChange();
  }
  activePane.updateActionState();
  saveSplitState();
}

function switchPane() {
  if (!splitOn) {
    return;
  }
  const next = otherPaneOf(activePane);
  setActivePane(next);
  next.focusList();
}

function bindDivider() {
  const divider = browseUi.divider;
  const host = browseUi.panesHost;
  let dragging = false;
  divider.tabIndex = 0;

  divider.addEventListener("pointerdown", (event) => {
    dragging = true;
    divider.setPointerCapture(event.pointerId);
    divider.classList.add("is-dragging");
    event.preventDefault();
  });
  divider.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }
    const rect = host.getBoundingClientRect();
    applySplitRatio((event.clientX - rect.left) / rect.width);
  });
  const stop = () => {
    if (!dragging) {
      return;
    }
    dragging = false;
    divider.classList.remove("is-dragging");
    saveSplitState();
  };
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);
  divider.addEventListener("dblclick", () => {
    applySplitRatio(0.5);
    saveSplitState();
  });
  divider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      applySplitRatio(splitRatio + (event.key === "ArrowLeft" ? -0.02 : 0.02));
      saveSplitState();
    }
  });
}


function restoreLastUploadTarget() {
  const pane = activePane;
  if (!pane || pane.getRemote() || !pendingUploads.length) {
    return;
  }
  let last = null;
  try {
    last = JSON.parse(localStorage.getItem(LAST_UPLOAD_KEY) || "null");
  } catch {}
  if (!last?.remote || !browseRemotes.includes(last.remote)) {
    return;
  }
  pane.openLocation(last.remote, last.subPath || "");
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
  document.getElementById("browse-pending-hint").textContent = activePane?.getRemote()
    ? `Will upload to ${activePane.currentPath()}. Go to another folder first if you like.`
    : "Pick a remote, go to the folder you want, then click Upload here.";
  document.getElementById("browse-pending-go").disabled = !activePane?.canUpload();
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
    if (await activePane.uploadToCurrentFolder(paths)) {
      pendingUploads = pendingUploads.filter((localPath) => !paths.includes(localPath));
      renderPendingUpload();
    }
  });
}

function describeDeleteTargets(items, remote) {
  if (items.length === 1) {
    const [item] = items;
    const pathLabel = document.createElement("strong");
    pathLabel.className = "delete-card-path";
    pathLabel.textContent = remoteSidePath(item.path);
    return {
      title: item.isDir ? "Delete this folder?" : "Delete this file?",
      message: [
        pathLabel,
        item.isDir ? `Everything inside it will be removed from ${remote}.` : `It will be removed from ${remote}.`,
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
        ? `They'll be removed from ${remote}, folders with everything inside them.`
        : `They'll be removed from ${remote}.`,
    ],
  };
}

function confirmDelete(items, remote) {
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

  const { title, message } = describeDeleteTargets(items, remote);
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

function notifyDeleteResult(deleted, failed, total, remote) {
  if (!failed.length) {
    if (total === 1) {
      const deletedPath = remoteSidePath(deleted[0].path);
      notify({
        title: "Delete complete",
        message: [`${remote}: `, { strong: deletedPath }],
        type: "success",
      });
    } else {
      notify({
        title: "Delete complete",
        message: [{ strong: `${total} items` }, ` removed from ${remote}.`],
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
function setRemotes(names) {
  browseRemotes = Array.isArray(names) ? [...names] : [];
  for (const pane of panes) {
    pane.fillRemotePicker();
  }
  restoreSplitLocations();
  restoreLastUploadTarget();
  void refreshVaults();
}

function restoreSplitLocations() {
  if (splitStateReady || !browseRemotes.length) {
    return;
  }
  const saved = readSplitState();
  const locations = Array.isArray(saved.panes) ? saved.panes : [];
  panes.forEach((pane, index) => {
    const location = locations[index];
    if (location && !pane.getRemote()) {
      pane.restoreLocation(location.remote, location.subPath);
    }
  });
  splitStateReady = true;
  saveSplitState();
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
  for (const pane of panes) {
    pane.labelRemoteOptions();
    pane.renderBreadcrumbs();
  }
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

function createBrowserPane(root, paneOptions = {}) {
const pane = { root };
const remoteBrowser = { ...browseUi, ...paneElements(root) };

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
let browseHistory = [];
let browseHistoryIndex = -1;
let sortBy = "name";
let sortDirection = "asc";
let previewableFiles = [];
let currentPreviewIndex = -1;
let searchState = null;
let searchRenderQueued = false;
let statusState = { message: "", isError: false };
let renameState = null;

function isActive() {
  return activePane === pane;
}

function getSortedEntries() {
  const sorted = [...(searchState ? entries : applyPendingRenames(entries, currentPath()))];
  
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
  if (!previewUi.previousBtn || !previewUi.nextBtn || previewOwner !== pane) return;
  
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
  statusState = { message, isError };
  if (isActive()) {
    applyStatus();
  }
}

function applyStatus() {
  const { message, isError } = statusState;
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

function canRenameSelection() {
  return selection.size === 1 && !loading && !searchState && Boolean(window.rcloneGui?.renameRemoteItem);
}
function canTransferAcross() {
  const other = splitOn ? otherPaneOf(pane) : null;
  return Boolean(other && other.getRemote() && currentRemote && selection.size && !loading);
}

function updateAcrossButtons() {
  const first = panes[0] === pane;
  const ready = canTransferAcross();
  remoteBrowser.transferGroup.classList.toggle("hidden", !splitOn);
  remoteBrowser.copyAcrossBtn.disabled = !ready;
  remoteBrowser.moveAcrossBtn.disabled = !ready;
  remoteBrowser.copyAcrossBtn.querySelector(".browse-action-label").textContent = first ? "Copy →" : "← Copy";
  remoteBrowser.moveAcrossBtn.querySelector(".browse-action-label").textContent = first ? "Move →" : "← Move";
}

function updateActionState() {
  remoteBrowser.upBtn.disabled = !currentRemote || !currentSubPath || loading;
  remoteBrowser.refreshBtn.disabled = !currentRemote || loading;
  remoteBrowser.remotePicker.disabled = loading;
  remoteBrowser.splitBtn.setAttribute("aria-pressed", String(splitOn));
  remoteBrowser.splitBtn.classList.toggle("is-on", splitOn);
  if (remoteBrowser.searchInput) {
    remoteBrowser.searchInput.disabled = !currentRemote;
    updateSearchButton();
  }

  if (!isActive()) {
    return;
  }

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
  updateAcrossButtons();
  renderPendingUpload();
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
  if (!isActive()) {
    return;
  }
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
const browseStorageSlot = remoteBrowser.storageSlot;
const browseMeter = browseStorageSlot && window.StorageMeter ? new window.StorageMeter(browseStorageSlot) : null;

function renderBreadcrumbs() {
  browseMeter?.setTarget(currentRemote ? `${currentRemote}:` : null);
  saveSplitState();
  if (splitOn && activePane && !isActive()) {
    activePane.updateActionState();
  }
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
  const shown = searchState ? visibleEntries : applyPendingRenames(visibleEntries, currentPath());
  const visible = new Set(shown.map(entryPath));
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
  const sorted = getSortedEntries().filter((item) => !item.pendingRename);
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
    if (entry.pendingRename) {
      continue;
    }
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

function hasAddModifier(event) {
  return window.rcloneGui?.platform === "darwin" ? event.metaKey : event.ctrlKey || event.metaKey;
}

function handleRowClick(event, entry) {
  if (event.shiftKey) {
    selectRangeTo(entry, { additive: hasAddModifier(event) });
  } else if (hasAddModifier(event)) {
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
  if (
    event.button !== 0 ||
    !entries.length ||
    event.target.closest("thead, button, a, input, select, textarea") ||
    (splitOn && event.target.closest("tr[data-path]"))
  ) {
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
    if (!entry || entry.pendingRename) {
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
    mode: hasAddModifier(event) ? "toggle" : event.shiftKey ? "add" : "replace",
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
  cancelRename();
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
    row.className = `browse-row${entry.isDir ? " is-dir" : " is-file"}${animate ? "" : " is-static"}${selection.has(rowPath) ? " is-selected" : ""}${entry.pendingRename ? " is-pending" : ""}`;
    row.tabIndex = entry.pendingRename ? -1 : 0;
    if (entry.pendingRename) {
      row.setAttribute("aria-busy", "true");
      row.title = "Renaming…";
    }
    if (splitOn && !entry.pendingRename) {
      row.draggable = true;
      row.addEventListener("dragstart", (event) => beginRowDrag(pane, event, entry));
      row.addEventListener("dragend", endRowDrag);
    }

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
    if (entry.pendingRename) {
      const spinner = document.createElement("span");
      spinner.className = "browse-loading-spinner is-small";
      spinner.setAttribute("aria-hidden", "true");
      nameWrap.append(spinner);
    }
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

    if (entry.pendingRename) {
      remoteBrowser.entriesBody.appendChild(row);
      continue;
    }

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
function labelRemoteOptions() {
  for (const option of remoteBrowser.remotePicker.options) {
    if (option.value) {
      option.textContent = vaultBacking.has(option.value) ? `${option.value} 🔒` : option.value;
    }
  }
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

  previewOwner = pane;
  updatePreviewNavigation();
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

function bindUploadDrop() {
  const dropZone = remoteBrowser.tableWrap;
  if (!dropZone) {
    return;
  }

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  const hasRows = (event) => Boolean(rowDrag) && rowDrag.pane !== pane && Array.from(event.dataTransfer?.types || []).includes("application/x-glasswing-items");
  let dragDepth = 0;

  dropZone.addEventListener("dragenter", (event) => {
    if (hasRows(event)) {
      event.preventDefault();
      dragDepth += 1;
      setTransferTarget(Boolean(currentRemote));
      return;
    }
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    dragDepth += 1;
    dropZone.classList.toggle("is-drop-target", canUpload());
  });

  dropZone.addEventListener("dragover", (event) => {
    if (hasRows(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = currentRemote ? (event.shiftKey ? "move" : "copy") : "none";
      return;
    }
    if (!hasFiles(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = canUpload() ? "copy" : "none";
  });

  dropZone.addEventListener("dragleave", (event) => {
    if (!hasFiles(event) && !hasRows(event)) {
      return;
    }
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropZone.classList.remove("is-drop-target");
      setTransferTarget(false);
    }
  });

  dropZone.addEventListener("drop", (event) => {
    if (hasRows(event)) {
      event.preventDefault();
      dragDepth = 0;
      const source = rowDrag.pane;
      const operation = event.shiftKey ? "move" : "copy";
      endRowDrag();
      if (currentRemote) {
        setActivePane(pane);
        void transferItems(source, pane, operation);
      }
      return;
    }
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
    setActivePane(pane);
    void uploadToCurrentFolder(paths);
  });
}

function setTransferTarget(on) {
  root.classList.toggle("is-transfer-target", on);
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

  const confirmed = await confirmDelete(items, currentRemote);
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

    notifyDeleteResult(deleted, failed, items.length, currentRemote);
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

function renameSelectionEnd(name, isDir) {
  const dot = name.lastIndexOf(".");
  return !isDir && dot > 0 ? dot : name.length;
}

function cancelRename() {
  if (!renameState) {
    return;
  }
  const state = renameState;
  renameState = null;
  state.input.remove();
  state.nameEl.hidden = false;
  state.row.draggable = splitOn;
}

function startRename() {
  if (!canRenameSelection()) {
    return;
  }
  const entry = entries.find((item) => entryPath(item) === selectedPath);
  const row = [...remoteBrowser.entriesBody.querySelectorAll("tr[data-path]")].find((item) => item.dataset.path === selectedPath);
  const nameEl = row?.querySelector(".browse-entry-name");
  if (!entry || !nameEl) {
    return;
  }
  cancelRename();

  const input = document.createElement("input");
  input.type = "text";
  input.className = "browse-rename-input";
  input.value = entry.name;
  input.spellcheck = false;
  input.autocomplete = "off";
  input.setAttribute("aria-label", "New name");

  const state = { entry, row, nameEl, input };
  renameState = state;
  row.draggable = false;
  nameEl.hidden = true;
  nameEl.after(input);
  row.scrollIntoView({ block: "nearest" });
  input.focus();
  input.setSelectionRange(0, renameSelectionEnd(entry.name, entry.isDir));

  for (const type of ["click", "dblclick", "mousedown", "contextmenu", "dragstart"]) {
    input.addEventListener(type, (event) => event.stopPropagation());
  }
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      void commitRename(state);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRename();
      row.focus();
    }
  });
  input.addEventListener("blur", () => {
    if (document.hasFocus()) {
      void commitRename(state);
    }
  });
}

function repaintPending(folder) {
  if (!currentRemote || searchState || loading || currentPath() !== folder) {
    return;
  }
  renderEntries({ animate: false });
}

function settleRename(folder, oldName, newName, { select = false } = {}) {
  if (!currentRemote || searchState || currentPath() !== folder) {
    return;
  }
  entries = entries.map((item) => (item.name === oldName ? { ...item, name: newName } : item));
  if (loading) {
    return;
  }
  renderEntries({ animate: false });
  if (!select || selection.size) {
    return;
  }
  const renamed = entries.find((item) => item.name === newName);
  if (renamed) {
    selectEntry(renamed);
    const row = [...remoteBrowser.entriesBody.querySelectorAll("tr[data-path]")].find((item) => item.dataset.path === entryPath(renamed));
    row?.scrollIntoView({ block: "nearest" });
    row?.focus({ preventScroll: true });
  }
}

function clearPendingRename(folder, oldName) {
  const pending = pendingRenames.get(folder);
  pending?.delete(oldName);
  if (pending && !pending.size) {
    pendingRenames.delete(folder);
  }
}

async function commitRename(state) {
  if (renameState !== state) {
    return;
  }
  const newName = state.input.value.trim();
  const { entry } = state;
  cancelRename();
  if (!newName || newName === entry.name) {
    return;
  }

  const remote = currentRemote;
  const subPath = currentSubPath;
  const folder = currentPath();
  const oldPath = entryPath(entry);
  const taken = applyPendingRenames(entries, folder).some((item) => item.name === newName);
  if (taken) {
    const message = `"${newName}" already exists in this folder.`;
    setStatus(message, true);
    notify({ title: "Rename failed", message, type: "error" });
    return;
  }

  const pending = pendingRenames.get(folder) || new Map();
  pending.set(entry.name, newName);
  pendingRenames.set(folder, pending);
  selection.delete(oldPath);
  if (selectionAnchor === oldPath) {
    selectionAnchor = null;
  }
  applySelection();
  for (const other of panes) {
    other.repaintPending(folder);
  }

  try {
    await window.rcloneGui.renameRemoteItem({
      remote,
      path: joinSubPath(subPath, entry.name),
      isDir: Boolean(entry.isDir),
      newName,
    });
  } catch (error) {
    clearPendingRename(folder, entry.name);
    const message = String(error?.message || "Could not rename the item.").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
    for (const other of panes) {
      other.repaintPending(folder);
      other.softRefresh(folder);
    }
    if (currentPath() === folder && !searchState) {
      setStatus(message, true);
    }
    notify({ title: "Rename failed", message, type: "error" });
    return;
  }

  clearPendingRename(folder, entry.name);
  dropCachedListings(folder);
  dropCachedListings(oldPath);
  for (const other of panes) {
    other.settleRename(folder, entry.name, newName, { select: other === pane });
    other.softRefresh(folder);
  }
  notify({ title: "Renamed", message: `${entry.name} to ${newName}`, type: "success" });
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
  searchTokenCounter += 1;
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
  const token = ++searchTokenCounter;
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

function showContextMenu(event) {
  event.preventDefault();
  const row = event.target.closest("tr[data-path]");
  if (row?.classList.contains("is-pending")) {
    return;
  }
  closeContextMenu();
  setActivePane(pane);

  const onBlankSpace = !row;
  if (onBlankSpace && !canCreateFolder() && !canPickUpload()) {
    return;
  }

  if (row) {
    const path = row.dataset.path;
    const entry = entries.find((item) => entryPath(item) === path);
    if (entry && !selection.has(path)) {
      selectEntry(entry);
    }
  } else {
    selectEntry(null);
  }

  contextPane = pane;
  const menuWidth = 220;
  const menuHeight = 160;
  let left = event.clientX;
  let top = event.clientY;
  if (left + menuWidth > window.innerWidth) {
    left = window.innerWidth - menuWidth - 10;
  }
  if (top + menuHeight > window.innerHeight) {
    top = window.innerHeight - menuHeight - 10;
  }

  contextUi.menu.style.left = left + "px";
  contextUi.menu.style.top = top + "px";
  contextUi.menu.classList.remove("hidden");
  contextUi.menu.setAttribute("aria-hidden", "false");

  const canPreview = selectedPath && canPreviewSelection();
  contextUi.previewBtn.classList.toggle("hidden", !canPreview || loading);
  contextUi.previewBtn.disabled = !canPreview || loading;

  const canDownload = canDownloadSelection() && Boolean(window.rcloneGui?.downloadRemoteFile);
  contextUi.downloadBtn.classList.toggle("hidden", !canDownload);
  contextUi.downloadBtn.disabled = !canDownload;
  contextMenuLabel(contextUi.downloadBtn, "Download", downloadableItems().length, "file");

  const canAcross = canTransferAcross();
  const first = panes[0] === pane;
  for (const [button, base] of [[contextUi.copyAcrossBtn, "Copy"], [contextUi.moveAcrossBtn, "Move"]]) {
    button.classList.toggle("hidden", !canAcross);
    button.disabled = !canAcross;
    const label = button.querySelector(".context-menu-label");
    if (label && selection.size > 1) {
      label.textContent = `${base} ${selection.size} items to ${first ? "the right" : "the left"}`;
    } else if (label) {
      label.textContent = `${base} to ${first ? "the right" : "the left"}`;
    }
  }

  const canRename = canRenameSelection();
  contextUi.renameBtn?.classList.toggle("hidden", !canRename);
  if (contextUi.renameBtn) {
    contextUi.renameBtn.disabled = !canRename;
  }

  const canDelete = canDeleteSelection();
  contextUi.deleteBtn.classList.toggle("hidden", !canDelete);
  contextUi.deleteBtn.disabled = !canDelete;
  contextMenuLabel(contextUi.deleteBtn, "Delete", selection.size, "item");

  const canNewFolderHere = onBlankSpace && canCreateFolder();
  contextUi.newFolderBtn?.classList.toggle("hidden", !canNewFolderHere);
  if (contextUi.newFolderBtn) {
    contextUi.newFolderBtn.disabled = !canNewFolderHere;
  }

  const canUploadHere = onBlankSpace && canPickUpload();
  contextUi.uploadBtn?.classList.toggle("hidden", !canUploadHere);
  if (contextUi.uploadBtn) {
    contextUi.uploadBtn.disabled = !canUploadHere;
  }
}

function chooseRemote(name) {
  currentRemote = name;
  currentSubPath = "";
  remoteBrowser.remotePicker.value = name;
  clearSelectionState();
  resetBrowseHistory(currentRemote, "");
  void loadListing("navigate");
}

function openLocation(remote, subPath = "") {
  remoteBrowser.remotePicker.value = remote;
  currentRemote = remote;
  currentSubPath = "";
  resetBrowseHistory(remote, "");
  void navigateTo(subPath);
}

function restoreLocation(remote, subPath = "") {
  if (!remote || !browseRemotes.includes(remote)) {
    return;
  }
  remoteBrowser.remotePicker.value = remote;
  currentRemote = remote;
  currentSubPath = trimSlashes(String(subPath || "").replace(/\\/g, "/"));
  resetBrowseHistory(remote, currentSubPath);
  renderBreadcrumbs();
  updateActionState();
}

function bindPaneEvents() {
  remoteBrowser.remotePicker.addEventListener("change", () => {
    chooseRemote(remoteBrowser.remotePicker.value);
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

  remoteBrowser.splitBtn.addEventListener("click", () => setSplit(!splitOn));

  bindSearch();

  remoteBrowser.loadingCancelBtn?.addEventListener("click", () => {
    cancelLoading();
  });

  bindUploadDrop();

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
    const contextMenuOpen = !contextUi.menu?.classList.contains("hidden");
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && entries.length) {
      event.preventDefault();
      selectAllEntries();
    } else if (event.key === "Escape" && selection.size && !contextMenuOpen) {
      event.preventDefault();
      selectEntry(null);
    } else if (event.key === "F2" && canRenameSelection()) {
      event.preventDefault();
      startRename();
    } else if (event.key === "Delete" && canDeleteSelection()) {
      event.preventDefault();
      void deleteSelectedFile();
    }
  });

  remoteBrowser.tableHead?.addEventListener("click", (event) => {
    const header = event.target.closest(".browse-col-sortable");
    if (header?.dataset.sort) {
      event.preventDefault();
      setSort(header.dataset.sort);
    }
  });

  remoteBrowser.tableWrap?.addEventListener("contextmenu", showContextMenu);
  remoteBrowser.entriesBody.addEventListener("click", () => closeContextMenu());

  root.addEventListener("pointerdown", () => setActivePane(pane), true);
  root.addEventListener("focusin", () => setActivePane(pane));
}

function onViewShown() {
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

function onSplitChange() {
  renderEntries({ animate: false });
  updateActionState();
}

function focusList() {
  const target = root.querySelector("tr.is-selected") || root.querySelector("tr[data-path]") || remoteBrowser.remotePicker;
  target?.focus({ preventScroll: false });
}

function softRefresh(path) {
  if (root.hidden || !currentRemote || loading || searchState || currentPath() !== path) {
    return false;
  }
  void revalidateListing(path, loadToken);
  return true;
}

function prepareDrag(entry) {
  if (!selection.has(entryPath(entry))) {
    selectEntry(entry);
  }
  return selectedItems();
}

Object.assign(pane, {
  getRemote: () => currentRemote,
  getSubPath: () => currentSubPath,
  getLocation: () => ({ remote: currentRemote, subPath: currentSubPath }),
  currentPath,
  isSearching: () => Boolean(searchState),
  existingNames: () => new Set(searchState ? [] : applyPendingRenames(entries, currentPath()).map((entry) => entry.name)),
  selectedItems,
  prepareDrag,
  setTransferTarget,
  canUpload,
  canPickUpload,
  canCreateFolder,
  canTransferAcross,
  uploadToCurrentFolder,
  pickAndUpload,
  showNewFolderDialog,
  previewSelectedFile,
  downloadSelectedFile,
  deleteSelectedFile,
  startRename,
  useActivePath,
  loadListing,
  chooseRemote,
  openLocation,
  restoreLocation,
  fillRemotePicker,
  labelRemoteOptions,
  renderBreadcrumbs,
  updateActionState,
  applyStatus,
  refreshMeter: () => browseMeter?.refresh(),
  historyBack: browseHistoryBack,
  historyForward: browseHistoryForward,
  navigatePreview,
  previewContext: () => ({ size: selectedSize, total: previewableFiles.length, index: currentPreviewIndex, path: selectedPath || "" }),
  softRefresh,
  repaintPending,
  settleRename,
  onViewShown,
  onSplitChange,
  focusList,
  searchInput: remoteBrowser.searchInput,
});

bindPaneEvents();
fillRemotePicker();
updateTableSortIndicators();
return pane;
}

function closeContextMenu() {
  if (!contextUi.menu) {
    return;
  }
  contextUi.menu.classList.add("hidden");
  contextUi.menu.setAttribute("aria-hidden", "true");
}

function bindContextMenu() {
  const { menu, downloadBtn, deleteBtn, previewBtn, newFolderBtn, uploadBtn, copyAcrossBtn, moveAcrossBtn } = contextUi;
  if (!menu || !downloadBtn || !previewBtn || !deleteBtn) {
    return;
  }

  menu.querySelector("[data-context-close]")?.addEventListener("click", closeContextMenu);

  document.addEventListener("click", (event) => {
    if (!menu.classList.contains("hidden") && !menu.contains(event.target)) {
      closeContextMenu();
    }
  });

  menu.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    closeContextMenu();
    const underneath = document.elementFromPoint(event.clientX, event.clientY);
    if (!underneath || !browseUi.panesHost.contains(underneath)) {
      return;
    }
    underneath.dispatchEvent(new MouseEvent("contextmenu", {
      clientX: event.clientX,
      clientY: event.clientY,
      bubbles: true,
      cancelable: true,
    }));
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.classList.contains("hidden")) {
      closeContextMenu();
    }
  });

  newFolderBtn?.addEventListener("click", () => {
    closeContextMenu();
    if (contextPane?.canCreateFolder()) {
      void contextPane.showNewFolderDialog();
    }
  });

  uploadBtn?.addEventListener("click", () => {
    closeContextMenu();
    void contextPane?.pickAndUpload();
  });

  previewBtn.addEventListener("click", () => {
    closeContextMenu();
    void contextPane?.previewSelectedFile();
  });

  downloadBtn.addEventListener("click", () => {
    closeContextMenu();
    void contextPane?.downloadSelectedFile();
  });

  deleteBtn.addEventListener("click", () => {
    closeContextMenu();
    void contextPane?.deleteSelectedFile();
  });

  contextUi.renameBtn?.addEventListener("click", () => {
    closeContextMenu();
    contextPane?.startRename();
  });

  copyAcrossBtn?.addEventListener("click", () => {
    closeContextMenu();
    void transferItems(contextPane, otherPaneOf(contextPane), "copy");
  });

  moveAcrossBtn?.addEventListener("click", () => {
    closeContextMenu();
    void transferItems(contextPane, otherPaneOf(contextPane), "move");
  });
}

function bindGlobalEvents() {
  const ui = browseUi;
  ui.newFolderBtn?.addEventListener("click", () => {
    if (activePane.canCreateFolder()) {
      void activePane.showNewFolderDialog();
    }
  });
  ui.uploadBtn?.addEventListener("click", () => void activePane.pickAndUpload());
  ui.previewBtn?.addEventListener("click", () => void activePane.previewSelectedFile());
  ui.downloadBtn?.addEventListener("click", () => void activePane.downloadSelectedFile());
  ui.deleteBtn?.addEventListener("click", () => void activePane.deleteSelectedFile());
  ui.useSourceBtn.addEventListener("click", () => activePane.useActivePath("source"));
  ui.useDestBtn.addEventListener("click", () => activePane.useActivePath("destination"));
  ui.copyAcrossBtn.addEventListener("click", () => void transferItems(activePane, otherPaneOf(activePane), "copy"));
  ui.moveAcrossBtn.addEventListener("click", () => void transferItems(activePane, otherPaneOf(activePane), "move"));

  bindPendingUpload();
  bindDivider();
  bindContextMenu();

  const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
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

  previewUi.previousBtn?.addEventListener("click", () => previewOwner?.navigatePreview(-1));
  previewUi.nextBtn?.addEventListener("click", () => previewOwner?.navigatePreview(1));
  previewUi.closeBtn?.addEventListener("click", closePreview);
  for (const closer of previewUi.dialog?.querySelectorAll("[data-preview-close]") || []) {
    closer.addEventListener("click", closePreview);
  }

  document.addEventListener("keydown", (event) => {
    const previewOpen = previewUi.dialog && !previewUi.dialog.classList.contains("hidden");
    if (event.key === "Escape" && previewOpen) {
      closePreview();
    }
    if (previewOpen) {
      if (event.key === "ArrowLeft") {
        previewOwner?.navigatePreview(-1);
      } else if (event.key === "ArrowRight") {
        previewOwner?.navigatePreview(1);
      }
      return;
    }

    if (!isBrowseViewVisible() || document.querySelector(".popup-root:not(.hidden)")) {
      return;
    }
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.code === "Backslash") {
      event.preventDefault();
      setSplit(!splitOn);
    } else if (modifier && event.key === "Tab" && splitOn) {
      event.preventDefault();
      switchPane();
    } else if (modifier && event.key.toLowerCase() === "f" && activePane.searchInput && !activePane.searchInput.disabled) {
      event.preventDefault();
      activePane.searchInput.focus();
      activePane.searchInput.select();
    }
  });

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

  const saved = readSplitState();
  const template = browseUi.paneTemplate.content.firstElementChild;
  const rootA = template.cloneNode(true);
  const rootB = template.cloneNode(true);
  browseUi.panesHost.insertBefore(rootA, browseUi.divider);
  browseUi.panesHost.appendChild(rootB);
  rootB.hidden = true;
  browseUi.divider.hidden = true;

  panes.push(createBrowserPane(rootA), createBrowserPane(rootB));
  activePane = panes[0];
  rootA.classList.add("is-active");

  applySplitRatio(typeof saved.ratio === "number" ? saved.ratio : 0.5);
  bindGlobalEvents();
  if (saved.on) {
    setSplit(true);
    if (saved.active === 1) {
      setActivePane(panes[1]);
    }
  }
  for (const pane of panes) {
    pane.updateActionState();
  }
}

function restartEnterAnimations() {
  const targets = browseUi.view.querySelectorAll(
    ".browse-panel, .browse-toolbar, .browse-breadcrumbs, .browse-table-wrap, .browse-status, .browse-footer",
  );
  for (const el of targets) {
    el.style.animation = "none";
  }
  void browseUi.view.offsetWidth;
  for (const el of targets) {
    el.style.animation = "";
  }
}

function show() {
  const wasHidden = browseUi.view.classList.contains("hidden") || browseUi.view.hidden;
  browseUi.view.classList.remove("hidden");
  browseUi.view.hidden = false;
  if (!wasHidden) {
    return;
  }
  restartEnterAnimations();
  for (const pane of panes) {
    if (!pane.root.hidden) {
      pane.onViewShown();
    }
  }
}

function hide() {
  browseUi.view.classList.add("hidden");
  browseUi.view.hidden = true;
}

function browseRemote(name) {
  if (activePane && browseRemotes.includes(name)) {
    activePane.chooseRemote(name);
  }
}

window.RemoteBrowser = {
  init,
  setRemotes,
  queueUpload,
  show,
  hide,
  browseRemote,
  reload: (context) => activePane?.loadListing(context || "refresh"),
};
})();
