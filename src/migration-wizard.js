(() => {
  const bridge = window.rcloneGui;
  const ui = {
    openBtn: document.getElementById("migration-open"),
    badge: document.getElementById("migration-badge"),
    dialog: document.getElementById("migration-dialog"),
    body: document.getElementById("migration-body"),
    closeBtn: document.getElementById("migration-close"),
  };
  if (!bridge?.listMigrations || !ui.dialog || !ui.body) {
    return;
  }

  const STEPS = ["Where", "Check", "Plan"];
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
  const OUTCOME_TEXT = {
    "paused-limit": "Paused: the daily upload limit was reached. It carries on at the next run.",
    "paused-window": "Paused: tonight's time window ended. It carries on at the next run.",
    stopped: "The last run was stopped. It carries on at the next run.",
  };

  let hooks = {};
  let migrations = [];
  let remotes = [];
  let view = { name: "list" };
  let draft = null;
  let progress = new Map();
  let renderQueued = false;
  let armedRemove = null;
  let previousStatuses = new Map();

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

  function button(label, className, onClick, disabled = false) {
    const node = el("button", className, label);
    node.type = "button";
    node.disabled = disabled;
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

  function stepper(step) {
    const list = el("ol", "vault-steps");
    STEPS.forEach((label, index) => {
      let state = "";
      if (index === step) {
        state = " is-active";
      } else if (index < step) {
        state = " is-done";
      }
      const item = el("li", `vault-step${state}`);
      item.append(el("span", "vault-step-number", index < step ? "✓" : String(index + 1)), el("span", "vault-step-label", label));
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
    return el("p", `remote-create-error${message ? "" : " hidden"}`, message || "");
  }

  function remoteSelect(value, onChange) {
    const select = el("select");
    select.append(new Option("Pick a remote…", ""));
    for (const remote of remotes) {
      select.append(new Option(remote.type ? `${remote.name} (${remote.type})` : remote.name, remote.name));
    }
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return select;
  }

  function locationGroup(title, remoteKey, folderKey) {
    const group = el("fieldset", "migration-location");
    group.appendChild(el("legend", null, title));
    const remoteField = el("label", "field");
    remoteField.append(el("span", null, "Remote"), remoteSelect(draft[remoteKey], (value) => {
      draft[remoteKey] = value;
      draft.scan = null;
      render();
    }));
    const folderField = el("label", "field");
    const folder = el("input");
    folder.type = "text";
    folder.placeholder = "Leave empty for everything";
    folder.value = draft[folderKey];
    folder.spellcheck = false;
    folder.addEventListener("input", () => {
      draft[folderKey] = folder.value;
      draft.scan = null;
    });
    folderField.append(el("span", null, "Folder"), folder);
    group.append(remoteField, folderField);
    return group;
  }

  function modeChoice(value, title, text) {
    const label = el("label", `migration-choice${draft.mode === value ? " is-selected" : ""}`);
    const input = el("input");
    input.type = "radio";
    input.name = "migration-mode";
    input.checked = draft.mode === value;
    input.addEventListener("change", () => {
      draft.mode = value;
      render();
    });
    const copy = el("span", "migration-choice-text");
    copy.append(el("strong", null, title), el("span", null, text));
    label.append(input, copy);
    return label;
  }

  function whereStep() {
    const ready = draft.sourceRemote && draft.destRemote;
    const locations = el("div", "migration-locations");
    locations.append(
      locationGroup("From", "sourceRemote", "sourceFolder"),
      el("span", "migration-arrow", "→"),
      locationGroup("To", "destRemote", "destFolder"),
    );
    const choices = el("div", "migration-choices");
    choices.append(
      modeChoice("copy", "Copy", "Keep the originals where they are."),
      modeChoice("move", "Move", "Delete the originals, but only after every file is verified on the new side."),
    );
    return [
      el("p", "vault-intro", "Move everything from one cloud to another. Glasswing copies it in the background, picks up where it left off if anything stops it, and checks every file at the end."),
      locations,
      choices,
      errorLine(draft.error),
      navRow(
        button("Back", "secondary", () => openList()),
        button("Check it", "primary", () => startScan(), !ready),
      ),
    ];
  }

  function summaryList(rows) {
    const summary = el("dl", "vault-summary");
    for (const [label, value] of rows) {
      const row = el("div", "vault-summary-row");
      row.append(el("dt", null, label), el("dd", null, value));
      summary.appendChild(row);
    }
    return summary;
  }

  function tipNode(tip) {
    const tone = { good: " is-good", warn: " is-warn", bad: " is-bad" }[tip.level] || "";
    return el("div", `vault-note${tone}`, tip.text);
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

  function checkStep() {
    if (draft.scanning) {
      const wrap = el("div", "migration-scanning");
      wrap.append(
        el("span", "browse-loading-spinner", null),
        el("p", "vault-intro", "Counting files and checking free space. On a big drive this can take a few minutes."),
      );
      return [wrap, navRow(button("Cancel", "secondary", () => void bridge.cancelMigrationTask()))];
    }
    if (draft.scanError) {
      return [
        el("div", "vault-note is-bad", draft.scanError),
        navRow(button("Back", "secondary", () => goStep(0)), button("Try again", "primary", () => startScan())),
      ];
    }
    const scan = draft.scan;
    const fits = !(typeof scan.free === "number" && scan.bytes > scan.free);
    const stats = el("div", "migration-stats");
    for (const [value, label] of [
      [formatCount(scan.files), scan.files === 1 ? "file" : "files"],
      [formatBytes(scan.bytes), "to copy"],
      [typeof scan.free === "number" ? formatBytes(scan.free) : "Unknown", "free on the destination"],
    ]) {
      const stat = el("div", "migration-stat");
      stat.append(el("strong", null, value), el("span", null, label));
      stats.appendChild(stat);
    }
    const tips = el("div", "migration-tips");
    tips.append(...scan.tips.map(tipNode));
    if (scan.files === 0) {
      tips.append(el("div", "vault-note is-warn", "There's nothing to copy in that folder."));
    }
    return [
      stats,
      tips,
      navRow(
        button("Back", "secondary", () => goStep(0)),
        button(fits ? "Next" : "Continue anyway", "primary", () => goStep(2), scan.files === 0),
      ),
    ];
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
    const field = el("label", "field");
    const select = el("select");
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

  function whenChoice(nightly, title, text) {
    const label = el("label", `migration-choice${draft.nightly === nightly ? " is-selected" : ""}`);
    const input = el("input");
    input.type = "radio";
    input.name = "migration-when";
    input.checked = draft.nightly === nightly;
    input.addEventListener("change", () => {
      draft.nightly = nightly;
      render();
    });
    const copy = el("span", "migration-choice-text");
    copy.append(el("strong", null, title), el("span", null, text));
    label.append(input, copy);
    return label;
  }

  function nightFields() {
    const row = el("div", "migration-night");
    const timeField = el("label", "field");
    const time = el("input");
    time.type = "time";
    time.value = draft.startTime;
    time.addEventListener("change", () => {
      draft.startTime = time.value || "01:00";
      render();
    });
    timeField.append(el("span", null, "Start at"), time);
    const hoursField = el("label", "field");
    const hours = el("select");
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
    name.addEventListener("input", () => {
      draft.name = name.value;
    });
    nameField.append(el("span", null, "Name"), name);

    const choices = el("div", "migration-choices");
    choices.append(
      whenChoice(false, "Start now", "Keep going until it's done. If it gets interrupted it continues the next day."),
      whenChoice(true, "Only at night", "Runs in a time window each night so it doesn't slow down your day."),
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
      parts.push(el("div", "vault-note migration-estimate", estimate));
    }
    let startLabel = draft.nightly ? "Schedule it" : "Start migration";
    if (draft.creating) {
      startLabel = "Starting…";
    }
    parts.push(
      summaryList([
        ["From", draft.scan.source],
        ["To", draft.scan.destination],
        ["Then", draft.mode === "move" ? "Check every file, then you can delete the originals" : "Check every file"],
      ]),
      errorLine(draft.error),
      navRow(
        button("Back", "secondary", () => goStep(1)),
        button(startLabel, "primary", () => void create(), draft.creating),
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
    return el("span", `migration-chip is-${migration.status}`, STATUS_LABELS[migration.status] || migration.status);
  }

  function copiedFraction(migration) {
    if (["copied", "verifying", "verified", "cleaning", "done"].includes(migration.status)) {
      return 1;
    }
    const total = migration.scan?.bytes;
    return total ? Math.min(0.99, (migration.copiedBytes || 0) / total) : 0;
  }

  function progressBar(fraction) {
    const track = el("div", "migration-progress");
    const fill = el("div", "migration-progress-fill");
    fill.style.width = `${Math.round(fraction * 100)}%`;
    track.appendChild(fill);
    return track;
  }

  function taskLine(migration) {
    const current = progress.get(migration.id);
    const counted = current?.total ? ` ${formatCount(current.done)} of ${formatCount(current.total)}` : "";
    const labels = { verify: "Checking files…", cleanup: "Checking again before deleting…", delete: "Deleting originals…" };
    return `${labels[current?.kind || migration.task] || "Working…"}${counted}`;
  }

  function copyingLine(migration) {
    if (migration.running) {
      return "Copying now. You can follow it on the Jobs dashboard.";
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

  function migrationCard(migration) {
    const card = el("button", "migration-card");
    card.type = "button";
    card.addEventListener("click", () => openDetail(migration.id));
    const head = el("div", "migration-card-head");
    head.append(el("strong", null, migration.name), statusChip(migration));
    card.append(
      head,
      el("span", "migration-paths", `${migration.source} → ${migration.destination}`),
      progressBar(copiedFraction(migration)),
      el("span", "migration-status-line", statusLine(migration)),
    );
    return card;
  }

  function listView() {
    const active = migrations.filter(isActive);
    const finished = migrations.filter((migration) => !isActive(migration));
    const parts = [];
    if (!migrations.length) {
      const empty = el("div", "migration-empty");
      empty.append(
        el("span", "migration-empty-icon", "☁→☁"),
        el("p", "vault-intro", "Moving to a new cloud? Pick where your files are now and where they should go. Glasswing does the copying in the background over as many days as it needs, then checks every single file."),
      );
      parts.push(empty);
    }
    if (active.length) {
      parts.push(el("h3", "migration-section-title", "In progress"), ...active.map(migrationCard));
    }
    if (finished.length) {
      parts.push(el("h3", "migration-section-title", "Finished"), ...finished.map(migrationCard));
    }
    parts.push(navRow(button("New migration", "primary", () => openNew(), remotes.length < 1)));
    return parts;
  }

  function reportList(title, items, total) {
    if (!total) {
      return null;
    }
    const details = el("details", "migration-report");
    details.appendChild(el("summary", null, `${title} (${formatCount(total)})`));
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
    return button(armed ? "Click again to remove" : "Remove", `secondary${armed ? " danger" : ""}`, () => {
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
    const box = el("div", "vault-note is-bad migration-cleanup");
    const ack = el("input");
    ack.type = "checkbox";
    const label = el("label", "vault-check");
    label.append(ack, document.createTextNode(` Delete ${formatCount(migration.verify?.matched)} files from ${migration.source}`));
    const go = button("Delete originals", "danger", () => {
      view = { name: "detail", id: migration.id };
      void act(() => bridge.cleanupMigration(migration.id), "Nothing was deleted");
    }, true);
    ack.addEventListener("change", () => {
      go.disabled = !ack.checked;
    });
    box.append(
      el("strong", null, "This deletes the originals."),
      document.createTextNode(" Glasswing checks everything one more time first and only deletes files that are identical on the new side. Anything that changed in the meantime stays put."),
      label,
      navRow(button("Not now", "secondary", () => openDetail(migration.id)), go),
    );
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

  function detailView() {
    const migration = migrations.find((item) => item.id === view.id);
    if (!migration) {
      return listView();
    }
    const head = el("div", "migration-detail-head");
    head.append(el("h3", "migration-detail-title", migration.name), statusChip(migration));

    const rows = [
      ["From", migration.source],
      ["To", migration.destination],
      ["Mode", migration.mode === "move" ? "Move (originals deleted after checking)" : "Copy (originals stay)"],
      ["Schedule", migration.startTime ? `Nightly at ${migration.startTime} for ${migration.windowHours} h` : "Runs until done, retries daily"],
      ["Size", migration.scan?.bytes == null ? "—" : `${formatCount(migration.scan.files)} files · ${formatBytes(migration.scan.bytes)}`],
      ["Copied so far", `${formatBytes(migration.copiedBytes || 0)} in ${formatCount(migration.runs || 0)} run${migration.runs === 1 ? "" : "s"}`],
    ];

    const parts = [
      button("← All migrations", "secondary migration-back", () => openList()),
      head,
      progressBar(copiedFraction(migration)),
      el("p", "migration-status-line", statusLine(migration)),
      summaryList(rows),
    ];
    if (migration.jobMissing) {
      parts.push(el("div", "vault-note is-warn", "The saved job for this migration was removed, so it can't continue. Remove the migration and start a new one."));
    }
    const verify = migration.verify;
    if (verify && !verify.error && migration.status === "needs-attention") {
      parts.push(...[
        reportList("Missing on the new side", verify.samples?.missing || [], verify.missing),
        reportList("Different", verify.samples?.differ || [], verify.differ),
        reportList("Couldn't check", verify.samples?.errors || [], verify.errors),
      ].filter(Boolean));
    }
    if (view.confirmCleanup && migration.status === "verified") {
      parts.push(cleanupConfirm(migration));
    } else {
      parts.push(navRow(...detailActions(migration)));
    }
    return parts;
  }

  function render() {
    let parts;
    if (view.name === "new" && draft) {
      const steps = [whereStep, checkStep, planStep];
      parts = [stepper(draft.step), ...steps[draft.step]()];
    } else if (view.name === "detail") {
      parts = detailView();
    } else {
      parts = listView();
    }
    ui.body.replaceChildren(...parts);
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
      progress.set(payload.id, payload);
      if (!ui.dialog.classList.contains("hidden")) {
        queueRender();
      }
    });
    bridge.onJobStarted?.(() => void refresh());
    bridge.onJobFinished?.(() => setTimeout(() => void refresh(), 500));
    void refresh();
  }

  window.MigrationWizard = { init, open };
})();
