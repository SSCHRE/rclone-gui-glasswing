(() => {
const { formatBytes, usedBytes, usageRatio, levelClass } = window.StorageUsage;

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_DAYS = 30;
const BACKGROUND_DELAY_MS = 8000;
const BACKGROUND_MAX_AGE_MS = 30 * 60 * 1000;
const BACKGROUND_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FULL_RATIO = 0.9;
const SERIES_COLORS = Array.from({ length: 8 }, (_, index) => `var(--storage-series-${index + 1})`);
const OTHER_COLOR = "var(--storage-series-other)";
const SVG_NS = "http://www.w3.org/2000/svg";
const COUNT_DURATION_MS = 900;
const GAUGE_ARC = "M13.62 50.38 A26 26 0 1 1 50.38 50.38";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const ICONS = {
  browse: ["M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"],
  trash: ["M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12", "M9 7V4h6v3"],
  alert: ["M12 3l9.5 16.5h-19z", "M12 10v4", "M12 17.5v.01"],
  retry: ["M20 11a8 8 0 1 0-2.3 5.7", "M20 5v6h-6"],
  slash: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M5.6 5.6l12.8 12.8"],
};

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
let gradientSeed = 0;
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

function svgNode(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function icon(name, className = "storage-icon") {
  const svg = svgNode("svg", {
    viewBox: "0 0 24 24",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.9,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: className,
  });
  for (const d of ICONS[name]) {
    svg.appendChild(svgNode("path", { d }));
  }
  return svg;
}

function actionButton(label, className, iconName) {
  const button = createElement("button", className);
  button.type = "button";
  if (iconName) {
    button.appendChild(icon(iconName));
  }
  button.appendChild(createElement("span", null, label));
  return button;
}

function skeleton(width) {
  const bone = createElement("span", "storage-skel");
  bone.style.width = width;
  bone.setAttribute("aria-hidden", "true");
  return bone;
}

function splitNumber(text) {
  const match = /^(-?[\d.,]+)(\s*)(.*)$/.exec(text);
  if (!match) {
    return null;
  }
  const value = Number(match[1].replace(/,/g, ""));
  if (Number.isNaN(value)) {
    return null;
  }
  const decimals = (match[1].split(".")[1] || "").length;
  return { value, decimals, unit: match[3] };
}

function paintNumber(target, value, decimals, unit) {
  const number = createElement("span", "storage-num", value.toFixed(decimals));
  target.replaceChildren(number);
  if (unit) {
    target.appendChild(createElement("span", "storage-unit", unit));
  }
}

function countTo(target, text) {
  const next = splitNumber(text);
  const previous = target.countState || null;
  cancelAnimationFrame(target.countFrame);
  if (!next) {
    target.countState = null;
    target.replaceChildren(document.createTextNode(text));
    return;
  }
  target.countState = next;
  const from = previous && previous.unit === next.unit ? previous.value : previous ? next.value : 0;
  if (reducedMotion.matches || from === next.value || !target.isConnected) {
    paintNumber(target, next.value, next.decimals, next.unit);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / COUNT_DURATION_MS);
    const eased = 1 - (1 - progress) ** 4;
    paintNumber(target, from + (next.value - from) * eased, next.decimals, next.unit);
    if (progress < 1) {
      target.countFrame = requestAnimationFrame(step);
    }
  };
  target.countFrame = requestAnimationFrame(step);
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
  const height = 44;
  const times = points.map((point) => dayTime(point.day));
  const values = points.map((point) => point.used);
  const minTime = Math.min(...times);
  const spanTime = Math.max(1, Math.max(...times) - minTime);
  const minValue = Math.min(...values);
  const spanValue = Math.max(...values) - minValue;
  const x = (time) => 3 + ((time - minTime) / spanTime) * (width - 6);
  const y = (value) => (spanValue ? height - 6 - ((value - minValue) / spanValue) * (height - 12) : height / 2);
  const coords = points.map((point, index) => [x(times[index]), y(values[index])]);

  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: "none",
    class: "storage-trend-svg",
    role: "img",
    "aria-label": `Used space over the last ${TREND_DAYS} days, from ${formatBytes(values[0])} to ${formatBytes(values[values.length - 1])}`,
  });

  gradientSeed += 1;
  const gradientId = `storage-trend-fill-${gradientSeed}`;
  const defs = svgNode("defs");
  const gradient = svgNode("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
  gradient.append(
    svgNode("stop", { offset: "0%", class: "storage-trend-stop-top" }),
    svgNode("stop", { offset: "100%", class: "storage-trend-stop-bottom" }),
  );
  defs.appendChild(gradient);

  const area = svgNode("path", {
    class: "storage-trend-area",
    fill: `url(#${gradientId})`,
    d: `M${coords[0][0]},${height} ${coords.map(([px, py]) => `L${px},${py}`).join(" ")} L${coords[coords.length - 1][0]},${height} Z`,
  });
  const line = svgNode("path", {
    class: "storage-trend-line",
    d: coords.map(([px, py], index) => `${index ? "L" : "M"}${px},${py}`).join(" "),
    "vector-effect": "non-scaling-stroke",
  });
  const cursor = svgNode("line", { class: "storage-trend-cursor", y1: 0, y2: height, "vector-effect": "non-scaling-stroke" });
  cursor.style.display = "none";
  svg.append(defs, area, line, cursor);

  const [endX, endY] = coords[coords.length - 1];
  const end = createElement("span", "storage-trend-end");
  end.style.left = `${(endX / width) * 100}%`;
  end.style.top = `${(endY / height) * 100}%`;
  end.setAttribute("aria-hidden", "true");
  const dot = createElement("span", "storage-trend-dot hidden");
  dot.setAttribute("aria-hidden", "true");

  const tip = createElement("span", "storage-trend-tip hidden");
  const plot = createElement("div", "storage-trend-plot");
  plot.append(svg, end, dot, tip);

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
    dot.style.left = `${(px / width) * 100}%`;
    dot.style.top = `${(py / height) * 100}%`;
    dot.classList.remove("hidden");
    tip.textContent = `${shortDate(times[nearest])}: ${formatBytes(values[nearest])} used`;
    tip.classList.remove("hidden");
    tip.style.left = `${Math.min(Math.max((px / width) * box.width, 70), box.width - 70)}px`;
  });
  plot.addEventListener("mouseleave", () => {
    cursor.style.display = "none";
    dot.classList.add("hidden");
    tip.classList.add("hidden");
  });

  const axis = createElement("div", "storage-trend-axis");
  axis.append(createElement("span", null, shortDate(times[0])), createElement("span", null, "Today"));
  wrap.append(plot, axis);
  return wrap;
}

