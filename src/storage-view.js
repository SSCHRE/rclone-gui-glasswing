(() => {
const { formatBytes, usedBytes, usageRatio, levelClass } = window.StorageUsage;

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;
const BACKGROUND_DELAY_MS = 8000;
const BACKGROUND_MAX_AGE_MS = 30 * 60 * 1000;
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FULL_RATIO = 0.9;
const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER_COLOR = "#5b6678";
const SVG_NS = "http://www.w3.org/2000/svg";

const storageView = {
  view: document.getElementById("storage-view"),
  tab: document.getElementById("mode-storage"),
  grid: document.getElementById("storage-grid"),
  empty: document.getElementById("storage-empty"),
  summary: document.getElementById("storage-summary"),
  refreshBtn: document.getElementById("storage-refresh"),
  sort: document.getElementById("storage-sort"),
  overview: document.getElementById("storage-overview"),
  local: document.getElementById("storage-local"),
  localGrid: document.getElementById("storage-local-grid"),
};

let remoteNames = [];
let remoteTypes = new Map();
let localDrives = [];
let drivesLoaded = false;
let history = {};
let options = {};
let backgroundStarted = false;
let renderQueued = false;
let overviewRefs = null;
let overviewSignature = "";
const cards = new Map();
const armedTrash = new Map();
const cleaning = new Set();

function targetOf(name) {
  return `${name}:`;
}

function entryOf(target) {
  return window.StorageUsage.get(target);
}

function allTargets() {
  return [...remoteNames.map(targetOf), ...localDrives.map((drive) => drive.target)];
}

function isLoading() {
  return allTargets().some((target) => entryOf(target)?.pending);
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}

function formatAge(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text != null) {
    element.textContent = text;
  }
  return element;
}

function skeleton(width) {
  const bone = createElement("span", "storage-skel");
  bone.style.width = width;
  bone.setAttribute("aria-hidden", "true");
  return bone;
}

function colorFor(name) {
  const index = [...remoteNames].sort((left, right) => left.localeCompare(right)).indexOf(name);
  return index >= 0 && index < SERIES_COLORS.length ? SERIES_COLORS[index] : OTHER_COLOR;
}

function currentUsage(target) {
  return entryOf(target)?.usage || null;
}

function readyUsage(target) {
  const usage = currentUsage(target);
  return usage && !usage.error && !usage.unsupported ? usage : null;
}

function signedBytes(value) {
  return `${value >= 0 ? "+" : "−"}${formatBytes(Math.abs(value))}`;
}

function describeDuration(days) {
  if (days < 14) {
    return `${Math.max(1, Math.round(days))} day${Math.round(days) === 1 ? "" : "s"}`;
  }
  if (days < 60) {
    return `${Math.round(days / 7)} weeks`;
  }
  if (days < 730) {
    return `${Math.round(days / 30)} months`;
  }
  return `${(days / 365).toFixed(1)} years`;
}

function dayTime(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

function shortDate(time) {
  return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function trendFor(target, usage) {
  const points = (history[target] || []).filter((point) => typeof point.used === "number");
  const cutoff = Date.now() - TREND_DAYS * DAY_MS;
  const recent = points.filter((point) => dayTime(point.day) >= cutoff - DAY_MS);
  if (recent.length < 2) {
    return { points: recent, weekDelta: null, fullIn: null };
  }

  const last = recent[recent.length - 1];
  const weekAgo = [...recent].reverse().find((point) => dayTime(point.day) <= dayTime(last.day) - 7 * DAY_MS)
    || (dayTime(last.day) - dayTime(recent[0].day) >= 3 * DAY_MS ? recent[0] : null);
  const weekDelta = weekAgo ? last.used - weekAgo.used : null;

  let fullIn = null;
  const first = recent[0];
  const spanDays = (dayTime(last.day) - dayTime(first.day)) / DAY_MS;
  const total = usage?.total;
  if (spanDays >= 7 && total > 0) {
    const perDay = (last.used - first.used) / spanDays;
    const free = total - last.used;
    if (perDay > 0 && free > 0) {
      const days = free / perDay;
      if (days <= 3650) {
        fullIn = days;
      }
    }
  }
  return { points: recent, weekDelta, fullIn };
}

function renderSparkline(points) {
  const wrap = createElement("div", "storage-trend");
  if (points.length < 2) {
    wrap.appendChild(createElement("p", "storage-trend-empty", "A usage trend shows up here after a few days."));
    return wrap;
  }

  const width = 240;
  const height = 40;
  const times = points.map((point) => dayTime(point.day));
  const values = points.map((point) => point.used);
  const minTime = Math.min(...times);
  const spanTime = Math.max(1, Math.max(...times) - minTime);
  const minValue = Math.min(...values);
  const spanValue = Math.max(...values) - minValue;
  const x = (time) => 4 + ((time - minTime) / spanTime) * (width - 8);
  const y = (value) => (spanValue ? height - 5 - ((value - minValue) / spanValue) * (height - 10) : height / 2);
  const coords = points.map((point, index) => [x(times[index]), y(values[index])]);

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "storage-trend-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Used space over the last ${TREND_DAYS} days, from ${formatBytes(values[0])} to ${formatBytes(values[values.length - 1])}`);

  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("class", "storage-trend-area");
  area.setAttribute("d", `M${coords[0][0]},${height} ${coords.map(([px, py]) => `L${px},${py}`).join(" ")} L${coords[coords.length - 1][0]},${height} Z`);
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("class", "storage-trend-line");
  line.setAttribute("d", coords.map(([px, py], index) => `${index ? "L" : "M"}${px},${py}`).join(" "));
  line.setAttribute("vector-effect", "non-scaling-stroke");
  const cursor = document.createElementNS(SVG_NS, "line");
  cursor.setAttribute("class", "storage-trend-cursor");
  cursor.setAttribute("y1", "0");
  cursor.setAttribute("y2", String(height));
  cursor.setAttribute("vector-effect", "non-scaling-stroke");
  cursor.style.display = "none";
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("class", "storage-trend-dot");
  dot.setAttribute("r", "3");
  dot.style.display = "none";
  svg.append(area, line, cursor, dot);

  const tip = createElement("span", "storage-trend-tip hidden");
  const plot = createElement("div", "storage-trend-plot");
  plot.append(svg, tip);

  plot.addEventListener("mousemove", (event) => {
    const box = plot.getBoundingClientRect();
    const relative = ((event.clientX - box.left) / box.width) * width;
    let nearest = 0;
    for (let index = 1; index < coords.length; index += 1) {
      if (Math.abs(coords[index][0] - relative) < Math.abs(coords[nearest][0] - relative)) {
        nearest = index;
      }
    }
    const [px, py] = coords[nearest];
    cursor.setAttribute("x1", String(px));
    cursor.setAttribute("x2", String(px));
    cursor.style.display = "";
    dot.setAttribute("cx", String(px));
    dot.setAttribute("cy", String(py));
    dot.style.display = "";
    tip.textContent = `${shortDate(times[nearest])}: ${formatBytes(values[nearest])} used`;
    tip.classList.remove("hidden");
    tip.style.left = `${Math.min(Math.max((px / width) * box.width, 70), box.width - 70)}px`;
  });
  plot.addEventListener("mouseleave", () => {
    cursor.style.display = "none";
    dot.style.display = "none";
    tip.classList.add("hidden");
  });

  const axis = createElement("div", "storage-trend-axis");
  axis.append(createElement("span", null, shortDate(times[0])), createElement("span", null, "Today"));
  wrap.append(plot, axis);
  return wrap;
}

function detail(label, value) {
  const item = createElement("div", "storage-detail");
  const valueNode = createElement("span", "storage-detail-value");
  if (value instanceof Node) {
    valueNode.appendChild(value);
  } else {
    valueNode.textContent = value;
  }
  item.append(createElement("span", "storage-detail-label", label), valueNode);
  return item;
}

function loadingBody(showTrend) {
  const figure = createElement("p", "storage-card-figure");
  const strong = createElement("strong");
  strong.appendChild(skeleton("8.5em"));
  figure.append(strong);
  const track = createElement("div", "storage-bar");
  track.appendChild(createElement("div", "storage-bar-fill"));
  const details = createElement("div", "storage-details");
  details.append(detail("Used", skeleton("2.6em")), detail("Free", skeleton("3.6em")));
  if (!showTrend) {
    return [figure, track, details];
  }
  const trend = createElement("div", "storage-trend");
  const bone = skeleton("100%");
  bone.classList.add("storage-skel-block");
  trend.appendChild(bone);
  const notes = createElement("div", "storage-trend-notes");
  notes.appendChild(skeleton("9em"));
  return [figure, track, details, trend, notes];
}

function unsupportedBody() {
  return [
    createElement("p", "storage-card-figure", "Not reported"),
    createElement("p", "storage-card-note", "This storage type doesn't report its usage to rclone."),
  ];
}

function errorBody(target, usage) {
  const message = usage.error.charAt(0).toUpperCase() + usage.error.slice(1);
  const note = createElement("p", "storage-card-note", message);
  note.title = message;
  const retry = createElement("button", "secondary storage-card-retry", "Try again");
  retry.type = "button";
  retry.addEventListener("click", () => void window.StorageUsage.load(target, { force: true }));
  return [createElement("p", "storage-card-figure", "Couldn't check usage"), note, retry];
}

function usageBody(target, label, usage, showTrend) {
  const used = usedBytes(usage);
  const ratio = usageRatio(usage);

  const figure = createElement("p", "storage-card-figure");
  figure.append(
    createElement("strong", null, formatBytes(used)),
    document.createTextNode(ratio != null ? ` of ${formatBytes(usage.total)} used` : " used"),
  );

  const track = createElement("div", "storage-bar");
  track.setAttribute("role", "meter");
  track.setAttribute("aria-label", `${label} storage used`);
  const fill = createElement("div", "storage-bar-fill");
  if (ratio != null) {
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    fill.style.width = `${Math.max(ratio * 100, 1)}%`;
  } else {
    track.classList.add("is-unknown");
  }
  track.appendChild(fill);

  const details = createElement("div", "storage-details");
  if (ratio != null) {
    details.appendChild(detail("Used", `${Math.round(ratio * 100)}%`));
  }
  if (typeof usage.free === "number") {
    details.appendChild(detail("Free", formatBytes(usage.free)));
  } else if (ratio == null) {
    details.appendChild(detail("Limit", "None reported"));
  }
  if (usage.trashed) {
    details.appendChild(detail("In trash", formatBytes(usage.trashed)));
  }
  if (usage.other) {
    details.appendChild(detail("Other", formatBytes(usage.other)));
  }
  if (typeof usage.objects === "number") {
    details.appendChild(detail("Files", formatCount(usage.objects)));
  }

  const level = ratio != null ? levelClass(ratio) : "";
  if (!showTrend) {
    return { nodes: [figure, track, details], level };
  }

  const trend = trendFor(target, usage);
  const notes = createElement("div", "storage-trend-notes");
  if (trend.weekDelta != null) {
    notes.appendChild(createElement(
      "span",
      `storage-trend-delta${trend.weekDelta > 0 ? " is-up" : trend.weekDelta < 0 ? " is-down" : ""}`,
      trend.weekDelta === 0 ? "No change this week" : `${signedBytes(trend.weekDelta)} this week`,
    ));
  }
  if (trend.fullIn != null) {
    notes.appendChild(createElement(
      "span",
      `storage-trend-full${trend.fullIn < 30 ? " is-urgent" : ""}`,
      `Full in about ${describeDuration(trend.fullIn)} at this rate`,
    ));
  }
  return { nodes: [figure, track, details, renderSparkline(trend.points), notes], level };
}

function createCard(spec) {
  const card = createElement("article", "storage-card is-loading");
  card.dataset.target = spec.target;
  card.addEventListener("animationend", (event) => {
    if (event.target === card) {
      card.classList.add("is-settled");
    }
  });

  const head = createElement("div", "storage-card-head");
  const title = createElement("h3", "storage-card-name");
  const swatch = createElement("span", "storage-card-swatch hidden");
  swatch.setAttribute("aria-hidden", "true");
  title.append(swatch, document.createTextNode(spec.label));
  const badge = createElement("span", "remote-type-badge is-pending", "type");
  head.append(title, badge);

  const body = createElement("div", "storage-card-body");
  body.append(...loadingBody(spec.isRemote));
  card.append(head, body);

  let actions = null;
  if (spec.isRemote) {
    actions = createElement("div", "storage-card-actions");
    const browse = createElement("button", "secondary storage-card-action", "Browse");
    browse.type = "button";
    browse.addEventListener("click", () => options.onBrowse?.(spec.name));
    actions.appendChild(browse);
    card.appendChild(actions);
  }

  return { el: card, swatch, badge, body, actions, trash: null, bodySignature: "loading", headSignature: "" };
}

function trashButton(name, usage) {
  const armed = armedTrash.has(name);
  const busy = cleaning.has(name);
  const button = createElement(
    "button",
    `secondary storage-card-action${armed ? " danger" : ""}`,
    busy ? "Emptying…" : armed ? `Delete ${formatBytes(usage.trashed)} for good?` : "Empty trash",
  );
  button.type = "button";
  button.disabled = busy;
  button.addEventListener("click", () => void emptyTrash(name));
  return button;
}

function updateCard(card, spec) {
  const headSignature = `${spec.badge || ""}|${spec.color || ""}`;
  if (headSignature !== card.headSignature) {
    card.headSignature = headSignature;
    card.badge.textContent = spec.badge || "type";
    card.badge.classList.toggle("is-pending", !spec.badge);
    card.swatch.classList.toggle("hidden", !spec.color);
    card.swatch.style.background = spec.color || "";
  }

  const usage = currentUsage(spec.target);
  const historyPoints = history[spec.target] || [];
  const state = !usage ? "loading" : usage.unsupported ? "unsupported" : usage.error ? "error" : "ready";
  const bodySignature = JSON.stringify([
    state,
    usage,
    historyPoints.length,
    historyPoints[historyPoints.length - 1]?.used ?? null,
  ]);

  if (bodySignature !== card.bodySignature) {
    card.bodySignature = bodySignature;
    let level = "";
    if (state === "loading") {
      card.body.replaceChildren(...loadingBody(spec.isRemote));
    } else if (state === "unsupported") {
      card.body.replaceChildren(...unsupportedBody());
    } else if (state === "error") {
      card.body.replaceChildren(...errorBody(spec.target, usage));
    } else {
      const result = usageBody(spec.target, spec.label, usage, spec.isRemote);
      card.body.replaceChildren(...result.nodes);
      level = result.level;
    }
    card.el.classList.toggle("is-loading", state === "loading");
    card.el.setAttribute("aria-busy", String(state === "loading"));
    card.el.classList.toggle("is-muted", state === "unsupported");
    card.el.classList.toggle("is-error", state === "error");
    card.el.classList.toggle("is-warn", level === "is-warn");
    card.el.classList.toggle("is-full", level === "is-full");
  }

  if (card.actions) {
    const showTrash = state === "ready" && usage.trashed > 0 && Boolean(window.rcloneGui?.cleanupRemote);
    const trashSignature = showTrash ? `${usage.trashed}|${armedTrash.has(spec.name)}|${cleaning.has(spec.name)}` : "";
    if (trashSignature !== card.trashSignature) {
      card.trashSignature = trashSignature;
      card.trash?.remove();
      card.trash = showTrash ? trashButton(spec.name, usage) : null;
      if (card.trash) {
        card.actions.appendChild(card.trash);
      }
    }
  }
}

function reconcile(container, specs) {
  const wanted = new Set(specs.map((spec) => spec.target));
  for (const [target, card] of cards) {
    if (card.el.parentElement === container && !wanted.has(target)) {
      card.el.remove();
      cards.delete(target);
    }
  }

  let previous = null;
  for (const spec of specs) {
    let card = cards.get(spec.target);
    if (!card) {
      card = createCard(spec);
      cards.set(spec.target, card);
    }
    updateCard(card, spec);
    const expectedNext = previous ? previous.nextSibling : container.firstChild;
    if (card.el !== expectedNext) {
      container.insertBefore(card.el, expectedNext);
    }
    previous = card.el;
  }
}

async function emptyTrash(name) {
  if (!armedTrash.has(name)) {
    armedTrash.set(name, setTimeout(() => {
      armedTrash.delete(name);
      scheduleRender();
    }, 5000));
    scheduleRender();
    return;
  }
  clearTimeout(armedTrash.get(name));
  armedTrash.delete(name);
  cleaning.add(name);
  scheduleRender();
  try {
    await window.rcloneGui.cleanupRemote(name);
    options.notify?.({ title: "Trash emptied", message: `${name}: trash is empty now.`, type: "success" });
  } catch (error) {
    const message = String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
    options.notify?.({ title: "Couldn't empty the trash", message: message || "rclone cleanup failed.", type: "error" });
  } finally {
    cleaning.delete(name);
    await window.StorageUsage.load(targetOf(name), { force: true });
    await refreshHistory();
    scheduleRender();
  }
}

function sortedRemotes() {
  const mode = storageView.sort?.value || "name";
  const list = [...remoteNames];
  const ratioOf = (name) => usageRatio(readyUsage(targetOf(name))) ?? -1;
  const freeOf = (name) => {
    const usage = readyUsage(targetOf(name));
    if (!usage) {
      return -1;
    }
    return typeof usage.free === "number" ? usage.free : usage.total != null ? usage.total - usedBytes(usage) : -1;
  };
  if (mode === "fullest") {
    list.sort((left, right) => ratioOf(right) - ratioOf(left) || left.localeCompare(right));
  } else if (mode === "free") {
    list.sort((left, right) => freeOf(right) - freeOf(left) || left.localeCompare(right));
  } else {
    list.sort((left, right) => left.localeCompare(right));
  }
  return list;
}

function buildOverview() {
  const tiles = createElement("div", "storage-tiles");
  const values = {};
  for (const [key, label] of [["used", "Used across remotes"], ["free", "Free space"], ["full", "Nearly full"]]) {
    const tile = createElement("div", "stat-card storage-tile");
    const value = createElement("span", "stat-value");
    tile.append(createElement("span", "stat-label", label), value);
    tiles.appendChild(tile);
    values[key] = { tile, value };
  }

  const figure = createElement("figure", "storage-split");
  figure.appendChild(createElement("figcaption", "storage-split-title", "Where your data lives"));
  const wrap = createElement("div", "storage-split-wrap");
  const bar = createElement("div", "storage-split-bar");
  bar.setAttribute("role", "img");
  const tip = createElement("span", "storage-split-tip hidden");
  wrap.append(bar, tip);
  const legend = createElement("ul", "storage-split-legend");
  figure.append(wrap, legend);

  storageView.overview.replaceChildren(tiles, figure);
  return { values, figure, bar, tip, legend };
}

function setTileValue(ref, text, tone = "") {
  ref.value.replaceChildren(text == null ? skeleton("4em") : document.createTextNode(text));
  ref.tile.classList.toggle("is-bad", tone === "bad");
}

function renderOverview() {
  if (!remoteNames.length) {
    storageView.overview.classList.add("hidden");
    return;
  }
  storageView.overview.classList.remove("hidden");
  if (!overviewRefs) {
    overviewRefs = buildOverview();
  }

  let used = 0;
  let capacity = 0;
  let free = 0;
  let nearlyFull = 0;
  let settled = 0;
  const shares = [];
  for (const name of remoteNames) {
    const usage = currentUsage(targetOf(name));
    if (usage) {
      settled += 1;
    }
    const ready = readyUsage(targetOf(name));
    const remoteUsed = ready ? usedBytes(ready) : null;
    if (remoteUsed != null) {
      used += remoteUsed;
      shares.push({ name, used: remoteUsed });
    }
    const ratio = usageRatio(ready);
    if (ratio != null) {
      capacity += ready.total;
      free += Math.max(0, ready.total - remoteUsed);
      if (ratio >= FULL_RATIO) {
        nearlyFull += 1;
      }
    }
  }
  const waiting = settled === 0;
  const signature = JSON.stringify([waiting, used, capacity, free, nearlyFull, shares, remoteNames]);
  if (signature === overviewSignature) {
    return;
  }
  overviewSignature = signature;

  setTileValue(overviewRefs.values.used, waiting ? null : formatBytes(used));
  setTileValue(overviewRefs.values.free, waiting ? null : capacity ? formatBytes(free) : "—");
  setTileValue(overviewRefs.values.full, waiting ? null : String(nearlyFull), nearlyFull ? "bad" : "");

  const { bar, tip, legend, figure } = overviewRefs;
  const sized = shares.filter((share) => share.used > 0);
  if (waiting || !sized.length) {
    figure.classList.toggle("is-empty", !waiting);
    bar.replaceChildren(skeleton("100%"));
    bar.setAttribute("aria-label", waiting ? "Checking where your data lives" : "No usage reported yet");
    legend.replaceChildren(createElement("li", "storage-split-item storage-split-pending", waiting ? "Checking…" : "No usage reported yet"));
    return;
  }
  figure.classList.remove("is-empty");

  const ordered = [...sized].sort((left, right) => right.used - left.used);
  const named = ordered.filter((share) => colorFor(share.name) !== OTHER_COLOR);
  const others = ordered.filter((share) => colorFor(share.name) === OTHER_COLOR);
  const segments = named.map((share) => ({ ...share, color: colorFor(share.name) }));
  if (others.length) {
    segments.push({ name: `${others.length} other${others.length === 1 ? "" : "s"}`, used: others.reduce((sum, share) => sum + share.used, 0), color: OTHER_COLOR });
  }

  bar.setAttribute("aria-label", segments.map((segment) => `${segment.name} ${Math.round((segment.used / used) * 100)}%`).join(", "));
  bar.replaceChildren(...segments.map((segment) => {
    const part = createElement("span", "storage-split-seg");
    part.style.flexGrow = String(segment.used);
    part.style.background = segment.color;
    const describe = `${segment.name}: ${formatBytes(segment.used)} (${Math.round((segment.used / used) * 100)}%)`;
    part.addEventListener("mouseenter", () => {
      tip.textContent = describe;
      tip.classList.remove("hidden");
      const box = bar.getBoundingClientRect();
      const partBox = part.getBoundingClientRect();
      tip.style.left = `${Math.min(Math.max(partBox.left - box.left + partBox.width / 2, 80), box.width - 80)}px`;
      part.classList.add("is-hovered");
    });
    part.addEventListener("mouseleave", () => {
      tip.classList.add("hidden");
      part.classList.remove("is-hovered");
    });
    return part;
  }));
  legend.replaceChildren(...segments.map((segment) => {
    const item = createElement("li", "storage-split-item");
    const swatch = createElement("span", "storage-split-swatch");
    swatch.style.background = segment.color;
    swatch.setAttribute("aria-hidden", "true");
    item.append(
      swatch,
      createElement("span", "storage-split-name", segment.name),
      createElement("span", "storage-split-value", `${formatBytes(segment.used)} · ${Math.round((segment.used / used) * 100)}%`),
    );
    return item;
  }));
}

function renderSummary() {
  if (!remoteNames.length) {
    storageView.summary.textContent = "";
    return;
  }
  let lastLoadedAt = 0;
  for (const name of remoteNames) {
    lastLoadedAt = Math.max(lastLoadedAt, entryOf(targetOf(name))?.fetchedAt || 0);
  }
  const parts = [`${remoteNames.length} remote${remoteNames.length === 1 ? "" : "s"}`];
  if (isLoading()) {
    parts.push("Checking…");
  } else if (lastLoadedAt) {
    parts.push(`Updated ${formatAge(lastLoadedAt)}`);
  }
  const text = parts.join(" · ");
  if (storageView.summary.textContent !== text) {
    storageView.summary.textContent = text;
  }
}

function renderTabAlert() {
  if (!storageView.tab) {
    return;
  }
  const full = remoteNames.filter((name) => (usageRatio(readyUsage(targetOf(name))) ?? 0) >= FULL_RATIO);
  storageView.tab.classList.toggle("has-alert", full.length > 0);
  storageView.tab.title = full.length ? `Nearly full: ${full.join(", ")}` : "";
}

function render() {
  renderTabAlert();
  if (!isVisible()) {
    return;
  }
  storageView.empty.classList.toggle("hidden", remoteNames.length > 0);
  const colored = remoteNames.length > 1;
  reconcile(storageView.grid, sortedRemotes().map((name) => ({
    name,
    target: targetOf(name),
    label: name,
    badge: remoteTypes.get(name),
    color: colored ? colorFor(name) : null,
    isRemote: true,
  })));
  storageView.local.classList.toggle("hidden", !drivesLoaded || localDrives.length === 0);
  reconcile(storageView.localGrid, localDrives.map((drive) => ({
    name: drive.label,
    target: drive.target,
    label: drive.label,
    badge: "Local",
    color: null,
    isRemote: false,
  })));
  storageView.refreshBtn.disabled = isLoading() || allTargets().length === 0;
  renderOverview();
  renderSummary();
}

function scheduleRender() {
  if (renderQueued) {
    return;
  }
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

async function refreshHistory() {
  if (!window.rcloneGui?.getStorageHistory) {
    return;
  }
  try {
    history = await window.rcloneGui.getStorageHistory(allTargets());
  } catch {
    history = {};
  }
}

function loadUsage({ force = false, maxAgeMs } = {}) {
  return Promise.all(allTargets().map((target) => window.StorageUsage.load(target, { force, maxAgeMs }))).then(async () => {
    await refreshHistory();
    scheduleRender();
  });
}

async function refreshTypes() {
  try {
    const entries = await window.rcloneGui.listRemoteEntries();
    remoteTypes = new Map(entries.map((entry) => [entry.name, entry.type]));
  } catch {
    remoteTypes = new Map();
  }
  scheduleRender();
}

async function refreshDrives() {
  try {
    localDrives = (await window.rcloneGui.listLocalDrives?.()) || [];
  } catch {
    localDrives = [];
  }
  drivesLoaded = true;
  scheduleRender();
}

function isVisible() {
  return !storageView.view.hidden;
}

function startBackgroundChecks() {
  if (backgroundStarted) {
    return;
  }
  backgroundStarted = true;
  setTimeout(function tick() {
    for (const name of remoteNames) {
      void window.StorageUsage.load(targetOf(name), { maxAgeMs: BACKGROUND_MAX_AGE_MS });
    }
    setTimeout(tick, BACKGROUND_INTERVAL_MS);
  }, BACKGROUND_DELAY_MS);
}

function setRemotes(names) {
  remoteNames = [...(names || [])].sort((left, right) => left.localeCompare(right));
  if (remoteNames.length) {
    startBackgroundChecks();
  }
  if (isVisible()) {
    render();
    void refreshTypes();
    void loadUsage();
  } else {
    renderTabAlert();
  }
}

function show() {
  storageView.view.classList.remove("hidden");
  storageView.view.hidden = false;
  render();
  void refreshTypes();
  void Promise.all([refreshDrives(), refreshHistory()]).then(() => {
    render();
    return loadUsage({ maxAgeMs: 5 * 60 * 1000 });
  });
}

function hide() {
  storageView.view.classList.add("hidden");
  storageView.view.hidden = true;
}

window.StorageUsage.subscribe((target) => {
  if (allTargets().includes(target)) {
    scheduleRender();
  }
});

storageView.refreshBtn.addEventListener("click", () => {
  void refreshTypes();
  void refreshDrives().then(() => loadUsage({ force: true }));
});
storageView.sort?.addEventListener("change", scheduleRender);

window.StorageView = {
  setRemotes,
  show,
  hide,
  setOptions(next) {
    options = { ...options, ...next };
  },
};
})();
