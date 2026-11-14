(() => {
  const bridge = window.rcloneGui;
  const ui = {
    openBtn: document.getElementById("migration-open"),
    badge: document.getElementById("migration-badge"),
    dialog: document.getElementById("migration-dialog"),
    body: document.getElementById("migration-body"),
    foot: document.getElementById("migration-foot"),
    closeBtn: document.getElementById("migration-close"),
  };
  if (!bridge?.listMigrations || !ui.dialog || !ui.body) {
    return;
  }

  const STEPS = [
    { label: "Where", hint: "Both sides" },
    { label: "Check", hint: "Size and space" },
    { label: "Plan", hint: "When it runs" },
  ];
  const SPEED_OPTIONS_MBIT = [10, 25, 50, 100, 250, 500, 1000];
  const GIB = 1024 ** 3;
  const STATUS_LABELS = {
    copying: "Copying",
    copied: "Copied",
    verifying: "Checking",
    "needs-attention": "Needs a look",
    verified: "Verified",
    cleaning: "Deleting originals",
    done: "Done",
  };
  const STATUS_TONES = {
    verified: "success",
    done: "success",
    "needs-attention": "warning",
    cleaning: "danger",
  };
  const OUTCOME_TEXT = {
    "paused-limit": "Paused: the daily upload limit was reached. It carries on at the next run.",
    "paused-window": "Paused: tonight's time window ended. It carries on at the next run.",
    stopped: "The last run was stopped. It carries on at the next run.",
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    arrowRight: ["M5 12h14", "m13 6 6 6-6 6"],
    back: ["m15 18-6-6 6-6"],
    check: ["M5 12.5 10 17.5 19 7"],
    cloud: ["M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"],
    copy: ["M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z", "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"],
    move: ["M3 12h11", "m10 8 4 4-4 4", "M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"],
    now: ["M13 3 5 13.5h6L10 21l8-10.5h-6Z"],
    night: ["M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"],
    plus: ["M12 5v14", "M5 12h14"],
    clock: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7.5V12l3 2"],
    alert: ["M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z", "M12 7.5v5", "M12 16.3h.01"],
  };

  let hooks = {};
  let migrations = [];
  let remotes = [];
  let view = { name: "list" };
  let draft = null;
  let progress = new Map();
  const liveCopy = new Map();
  let renderQueued = false;
  let armedRemove = null;
  let previousStatuses = new Map();
  let rendered = { key: null, rank: 0, step: -1 };
  let freshChoice = null;
  let fills = new Map();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function icon(name, className = "migration-icon") {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", className);
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("pathLength", "1");
      svg.appendChild(path);
    }
    return svg;
  }

  function button(label, className, onClick, disabled = false, options = {}) {
    const node = el("button", className);
    node.type = "button";
    node.disabled = disabled;
    if (options.icon && !options.trailing) {
      node.append(icon(options.icon));
    }
    node.append(label);
    if (options.icon && options.trailing) {
      node.append(icon(options.icon));
    }
    node.addEventListener("click", onClick);
    return node;
  }

  function cleanError(error, fallback = "Something went wrong.") {
    return String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") || fallback;
  }

  function notify(payload) {
    hooks.onNotify?.(payload);
  }

  function formatBytes(bytes) {
    if (typeof bytes !== "number" || Number.isNaN(bytes) || bytes < 0) {
      return "—";
    }
    const units = ["B", "KB", "MB", "GB", "TB", "PB"];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[unit]}`;
  }

  function formatCount(value) {
    return new Intl.NumberFormat().format(value || 0);
  }

  function formatDuration(seconds) {
    const minutes = Math.max(1, Math.round(seconds / 60));
    if (minutes < 60) {
      return `${minutes} min`;
    }
    const hours = minutes / 60;
    if (hours < 48) {
      return `${Math.round(hours)} h`;
    }
    return `${Math.round(hours / 24)} days`;
  }

  function formatWhen(timestamp) {
    return new Date(timestamp).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }

  function remotePath(remote, folder) {
    const trimmed = String(folder || "").replaceAll("\\", "/").split("/").filter(Boolean).join("/");
    return `${remote}:${trimmed}`;
  }

  function isActive(migration) {
    return migration.status !== "done";
  }

  function isLive(migration) {
    return Boolean(migration.running || migration.task);
  }

  function queueRender() {
    if (renderQueued) {
      return;
    }
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function renderBadge() {
    const active = migrations.filter(isActive).length;
    ui.badge?.classList.toggle("hidden", active === 0);
    ui.badge?.classList.toggle("is-live", migrations.some(isLive));
    if (ui.badge) {
      ui.badge.textContent = String(active);
    }
  }

  function announceChanges() {
    for (const migration of migrations) {
      const before = previousStatuses.get(migration.id);
      if (before && before !== migration.status) {
        if (migration.status === "verified" || (migration.status === "done" && before === "verifying")) {
          notify({ title: "Migration verified", message: `${migration.name}: every file arrived safely.`, type: "success" });
        } else if (migration.status === "needs-attention") {
          notify({ title: "Migration needs a look", message: `${migration.name}: some files are missing or different.`, type: "error" });
        } else if (migration.status === "done" && before === "cleaning") {
          notify({ title: "Migration complete", message: `${migration.name}: originals deleted.`, type: "success" });
        }
      }
    }
    previousStatuses = new Map(migrations.map((migration) => [migration.id, migration.status]));
  }

  async function refresh() {
    try {
      migrations = await bridge.listMigrations();
    } catch {
      migrations = [];
    }
    announceChanges();
    renderBadge();
    if (!ui.dialog.classList.contains("hidden")) {
      render();
    }
  }

  function freshDraft() {
    return {
      step: 0,
      sourceRemote: "",
      sourceFolder: "",
      destRemote: "",
      destFolder: "",
      mode: "copy",
      scan: null,
      scanning: false,
      scanError: "",
      nightly: false,
      startTime: "01:00",
      windowHours: 6,
      speedMbit: 50,
      name: "",
      creating: false,
      error: "",
    };
  }

  function stepper(step, previousStep) {
    const list = el("ol", "migration-steps");
    list.setAttribute("aria-label", "Steps");
    STEPS.forEach(({ label, hint }, index) => {
      const item = el("li", "migration-step");
      if (index === step) {
        item.classList.add("is-active");
        item.setAttribute("aria-current", "step");
      } else if (index < step) {
        item.classList.add("is-done");
      }
      if ((index < step && index >= previousStep) || (index === step && step !== previousStep)) {
        item.classList.add("is-fresh");
      }
      const marker = el("span", "migration-step-marker");
      marker.append(el("span", "migration-step-number", String(index + 1)), icon("check", "migration-step-check"));
      const text = el("span", "migration-step-text");
      text.append(el("span", "migration-step-label", label), el("span", "migration-step-hint", hint));
      item.append(marker, text);
      list.appendChild(item);
    });
    return list;
  }

  function navRow(...buttons) {
    const row = el("div", "migration-nav");
    row.append(...buttons.filter(Boolean));
    return row;
  }

  function errorLine(message) {
    return el("p", `migration-error${message ? "" : " hidden"}`, message || "");
  }

  function splitPath(path) {
    const text = String(path || "");
    const index = text.indexOf(":");
    if (index < 0) {
      return { remote: text, folder: "" };
    }
    return { remote: text.slice(0, index), folder: text.slice(index + 1) };
  }

  function endpoint(path) {
    const { remote, folder } = splitPath(path);
    const chip = el("span", "migration-endpoint");
    chip.title = path;
    chip.append(
      icon("cloud"),
      el("span", "migration-endpoint-remote", remote),
      el("span", "migration-endpoint-path", folder ? `/${folder.replace(/^\/+/, "")}` : "/"),
    );
    return chip;
  }

  function routeLine(source, destination, flowing = false) {
    const row = el("div", `migration-route${flowing ? " is-flowing" : ""}`);
    const arrow = el("span", "migration-arrow");
    arrow.append(icon("arrowRight"));
    row.append(endpoint(source), arrow, endpoint(destination));
    return row;
  }

  function remoteSelect(value, focusKey, onChange) {
    const select = el("select");
    select.dataset.focus = focusKey;
    select.append(new Option("Pick a remote…", ""));
    for (const remote of remotes) {
      select.append(new Option(remote.type ? `${remote.name} (${remote.type})` : remote.name, remote.name));
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function locationGroup(title, remoteKey, folderKey) {
    const group = el("fieldset", `migration-location${draft[remoteKey] ? " is-filled" : ""}`);
    const legend = el("legend");
    legend.append(icon("cloud"), title);
    group.appendChild(legend);
    const remoteField = el("label", "field");
    remoteField.append(el("span", null, "Remote"), remoteSelect(draft[remoteKey], remoteKey, (value) => {
      draft[remoteKey] = value;
      draft.scan = null;
      render();
    }));
    const folderField = el("label", "field");
    const folder = el("input", "migration-folder-input");
    folder.type = "text";
    folder.placeholder = "Leave empty for everything";
    folder.value = draft[folderKey];
    folder.spellcheck = false;
    folder.dataset.focus = folderKey;
    folder.addEventListener("input", () => {
      draft[folderKey] = folder.value;
      draft.scan = null;
    });
    folderField.append(el("span", null, "Folder"), folder);
    group.append(remoteField, folderField);
    return group;
  }

  function choiceCard({ group, focusKey, checked, title, text, iconName, onSelect }) {
    const fresh = freshChoice === focusKey;
    const label = el("label", `migration-choice${checked ? " is-selected" : ""}${fresh ? " is-fresh" : ""}`);
    const input = el("input");
    input.type = "radio";
    input.name = group;
    input.checked = checked;
    input.dataset.focus = focusKey;
    input.addEventListener("change", () => onSelect(label));
    const glyph = el("span", "migration-choice-icon");
    glyph.append(icon(iconName));
    const copy = el("span", "migration-choice-text");
    copy.append(el("strong", null, title), el("span", null, text));
    label.append(input, glyph, copy, el("span", "migration-choice-mark"));
    return label;
  }

  function modeChoice(value, title, text, iconName) {
    return choiceCard({
      group: "migration-mode",
      focusKey: `mode-${value}`,
      checked: draft.mode === value,
      title,
      text,
      iconName,
      onSelect: (label) => {
        draft.mode = value;
        for (const sibling of label.parentElement.children) {
          sibling.classList.toggle("is-selected", sibling === label);
        }
      },
    });
  }

  function whereStep() {
    const ready = draft.sourceRemote && draft.destRemote;
    const locations = el("div", `migration-locations${ready ? " is-ready" : ""}`);
    const arrow = el("span", "migration-arrow");
    arrow.append(icon("arrowRight"));
    locations.append(
      locationGroup("From", "sourceRemote", "sourceFolder"),
      arrow,
      locationGroup("To", "destRemote", "destFolder"),
    );
    const choices = el("div", "migration-choices");
    choices.append(
      modeChoice("copy", "Copy", "Keep the originals where they are.", "copy"),
      modeChoice("move", "Move", "Delete the originals, but only after every file is verified on the new side.", "move"),
    );
    return [
      el("p", "migration-intro", "Move everything from one cloud to another. Glasswing copies it in the background, picks up where it left off if anything stops it, and checks every file at the end."),
      locations,
      choices,
      errorLine(draft.error),
      navRow(
        button("Back", "secondary", () => openList(), false, { icon: "back" }),
        button("Check it", "primary", () => startScan(), !ready, { icon: "arrowRight", trailing: true }),
      ),
    ];
  }

  function summaryList(rows) {
    const summary = el("dl", "migration-summary");
    for (const [label, value] of rows) {
      const row = el("div", "migration-summary-row");
      row.append(el("dt", null, label), el("dd", null, value));
      summary.appendChild(row);
    }
    return summary;
  }

  function note(tone, content) {
    const box = el("div", `migration-note${tone ? ` is-${tone}` : ""}`);
    box.append(...[content].flat());
    return box;
  }

  function tipNode(tip) {
    const tone = { good: "good", warn: "warn", bad: "bad" }[tip.level] || "";
    return note(tone, tip.text);
  }

  async function startScan() {
    draft.error = "";
    draft.step = 1;
    draft.scanning = true;
    draft.scanError = "";
    draft.scan = null;
    render();
    try {
      const result = await bridge.scanMigration({
        source: remotePath(draft.sourceRemote, draft.sourceFolder),
        destination: remotePath(draft.destRemote, draft.destFolder),
      });
      if (result?.cancelled) {
        draft.step = 0;
      } else {
        draft.scan = result;
        if (result.bytesPerSecond) {
          draft.speedMbit = null;
        }
        draft.name = draft.name || `${draft.sourceRemote} → ${draft.destRemote}`;
      }
    } catch (error) {
      draft.scanError = cleanError(error, "Couldn't check the folders.");
    } finally {
      draft.scanning = false;
      render();
    }
  }

  function skeletonStats() {
    const stats = el("div", "migration-stats is-skeleton");
    for (let index = 0; index < 3; index += 1) {
      const stat = el("div", "migration-stat");
      stat.append(el("span", "migration-skeleton is-value"), el("span", "migration-skeleton is-label"));
      stats.appendChild(stat);
    }
    return stats;
  }

  function scanFailure(message) {
    const failed = el("div", "migration-failed");
    const glyph = el("span", "migration-failed-icon");
    glyph.append(icon("alert"));
    failed.append(
      glyph,
      el("h3", "migration-failed-title", "The check didn't finish"),
      el("p", "migration-failed-message", message),
      el("p", "migration-intro", "Make sure both remotes still work in Browse, then try again."),
    );
    return failed;
  }

  function capacityMeter(scan) {
    if (typeof scan.free !== "number" || typeof scan.bytes !== "number" || scan.free <= 0) {
      return null;
    }
    const fraction = scan.bytes / scan.free;
    let tone = "";
    if (fraction > 1) {
      tone = "danger";
    } else if (fraction > 0.85) {
      tone = "warning";
    }
    const meter = el("div", `migration-capacity${tone ? ` is-${tone}` : ""}`);
    const head = el("div", "migration-capacity-head");
    const value = fraction > 1
      ? `${formatBytes(scan.bytes - scan.free)} more than is free`
      : `Uses ${Math.max(1, Math.round(fraction * 100))}% of the free space`;
    head.append(el("span", null, "Space on the destination"), el("strong", null, value));
    meter.append(head, progressBar(Math.min(1, fraction), { key: "capacity", tone }));
    return meter;
  }

  function checkStep() {
    const source = remotePath(draft.sourceRemote, draft.sourceFolder);
    const destination = remotePath(draft.destRemote, draft.destFolder);
    if (draft.scanning) {
      const wrap = el("div", "migration-scanning");
      const status = el("div", "migration-scanning-status");
      status.append(
        el("span", "migration-spinner", null),
        el("p", "migration-intro", "Counting files and checking free space. On a big drive this can take a few minutes."),
      );
      wrap.append(routeLine(source, destination, true), status, skeletonStats());
      return [wrap, navRow(button("Cancel", "secondary", () => void bridge.cancelMigrationTask()))];
    }
    if (draft.scanError) {
      return [
        routeLine(source, destination),
        scanFailure(draft.scanError),
        navRow(
          button("Back", "secondary", () => goStep(0), false, { icon: "back" }),
          button("Try again", "primary", () => startScan()),
        ),
      ];
    }
    const scan = draft.scan;
    const fits = !(typeof scan.free === "number" && scan.bytes > scan.free);
    const stats = el("div", "migration-stats");
    for (const [value, label, tone] of [
      [formatCount(scan.files), scan.files === 1 ? "file" : "files", ""],
      [formatBytes(scan.bytes), "to copy", ""],
      [typeof scan.free === "number" ? formatBytes(scan.free) : "Unknown", "free on the destination", fits ? "" : "danger"],
    ]) {
      const stat = el("div", `migration-stat${tone ? ` is-${tone}` : ""}`);
      stat.append(el("strong", "migration-stat-value", value), el("span", "migration-stat-label", label));
      stats.appendChild(stat);
    }
    const tips = el("div", "migration-tips");
    tips.append(...scan.tips.map(tipNode));
    if (scan.files === 0) {
      tips.append(note("warn", "There's nothing to copy in that folder."));
    }
    return [
      routeLine(scan.source || source, scan.destination || destination),
      stats,
      capacityMeter(scan),
      tips,
      navRow(
        button("Back", "secondary", () => goStep(0), false, { icon: "back" }),
        button(fits ? "Next" : "Continue anyway", "primary", () => goStep(2), scan.files === 0, { icon: "arrowRight", trailing: true }),
      ),
    ].filter(Boolean);
  }

  function chosenSpeed() {
    if (draft.speedMbit) {
      return (draft.speedMbit * 1e6) / 8;
    }
    return draft.scan?.bytesPerSecond || null;
  }

  function estimateText() {
    const scan = draft.scan;
    if (scan.sameRemote) {
      return "It copies on the server, so it's usually quick. How quick depends on the provider.";
    }
    const speed = chosenSpeed();
    if (!speed) {
      return "";
    }
    const seconds = scan.bytes / speed;
    const perRun = Math.min(scan.dailyCapBytes || Number.POSITIVE_INFINITY, speed * (draft.nightly ? draft.windowHours * 3600 : 86400));
    const runs = Math.max(1, Math.ceil(scan.bytes / perRun));
    let text = `About ${formatDuration(seconds)} of copying at ${formatBytes(speed)}/s.`;
    if (runs > 1) {
      text += draft.nightly ? ` That's roughly ${runs} nights.` : ` That's roughly ${runs} days, it carries on by itself each day.`;
    } else if (draft.nightly) {
      text += " It should fit in one night.";
    }
    if (scan.dailyCapBytes && scan.bytes > scan.dailyCapBytes) {
      text += ` The destination's ${Math.round(scan.dailyCapBytes / GIB)} GB/day upload limit is counted in.`;
    }
    return text;
  }

  function speedField() {
    const field = el("label", "field migration-speed");
    const select = el("select");
    select.dataset.focus = "speed";
    if (draft.scan.bytesPerSecond) {
      select.append(new Option(`From your recent jobs (${formatBytes(draft.scan.bytesPerSecond)}/s)`, ""));
    }
    for (const mbit of SPEED_OPTIONS_MBIT) {
      select.append(new Option(`${mbit} Mbit/s upload`, String(mbit)));
    }
    select.value = draft.speedMbit ? String(draft.speedMbit) : "";
    select.addEventListener("change", () => {
      draft.speedMbit = select.value ? Number(select.value) : null;
      render();
    });
    field.append(el("span", null, "Speed for the estimate"), select);
    return field;
  }

  function whenChoice(nightly, title, text, iconName) {
    const focusKey = nightly ? "when-night" : "when-now";
    return choiceCard({
      group: "migration-when",
      focusKey,
      checked: draft.nightly === nightly,
      title,
      text,
      iconName,
      onSelect: () => {
        draft.nightly = nightly;
        freshChoice = focusKey;
        render();
      },
    });
  }

  function nightFields() {
    const row = el("div", `migration-night${freshChoice === "when-night" ? " is-fresh" : ""}`);
    const timeField = el("label", "field");
    const time = el("input");
    time.type = "time";
    time.value = draft.startTime;
    time.dataset.focus = "start-time";
    time.addEventListener("change", () => {
      draft.startTime = time.value || "01:00";
      render();
    });
    timeField.append(el("span", null, "Start at"), time);
    const hoursField = el("label", "field");
    const hours = el("select");
    hours.dataset.focus = "window-hours";
    for (const value of [2, 3, 4, 5, 6, 7, 8, 10, 12]) {
      hours.append(new Option(`${value} hours`, String(value)));
    }
    hours.value = String(draft.windowHours);
    hours.addEventListener("change", () => {
      draft.windowHours = Number(hours.value);
      render();
    });
    hoursField.append(el("span", null, "Run for"), hours);
    row.append(timeField, hoursField);
    return row;
  }

  function planStep() {
    const nameField = el("label", "field");
    const name = el("input");
    name.type = "text";
    name.maxLength = 80;
    name.value = draft.name;
    name.dataset.focus = "name";
    name.addEventListener("input", () => {
      draft.name = name.value;
    });
    nameField.append(el("span", null, "Name"), name);

    const choices = el("div", "migration-choices");
    choices.append(
      whenChoice(false, "Start now", "Keep going until it's done. If it gets interrupted it continues the next day.", "now"),
      whenChoice(true, "Only at night", "Runs in a time window each night so it doesn't slow down your day.", "night"),
    );

    const parts = [nameField, choices];
    if (draft.nightly) {
      parts.push(nightFields());
    }
    if (!draft.scan.sameRemote) {
      parts.push(speedField());
    }
    const estimate = estimateText();
    if (estimate) {
      const estimateNote = note("", estimate);
      estimateNote.classList.add("migration-estimate");
      estimateNote.prepend(icon("clock"));
      parts.push(estimateNote);
    }
    let startLabel = draft.nightly ? "Schedule it" : "Start migration";
    if (draft.creating) {
      startLabel = "Starting…";
    }
    const recap = el("div", "migration-recap");
    recap.append(
      routeLine(draft.scan.source, draft.scan.destination),
      summaryList([
        ["Mode", draft.mode === "move" ? "Move" : "Copy"],
        ["Then", draft.mode === "move" ? "Check every file, then you can delete the originals" : "Check every file"],
      ]),
    );
    parts.push(
      recap,
      errorLine(draft.error),
      navRow(
        button("Back", "secondary", () => goStep(1), false, { icon: "back" }),
        button(startLabel, `primary${draft.creating ? " is-busy" : ""}`, () => void create(), draft.creating),
      ),
    );
    return parts;
  }

  async function create() {
    draft.creating = true;
    draft.error = "";
    render();
    try {
      const migration = await bridge.createMigration({
        source: draft.scan.source,
        destination: draft.scan.destination,
        mode: draft.mode,
        name: draft.name,
        nightly: draft.nightly,
        startTime: draft.startTime,
        windowHours: draft.windowHours,
        scan: { files: draft.scan.files, bytes: draft.scan.bytes, free: draft.scan.free },
      });
      notify({
        title: draft.nightly ? "Migration scheduled" : "Migration started",
        message: draft.nightly ? `${migration.name} starts at ${draft.startTime}.` : migration.name,
        type: "success",
      });
      draft = null;
      await refresh();
      openDetail(migration.id);
    } catch (error) {
      draft.creating = false;
      draft.error = cleanError(error, "Couldn't start the migration.");
      render();
    }
  }

  function goStep(step) {
    draft.step = step;
    draft.error = "";
    render();
  }

  function statusChip(migration) {
    const chip = el("span", `migration-chip is-${migration.status}${isLive(migration) ? " is-live" : ""}`);
    chip.append(el("span", "migration-chip-dot"), STATUS_LABELS[migration.status] || migration.status);
    return chip;
  }

  function liveRun(migration) {
    return migration.running ? liveCopy.get(migration.id) || null : null;
  }

  function copiedBytesNow(migration) {
    return (migration.copiedBytes || 0) + (liveRun(migration)?.runBytes || 0);
  }

  function copiedFraction(migration) {
    if (["copied", "verifying", "verified", "cleaning", "done"].includes(migration.status)) {
      return 1;
    }
    const total = migration.scan?.bytes;
    return total ? Math.min(0.99, copiedBytesNow(migration) / total) : 0;
  }

  function progressBar(fraction, options = {}) {
    const track = el("div", "migration-progress");
    if (options.tone) {
      track.classList.add(`is-${options.tone}`);
    }
    if (options.live) {
      track.classList.add("is-live");
    }
    const target = Math.round(fraction * 1000) / 10;
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(target)));
    const fill = el("div", "migration-progress-fill");
    fill.style.width = `${target}%`;
    if (options.key) {
      const start = fills.get(options.key) ?? 0;
      if (start !== target) {
        fill.style.setProperty("--from", `${start}%`);
        fill.classList.add("is-growing");
      }
      fills.set(options.key, target);
    }
    track.appendChild(fill);
    return track;
  }

  function percentLabel(fraction, key) {
    const target = Math.round(fraction * 100);
    const label = el("span", "migration-percent", `${target}%`);
    const start = fills.get(`pct:${key}`) ?? 0;
    if (start !== target) {
      label.style.setProperty("--pct-from", String(start));
      label.style.setProperty("--pct-to", String(target));
      label.classList.add("is-ticking");
    }
    fills.set(`pct:${key}`, target);
    return label;
  }

  function migrationProgress(migration, key) {
    return progressBar(copiedFraction(migration), {
      key,
      tone: STATUS_TONES[migration.status],
      live: isLive(migration),
    });
  }

  function taskLine(migration) {
    const current = progress.get(migration.id);
    const counted = current?.total ? ` ${formatCount(current.done)} of ${formatCount(current.total)}` : "";
    const labels = { verify: "Checking files…", cleanup: "Checking again before deleting…", delete: "Deleting originals…" };
    return `${labels[current?.kind || migration.task] || "Working…"}${counted}`;
  }

  function copyingLine(migration) {
    if (migration.running) {
      const speed = liveRun(migration)?.speed;
      const pace = speed ? " at " + speed : "";
      return `Copying now${pace}. You can follow it on the Jobs dashboard.`;
    }
    if (migration.queued) {
      return "Waiting for the current job to finish.";
    }
    let outcome = OUTCOME_TEXT[migration.lastOutcome] || "";
    if (migration.lastOutcome === "failed") {
      outcome = `The last run failed: ${migration.lastError || "rclone exited with an error."} It tries again at the next run.`;
    }
    const next = migration.nextRunAt ? `Next run ${formatWhen(migration.nextRunAt)}.` : "";
    return [outcome, next].filter(Boolean).join(" ") || "Waiting to start.";
  }

  function verifiedBy(migration) {
    return migration.verify?.method === "size" ? "by size" : "by checksum";
  }

  function statusLine(migration) {
    if (migration.task) {
      return taskLine(migration);
    }
    const matched = formatCount(migration.verify?.matched);
    const lines = {
      copying: () => copyingLine(migration),
      copied: () => "Everything's copied. Next up is checking that it all arrived.",
      verified: () => `All ${matched} files are verified ${verifiedBy(migration)}.`,
      "needs-attention": () => migration.verify?.error || "Some files are missing or different on the new side. See below.",
      done: () => (migration.cleanup
        ? `Done. ${matched} files verified and the originals are deleted.`
        : `Done. ${matched} files verified ${verifiedBy(migration)}.`),
    };
    return lines[migration.status]?.() || "";
  }

  function statusLineClass(migration) {
    const failed = migration.status === "copying" && migration.lastOutcome === "failed" && !migration.running;
    return `migration-status-line${failed ? " is-danger" : ""}`;
  }

  function migrationCard(migration, index) {
    const card = el("button", `migration-card${isLive(migration) ? " is-live" : ""}`);
    card.type = "button";
    card.style.setProperty("--i", String(Math.min(index, 8)));
    card.addEventListener("click", () => openDetail(migration.id));
    const head = el("div", "migration-card-head");
    head.append(el("strong", "migration-card-title", migration.name), statusChip(migration));
    const meta = el("div", "migration-card-meta");
    meta.append(el("span", statusLineClass(migration), statusLine(migration)), percentLabel(copiedFraction(migration), `card:${migration.id}`));
    card.append(
      head,
      routeLine(migration.source, migration.destination, Boolean(migration.running)),
      migrationProgress(migration, `card:${migration.id}`),
      meta,
    );
    return card;
  }

  function emptyState() {
    const empty = el("div", "migration-empty");
    const art = el("div", "migration-empty-art");
    const from = el("span", "migration-empty-cloud");
    from.append(icon("cloud"));
    const to = el("span", "migration-empty-cloud is-target");
    to.append(icon("cloud"));
    const arrow = el("span", "migration-arrow");
    arrow.append(icon("arrowRight"));
    art.append(from, arrow, to);
    const features = el("ul", "migration-features");
    for (const text of ["Copies in the background, over days if it has to", "Picks up where it left off after any stop", "Checks every single file at the end"]) {
      const item = el("li");
      item.append(icon("check"), text);
      features.appendChild(item);
    }
    empty.append(
      art,
      el("h3", "migration-empty-title", "Moving to a new cloud?"),
      el("p", "migration-intro", "Pick where your files are now and where they should go. Glasswing handles the rest."),
      features,
    );
    return empty;
  }

  function listView() {
    const active = migrations.filter(isActive);
    const finished = migrations.filter((migration) => !isActive(migration));
    const parts = [];
    if (!migrations.length) {
      parts.push(emptyState());
    }
    let index = 0;
    const cards = (items) => items.map((migration) => migrationCard(migration, index++));
    if (active.length) {
      parts.push(el("h3", "migration-section-title", "In progress"), ...cards(active));
    }
    if (finished.length) {
      parts.push(el("h3", "migration-section-title", "Finished"), ...cards(finished));
    }
    parts.push(navRow(button("New migration", "primary", () => openNew(), remotes.length < 1, { icon: "plus" })));
    return parts;
  }

  function reportList(title, items, total) {
    if (!total) {
      return null;
    }
    const details = el("details", "migration-report");
    const summary = el("summary");
    summary.append(el("span", null, title), el("span", "migration-report-count", formatCount(total)));
    details.appendChild(summary);
    const list = el("ul");
    for (const item of items) {
      list.appendChild(el("li", null, item));
    }
    if (total > items.length) {
      list.appendChild(el("li", "migration-report-more", `…and ${formatCount(total - items.length)} more`));
    }
    details.appendChild(list);
    return details;
  }

  async function act(task, failureTitle) {
    try {
      await task();
    } catch (error) {
      notify({ title: failureTitle, message: cleanError(error), type: "error" });
    } finally {
      await refresh();
    }
  }

  function removeButton(migration) {
    const armed = armedRemove === migration.id;
    return button(armed ? "Click again to remove" : "Remove", `secondary migration-remove${armed ? " danger is-armed" : ""}`, () => {
      if (!armed) {
        armedRemove = migration.id;
        render();
        setTimeout(() => {
          if (armedRemove === migration.id) {
            armedRemove = null;
            render();
          }
        }, 4000);
        return;
      }
      armedRemove = null;
      void act(async () => {
        await bridge.removeMigration(migration.id);
        openList();
      }, "Couldn't remove the migration");
    }, Boolean(migration.running || migration.task));
  }

  function cleanupConfirm(migration) {
    const box = el("div", "migration-note is-bad migration-cleanup");
    const ack = el("input");
    ack.type = "checkbox";
    const label = el("label", "migration-check");
    label.append(ack, el("span", null, `Delete ${formatCount(migration.verify?.matched)} files from ${migration.source}`));
    const go = button("Delete originals", "danger", () => {
      view = { name: "detail", id: migration.id };
      void act(() => bridge.cleanupMigration(migration.id), "Nothing was deleted");
    }, true);
    ack.addEventListener("change", () => {
      go.disabled = !ack.checked;
    });
    const copy = el("p", "migration-cleanup-text");
    copy.append(
      el("strong", null, "This deletes the originals."),
      " Glasswing checks everything one more time first and only deletes files that are identical on the new side. Anything that changed in the meantime stays put.",
    );
    box.append(copy, label, navRow(button("Not now", "secondary", () => openDetail(migration.id)), go));
    return box;
  }

  function detailActions(migration) {
    const busy = Boolean(migration.task);
    const actions = [];
    if (busy) {
      actions.push(button("Cancel", "secondary", () => void bridge.cancelMigrationTask()));
    }
    if (migration.status === "copying" && !migration.running && !migration.queued) {
      actions.push(button("Continue now", "primary", () => void act(() => bridge.runMigrationNow(migration.id), "Couldn't continue")));
    }
    if (migration.status === "copied") {
      actions.push(button("Check now", "primary", () => void act(() => bridge.verifyMigration(migration.id), "Check failed"), busy));
    }
    if (migration.status === "needs-attention") {
      actions.push(
        button("Check again", "secondary", () => void act(() => bridge.verifyMigration(migration.id), "Check failed"), busy),
        button("Copy what's missing", "primary", () => void act(() => bridge.runMigrationNow(migration.id), "Couldn't continue"), busy),
      );
    }
    if (migration.status === "verified") {
      actions.push(button("Delete originals…", "danger", () => {
        view = { name: "detail", id: migration.id, confirmCleanup: true };
        render();
      }, busy));
    }
    actions.unshift(removeButton(migration));
    return actions;
  }

  function detailHero(migration) {
    const hero = el("div", `migration-hero${isLive(migration) ? " is-live" : ""}`);
    const top = el("div", "migration-hero-top");
    const total = migration.scan?.bytes;
    let caption = total == null ? "" : `${formatBytes(total)} in total`;
    if (migration.status === "copying" && total != null) {
      caption = `${formatBytes(copiedBytesNow(migration))} of ${formatBytes(total)} copied`;
    }
    top.append(percentLabel(copiedFraction(migration), `detail:${migration.id}`), el("span", "migration-hero-caption", caption));
    hero.append(top, migrationProgress(migration, `detail:${migration.id}`), el("p", statusLineClass(migration), statusLine(migration)));
    return hero;
  }

  function detailView() {
    const migration = migrations.find((item) => item.id === view.id);
    if (!migration) {
      return listView();
    }
    const head = el("div", "migration-detail-head");
    head.append(el("h3", "migration-detail-title", migration.name), statusChip(migration));

    const rows = [
      ["Mode", migration.mode === "move" ? "Move (originals deleted after checking)" : "Copy (originals stay)"],
      ["Schedule", migration.startTime ? `Nightly at ${migration.startTime} for ${migration.windowHours} h` : "Runs until done, retries daily"],
      ["Size", migration.scan?.bytes == null ? "—" : `${formatCount(migration.scan.files)} files · ${formatBytes(migration.scan.bytes)}`],
      ["Copied so far", `${formatBytes(copiedBytesNow(migration))} in ${formatCount(migration.runs || 0)} run${migration.runs === 1 ? "" : "s"}`],
    ];

    const parts = [
      button("All migrations", "migration-back", () => openList(), false, { icon: "back" }),
      head,
      routeLine(migration.source, migration.destination, Boolean(migration.running)),
      detailHero(migration),
    ];
    if (migration.jobMissing) {
      parts.push(note("warn", "The saved job for this migration was removed, so it can't continue. Remove the migration and start a new one."));
    }
    const verify = migration.verify;
    if (verify && !verify.error && migration.status === "needs-attention") {
      parts.push(...[
        reportList("Missing on the new side", verify.samples?.missing || [], verify.missing),
        reportList("Different", verify.samples?.differ || [], verify.differ),
        reportList("Couldn't check", verify.samples?.errors || [], verify.errors),
      ].filter(Boolean));
    }
    parts.push(summaryList(rows));
    if (view.confirmCleanup && migration.status === "verified") {
      parts.push(cleanupConfirm(migration));
    } else {
      parts.push(navRow(...detailActions(migration)));
    }
    return parts;
  }

  function viewState() {
    if (view.name === "new" && draft) {
      let phase = "";
      if (draft.step === 1) {
        phase = draft.scanning ? "scanning" : draft.scanError ? "error" : "result";
      }
      return { key: `new:${draft.step}:${phase}`, rank: 1 + draft.step, step: draft.step };
    }
    if (view.name === "detail" && migrations.some((item) => item.id === view.id)) {
      return { key: `detail:${view.id}`, rank: 4, step: -1 };
    }
    return { key: "list", rank: 0, step: -1 };
  }

  function motionFor(next) {
    if (rendered.key === null) {
      return "open";
    }
    if (rendered.key === next.key) {
      return "";
    }
    if (next.rank > rendered.rank) {
      return "forward";
    }
    if (next.rank < rendered.rank) {
      return "back";
    }
    return "swap";
  }

  function focusedKey() {
    const active = document.activeElement;
    return active && ui.dialog.contains(active) ? active.dataset?.focus || null : null;
  }

  function resolveMotion(next, now) {
    const motion = motionFor(next);
    if (!motion && rendered.motion && now - rendered.motionAt < 600) {
      return { motion: rendered.motion, motionAt: rendered.motionAt };
    }
    return { motion, motionAt: now };
  }

  function viewParts() {
    if (view.name === "new" && draft) {
      return [whereStep, checkStep, planStep][draft.step]();
    }
    if (view.name === "detail") {
      return detailView();
    }
    return listView();
  }

  function render() {
    const next = viewState();
    const now = performance.now();
    const { motion, motionAt } = resolveMotion(next, now);
    const focusKey = focusedKey();
    const parts = viewParts();
    const nav = ui.foot && parts.at(-1)?.classList?.contains("migration-nav") ? parts.pop() : null;
    const pane = el("div", "migration-pane");
    if (motion) {
      pane.dataset.motion = motion;
      pane.style.setProperty("--motion-offset", `${Math.round(motionAt - now)}ms`);
    }
    pane.append(...parts);
    const inWizard = view.name === "new" && draft;
    ui.body.replaceChildren(...(inWizard ? [stepper(draft.step, rendered.step)] : []), pane);
    ui.foot?.replaceChildren(...(nav ? [nav] : []));
    if (motion && motionAt === now) {
      ui.body.scrollTop = 0;
    }
    rendered = { ...next, motion, motionAt };
    freshChoice = null;
    if (focusKey) {
      ui.dialog.querySelector(`[data-focus="${focusKey}"]`)?.focus({ preventScroll: true });
    }
  }

  function openList() {
    view = { name: "list" };
    draft = null;
    render();
  }

  function openNew() {
    view = { name: "new" };
    draft = freshDraft();
    render();
  }

  function openDetail(id) {
    view = { name: "detail", id };
    render();
  }

  async function open() {
    ui.dialog.classList.remove("hidden");
    ui.dialog.setAttribute("aria-hidden", "false");
    view = { name: "list" };
    rendered = { key: null, rank: 0, step: -1 };
    fills = new Map();
    render();
    try {
      remotes = await bridge.listRemoteEntries();
    } catch {
      remotes = [];
    }
    await refresh();
    render();
  }

  function close() {
    if (draft?.scanning) {
      void bridge.cancelMigrationTask();
    }
    ui.dialog.classList.add("hidden");
    ui.dialog.setAttribute("aria-hidden", "true");
  }

  function init(options = {}) {
    hooks = options;
    ui.openBtn?.addEventListener("click", () => void open());
    ui.closeBtn?.addEventListener("click", close);
    ui.dialog.querySelector("[data-migration-close]")?.addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !ui.dialog.classList.contains("hidden")) {
        close();
      }
    });
    bridge.onMigrationsChanged?.(() => void refresh());
    bridge.onMigrationProgress?.((payload) => {
      (payload.kind === "copy" ? liveCopy : progress).set(payload.id, payload);
      if (!ui.dialog.classList.contains("hidden")) {
        queueRender();
      }
    });
    bridge.onJobStarted?.(() => {
      liveCopy.clear();
      void refresh();
    });
    bridge.onJobFinished?.(() => {
      liveCopy.clear();
      setTimeout(() => void refresh(), 500);
    });
    void refresh();
  }

  window.MigrationWizard = { init, open };
})();