function gauge(ratio, label) {
  const wrap = createElement("div", "storage-gauge");
  wrap.setAttribute("role", "meter");
  wrap.setAttribute("aria-label", `${label} storage used`);

  const svg = svgNode("svg", { viewBox: "0 0 64 64", class: "storage-gauge-svg", "aria-hidden": "true" });
  svg.appendChild(svgNode("path", { d: GAUGE_ARC, class: "storage-gauge-track", pathLength: 100 }));

  const center = createElement("span", "storage-gauge-label");
  if (ratio != null) {
    const percent = Math.round(ratio * 100);
    wrap.setAttribute("aria-valuemin", "0");
    wrap.setAttribute("aria-valuemax", "100");
    wrap.setAttribute("aria-valuenow", String(percent));
    gradientSeed += 1;
    const gradientId = `storage-gauge-fill-${gradientSeed}`;
    const defs = svgNode("defs");
    const gradient = svgNode("linearGradient", { id: gradientId, x1: 0, y1: 1, x2: 1, y2: 0 });
    gradient.append(
      svgNode("stop", { offset: "0%", class: "storage-gauge-stop-start" }),
      svgNode("stop", { offset: "100%", class: "storage-gauge-stop-end" }),
    );
    defs.appendChild(gradient);
    const value = svgNode("path", { d: GAUGE_ARC, class: "storage-gauge-value", pathLength: 100, stroke: `url(#${gradientId})` });
    value.style.setProperty("--value", String(Math.max(percent, 1)));
    svg.prepend(defs);
    svg.appendChild(value);
    center.append(createElement("span", "storage-num", String(percent)), createElement("span", "storage-unit", "%"));
  } else {
    wrap.classList.add("is-unknown");
    center.textContent = "∞";
  }
  wrap.append(svg, center);
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
  const main = createElement("div", "storage-card-main");
  const ring = skeleton("");
  ring.classList.add("storage-skel-ring");
  const figure = createElement("div", "storage-card-figure");
  figure.append(skeleton("5.5em"), skeleton("7em"), skeleton("4em"));
  main.append(ring, figure);
  if (!showTrend) {
    return [main];
  }
  const trend = createElement("div", "storage-trend");
  const bone = skeleton("100%");
  bone.classList.add("storage-skel-block");
  trend.appendChild(bone);
  const notes = createElement("div", "storage-trend-notes");
  notes.appendChild(skeleton("9em"));
  return [main, trend, notes];
}

function stateBody(iconName, title, message) {
  const head = createElement("div", "storage-card-state");
  const badge = createElement("span", "storage-card-state-icon");
  badge.appendChild(icon(iconName));
  head.append(badge, createElement("p", "storage-card-figure", title));
  const note = createElement("p", "storage-card-note", message);
  note.title = message;
  return [head, note];
}

function unsupportedBody() {
  return stateBody("slash", "Not reported", "This storage type doesn't report its usage to rclone.");
}

function errorBody(target, usage) {
  const message = usage.error.charAt(0).toUpperCase() + usage.error.slice(1);
  const retry = actionButton("Try again", "secondary storage-card-retry", "retry");
  retry.addEventListener("click", () => void window.StorageUsage.load(target, { force: true }));
  return [...stateBody("alert", "Couldn't check usage", message), retry];
}

function usageBody(target, label, usage, showTrend) {
  const used = usedBytes(usage);
  const ratio = usageRatio(usage);

  const figure = createElement("div", "storage-card-figure");
  figure.appendChild(createElement("strong", "storage-card-used", formatBytes(used)));
  figure.appendChild(createElement("span", "storage-card-of", ratio != null ? `used of ${formatBytes(usage.total)}` : "used, no limit reported"));
  const free = typeof usage.free === "number" ? usage.free : ratio != null ? usage.total - used : null;
  if (free != null) {
    figure.appendChild(createElement("span", "storage-card-free", `${formatBytes(free)} free`));
  }

  const main = createElement("div", "storage-card-main");
  main.append(gauge(ratio, label), figure);

  const extras = [];
  if (usage.trashed) {
    extras.push(detail("In trash", formatBytes(usage.trashed)));
  }
  if (usage.other) {
    extras.push(detail("Other", formatBytes(usage.other)));
  }
  if (typeof usage.objects === "number") {
    extras.push(detail("Files", formatCount(usage.objects)));
  }
  const nodes = [main];
  if (extras.length) {
    const details = createElement("div", "storage-details");
    details.append(...extras);
    nodes.push(details);
  }

  const level = ratio != null ? levelClass(ratio) : "";
  if (!showTrend) {
    return { nodes, level };
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
  return { nodes: [...nodes, renderSparkline(trend.points), notes], level };
}

function createCard(spec, index) {
  const card = createElement("article", `storage-card is-loading${spec.isRemote ? "" : " is-local"}`);
  card.dataset.target = spec.target;
  card.style.setProperty("--i", String(index));
  card.addEventListener("animationend", (event) => {
    if (event.target === card) {
      card.classList.add("is-settled");
    }
  });

  const head = createElement("div", "storage-card-head");
  const title = createElement("h3", "storage-card-name");
  const swatch = createElement("span", "storage-card-swatch hidden");
  swatch.setAttribute("aria-hidden", "true");
  title.append(swatch, createElement("span", "storage-card-label", spec.label));
  const badge = createElement("span", "remote-type-badge is-pending", "type");
  head.append(title, badge);

  const body = createElement("div", "storage-card-body");
  body.append(...loadingBody(spec.isRemote));
  card.append(head, body);

  let actions = null;
  if (spec.isRemote) {
    actions = createElement("div", "storage-card-actions");
    const browse = actionButton("Browse", "secondary storage-card-action", "browse");
    browse.addEventListener("click", () => options.onBrowse?.(spec.name));
    actions.appendChild(browse);
    card.appendChild(actions);
  }

  return { el: card, swatch, badge, body, actions, trash: null, bodySignature: "loading", headSignature: "" };
}

function trashButton(name, usage) {
  const armed = armedTrash.has(name);
  const busy = cleaning.has(name);
  const button = actionButton(
    busy ? "Emptying…" : armed ? `Delete ${formatBytes(usage.trashed)} for good?` : "Empty trash",
    `secondary storage-card-action storage-card-trash${armed ? " danger" : ""}`,
    "trash",
  );
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
  specs.forEach((spec, index) => {
    let card = cards.get(spec.target);
    if (!card) {
      card = createCard(spec, index);
      cards.set(spec.target, card);
    }
    updateCard(card, spec);
    const expectedNext = previous ? previous.nextSibling : container.firstChild;
    if (card.el !== expectedNext) {
      container.insertBefore(card.el, expectedNext);
    }
    previous = card.el;
  });
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
    const tile = createElement("div", `storage-tile storage-tile-${key}`);
    const value = createElement("span", "storage-tile-value");
    const sub = createElement("span", "storage-tile-sub");
    tile.append(createElement("span", "storage-tile-label", label), value, sub);
    tiles.appendChild(tile);
    values[key] = { tile, value, sub };
  }

  const figure = createElement("figure", "storage-split");
  const caption = createElement("figcaption", "storage-split-head");
  const total = createElement("span", "storage-split-total");
  caption.append(createElement("span", "storage-split-title", "Where your data lives"), total);
  figure.appendChild(caption);
  const wrap = createElement("div", "storage-split-wrap");
  const bar = createElement("div", "storage-split-bar");
  bar.setAttribute("role", "img");
  const tip = createElement("span", "storage-split-tip hidden");
  wrap.append(bar, tip);
  const legend = createElement("ul", "storage-split-legend");
  figure.append(wrap, legend);

  storageView.overview.replaceChildren(tiles, figure);
  return { values, figure, bar, tip, legend, total, parts: new Map(), introduced: false };
}

function setTileValue(ref, text, tone = "", sub = "") {
  if (text == null) {
    cancelAnimationFrame(ref.value.countFrame);
    ref.value.countState = null;
    ref.value.replaceChildren(skeleton("3.2em"));
    ref.sub.replaceChildren(skeleton("7em"));
  } else {
    countTo(ref.value, text);
    ref.sub.textContent = sub;
  }
  ref.tile.classList.toggle("is-bad", tone === "bad");
  ref.tile.classList.toggle("is-good", tone === "good");
}

function setHovered(segment, hovered) {
  segment.part.classList.toggle("is-hovered", hovered);
  segment.item.classList.toggle("is-hovered", hovered);
  overviewRefs.figure.classList.toggle("has-hover", hovered);
  const { bar, tip } = overviewRefs;
  if (!hovered) {
    tip.classList.add("hidden");
    return;
  }
  tip.textContent = segment.describe;
  tip.classList.remove("hidden");
  const box = bar.getBoundingClientRect();
  const partBox = segment.part.getBoundingClientRect();
  tip.style.left = `${Math.min(Math.max(partBox.left - box.left + partBox.width / 2, 80), box.width - 80)}px`;
}

function splitSegment(name) {
  const existing = overviewRefs.parts.get(name);
  if (existing) {
    return existing;
  }
  const part = createElement("span", "storage-split-seg");
  part.style.flexGrow = "0";
  const item = createElement("li", "storage-split-item");
  const swatch = createElement("span", "storage-split-swatch");
  swatch.setAttribute("aria-hidden", "true");
  const label = createElement("span", "storage-split-name", name);
  const value = createElement("span", "storage-split-value");
  item.append(swatch, label, value);
  const segment = { part, item, swatch, value, describe: "" };
  for (const node of [part, item]) {
    node.addEventListener("mouseenter", () => setHovered(segment, true));
    node.addEventListener("mouseleave", () => setHovered(segment, false));
  }
  overviewRefs.parts.set(name, segment);
  return segment;
}

function renderSplit(segments, used) {
  const { bar, legend, parts } = overviewRefs;
  const names = new Set(segments.map((segment) => segment.name));
  for (const [name, segment] of parts) {
    if (!names.has(name)) {
      segment.part.remove();
      segment.item.remove();
      parts.delete(name);
    }
  }
  bar.querySelector(".storage-skel")?.remove();
  legend.querySelector(".storage-split-pending")?.remove();

  const intro = !overviewRefs.introduced;
  overviewRefs.introduced = true;
  bar.classList.toggle("is-intro", intro);

  const grow = [];
  segments.forEach((segment, index) => {
    const ref = splitSegment(segment.name);
    const share = Math.round((segment.used / used) * 100);
    ref.describe = `${segment.name}: ${formatBytes(segment.used)} (${share}%)`;
    ref.part.style.background = segment.color;
    ref.part.style.setProperty("--i", String(index));
    ref.swatch.style.background = segment.color;
    ref.value.textContent = `${formatBytes(segment.used)} · ${share}%`;
    bar.appendChild(ref.part);
    legend.appendChild(ref.item);
    grow.push([ref.part, String(segment.used)]);
  });

  if (intro) {
    for (const [part, value] of grow) {
      part.style.flexGrow = value;
    }
    return;
  }
  requestAnimationFrame(() => {
    for (const [part, value] of grow) {
      part.style.flexGrow = value;
    }
  });
}

function clearSplit(message) {
  const { bar, legend, parts } = overviewRefs;
  for (const segment of parts.values()) {
    segment.part.remove();
    segment.item.remove();
  }
  parts.clear();
  overviewRefs.introduced = false;
  const bone = skeleton("100%");
  bar.replaceChildren(bone);
  legend.replaceChildren(createElement("li", "storage-split-item storage-split-pending", message));
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
  let limited = 0;
  let settled = 0;
  const full = [];
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
      limited += 1;
      if (ratio >= FULL_RATIO) {
        full.push(name);
      }
    }
  }
  const waiting = settled === 0;
  const signature = JSON.stringify([waiting, used, capacity, free, full, shares, remoteNames]);
  if (signature === overviewSignature) {
    return;
  }
  overviewSignature = signature;

  const { values, figure, total } = overviewRefs;
  if (waiting) {
    setTileValue(values.used, null);
    setTileValue(values.free, null);
    setTileValue(values.full, null);
  } else {
    const usedPercent = capacity ? Math.round((used / capacity) * 100) : null;
    setTileValue(values.used, formatBytes(used), "", capacity ? `${usedPercent}% of ${formatBytes(capacity)} total` : "No limits reported");
    setTileValue(values.free, capacity ? formatBytes(free) : "—", "", capacity ? `Across ${limited} remote${limited === 1 ? "" : "s"} with a limit` : "No limits reported");
    setTileValue(values.full, String(full.length), full.length ? "bad" : "good", full.length ? full.join(", ") : "Everything has room");
  }

  const sized = shares.filter((share) => share.used > 0);
  if (waiting || !sized.length) {
    figure.classList.toggle("is-empty", !waiting);
    overviewRefs.bar.setAttribute("aria-label", waiting ? "Checking where your data lives" : "No usage reported yet");
    total.textContent = "";
    clearSplit(waiting ? "Checking…" : "No usage reported yet");
    return;
  }
  figure.classList.remove("is-empty");
  total.textContent = `${formatBytes(used)} in total`;

  const ordered = [...sized].sort((left, right) => right.used - left.used);
  const named = ordered.filter((share) => colorFor(share.name) !== OTHER_COLOR);
  const others = ordered.filter((share) => colorFor(share.name) === OTHER_COLOR);
  const segments = named.map((share) => ({ ...share, color: colorFor(share.name) }));
  if (others.length) {
    segments.push({ name: `${others.length} other${others.length === 1 ? "" : "s"}`, used: others.reduce((sum, share) => sum + share.used, 0), color: OTHER_COLOR });
  }

  overviewRefs.bar.setAttribute("aria-label", segments.map((segment) => `${segment.name} ${Math.round((segment.used / used) * 100)}%`).join(", "));
  renderSplit(segments, used);
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
  const loading = isLoading();
  storageView.view.classList.toggle("is-loading", loading);
  storageView.refreshBtn.disabled = loading || allTargets().length === 0;
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
