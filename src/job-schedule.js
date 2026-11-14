(() => {
const DESTRUCTIVE_VERBS = new Set(["sync", "move", "bisync"]);
const COPIED_RESET_MS = 1800;

function splitCommand(command) {
  const parts = [];
  let index = 0;
  while (index < command.length) {
    const start = index;
    const isSpace = /\s/.test(command[index]);
    let quote = "";
    while (index < command.length) {
      const char = command[index];
      if (isSpace) {
        if (!/\s/.test(char)) {
          break;
        }
      } else if (quote) {
        if (quote === '"' && char === "\\") {
          index += 1;
        } else if (char === quote) {
          quote = "";
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        break;
      }
      index += 1;
    }
    parts.push({ text: command.slice(start, index), word: !isSpace });
  }
  return parts;
}

function classifyCommand(command) {
  const parts = splitCommand(command);
  let wordIndex = 0;
  let afterSeparator = false;
  let previousWasFlag = false;
  const classified = [];
  for (const part of parts) {
    if (!part.word) {
      classified.push({ text: part.text, kind: "" });
      continue;
    }
    const position = wordIndex;
    wordIndex += 1;
    if (position === 0) {
      classified.push({ text: part.text, kind: "program" });
    } else if (position === 1) {
      classified.push({ text: part.text, kind: "verb" });
    } else if (afterSeparator) {
      classified.push({ text: part.text, kind: "path" });
    } else if (part.text === "--") {
      afterSeparator = true;
      classified.push({ text: part.text, kind: "separator" });
    } else if (/^--?[^-\s]/.test(part.text)) {
      const equals = part.text.indexOf("=");
      if (equals > 0) {
        classified.push({ text: part.text.slice(0, equals + 1), kind: "flag" });
        classified.push({ text: part.text.slice(equals + 1), kind: "value" });
        previousWasFlag = false;
      } else {
        classified.push({ text: part.text, kind: "flag" });
        previousWasFlag = true;
      }
      continue;
    } else {
      classified.push({ text: part.text, kind: previousWasFlag ? "value" : "path" });
    }
    previousWasFlag = false;
  }
  return classified;
}

function render(element, command) {
  const text = String(command ?? "");
  const nodes = classifyCommand(text).map(({ text: piece, kind }) => {
    if (!kind) {
      return document.createTextNode(piece);
    }
    const span = document.createElement("span");
    span.className = `cmd-${kind}`;
    span.textContent = piece;
    return span;
  });
  element.replaceChildren(...nodes);
}

function risk(command) {
  const words = splitCommand(String(command ?? "")).filter((part) => part.word).map((part) => part.text);
  if (words.includes("--dry-run")) {
    return "dry";
  }
  return DESTRUCTIVE_VERBS.has(words[1]) ? "destructive" : "safe";
}

function watchRunConfirm() {
  const block = document.getElementById("run-confirm-command");
  const card = block?.closest(".popup-card");
  const copyBtn = document.getElementById("run-confirm-copy");
  if (!block || !card || !copyBtn) {
    return;
  }

  new MutationObserver(() => {
    const command = block.textContent;
    if (block.childElementCount > 0 || !command.trim()) {
      return;
    }
    render(block, command);
    card.dataset.risk = risk(command);
  }).observe(block, { childList: true });

  let resetTimer = 0;
  new MutationObserver(() => {
    const label = copyBtn.textContent.trim();
    copyBtn.classList.toggle("is-copied", label === "Copied");
    copyBtn.classList.toggle("is-failed", label === "Copy failed");
    clearTimeout(resetTimer);
    if (label === "Copied") {
      resetTimer = setTimeout(() => {
        if (copyBtn.textContent.trim() === "Copied") {
          copyBtn.textContent = "Copy command";
        }
      }, COPIED_RESET_MS);
    }
  }).observe(copyBtn, { childList: true, characterData: true, subtree: true });
}

watchRunConfirm();
window.CommandPreview = { render, risk };
})();

(() => {
const ui = {
  dialog: document.getElementById("schedule-dialog"),
  jobName: document.getElementById("schedule-job-name"),
  types: [...document.querySelectorAll("#schedule-type input")],
  intervalRow: document.getElementById("schedule-interval-row"),
  hours: document.getElementById("schedule-hours"),
  daysRow: document.getElementById("schedule-days-row"),
  days: [...document.querySelectorAll("#schedule-days-row input")],
  dayPresets: [...document.querySelectorAll("#schedule-days-row [data-schedule-days]")],
  timeRow: document.getElementById("schedule-time-row"),
  time: document.getElementById("schedule-time"),
  catchUpRow: document.getElementById("schedule-catchup-row"),
  catchUp: document.getElementById("schedule-catchup"),
  next: document.getElementById("schedule-next"),
  commandWrap: document.getElementById("schedule-command-wrap"),
  command: document.getElementById("schedule-command"),
  runInBackground: document.getElementById("schedule-run-in-background"),
  openAtLogin: document.getElementById("schedule-open-at-login"),
  loginLabel: document.getElementById("schedule-login-label"),
  loginNote: document.getElementById("schedule-login-note"),
  error: document.getElementById("schedule-error"),
  cancelBtn: document.getElementById("schedule-cancel"),
  saveBtn: document.getElementById("schedule-save"),
};

const WEEKDAYS = [1, 2, 3, 4, 5];
let current = null;
let previewToken = 0;

function cleanError(error) {
  return String(error?.message || error || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

function formatNextRun(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) {
    return `today at ${time}`;
  }
  if (date.toDateString() === tomorrow.toDateString()) {
    return `tomorrow at ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" })} at ${time}`;
}

function selectedType() {
  return ui.types.find((input) => input.checked)?.value || "off";
}

function selectType(type) {
  for (const input of ui.types) {
    input.checked = input.value === type;
  }
}

function selectedDays() {
  return ui.days.filter((input) => input.checked).map((input) => Number(input.value));
}

function readForm() {
  const type = selectedType();
  if (type === "off") {
    return { enabled: false };
  }
  return {
    enabled: true,
    type,
    everyHours: Number(ui.hours.value),
    time: ui.time.value,
    days: selectedDays(),
    catchUp: ui.catchUp.checked,
  };
}

function fillForm(schedule) {
  selectType(schedule?.enabled ? schedule.type : "off");
  ui.hours.value = String(schedule?.everyHours || 6);
  ui.time.value = schedule?.time || "02:00";
  const days = schedule?.days || WEEKDAYS;
  for (const input of ui.days) {
    input.checked = days.includes(Number(input.value));
  }
  ui.catchUp.checked = schedule?.catchUp !== false;
}

function presetDays(button) {
  return button.dataset.scheduleDays.split(",").map(Number);
}

function updateDayPresets() {
  const chosen = selectedDays().sort().join(",");
  for (const button of ui.dayPresets) {
    button.classList.toggle("is-active", presetDays(button).sort().join(",") === chosen);
  }
}

function renderNext(state, title, detail = "") {
  ui.next.dataset.state = state;
  const titleEl = document.createElement("span");
  titleEl.className = "schedule-next-title";
  titleEl.textContent = title;
  const nodes = [titleEl];
  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "schedule-next-detail";
    detailEl.textContent = detail;
    nodes.push(detailEl);
  }
  ui.next.replaceChildren(...nodes);
}

async function updateForm() {
  const type = selectedType();
  const enabled = type !== "off";
  ui.intervalRow.classList.toggle("hidden", type !== "interval");
  ui.daysRow.classList.toggle("hidden", type !== "weekly");
  ui.timeRow.classList.toggle("hidden", type !== "daily" && type !== "weekly");
  ui.catchUpRow.classList.toggle("hidden", !enabled);
  ui.commandWrap.classList.toggle("hidden", !enabled);
  ui.error.classList.add("hidden");
  updateDayPresets();

  if (!enabled) {
    renderNext("off", current?.entry.schedule?.enabled
      ? "Saving turns this schedule off. The job stays in Saved jobs."
      : "This job only runs when you start it.");
    ui.saveBtn.disabled = false;
    return;
  }

  const token = ++previewToken;
  try {
    const preview = await window.rcloneGui.previewJobSchedule(readForm());
    if (token !== previewToken) {
      return;
    }
    renderNext("on", `Next run ${formatNextRun(preview.nextRunAt)}`, preview.description);
    ui.saveBtn.disabled = false;
  } catch (error) {
    if (token !== previewToken) {
      return;
    }
    renderNext("error", cleanError(error));
    ui.saveBtn.disabled = true;
  }
}

async function loadSettings() {
  const settings = await window.rcloneGui.getScheduleSettings();
  ui.runInBackground.checked = settings.runInBackground;
  ui.openAtLogin.checked = settings.openAtLogin;
  ui.openAtLogin.disabled = !settings.canOpenAtLogin;
  ui.loginNote.textContent = settings.canOpenAtLogin ? "(starts in the tray)" : "(only in the installed app)";
  ui.loginLabel.textContent = window.rcloneGui.platform === "win32"
    ? "Start Glasswing with Windows"
    : "Start Glasswing when you log in";
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    close();
  } else if (event.key === "Enter" && event.target.tagName === "INPUT" && event.target.type !== "checkbox") {
    event.preventDefault();
    void save();
  }
}

async function open(entry, { onSaved } = {}) {
  current = { entry, onSaved };
  ui.jobName.textContent = entry.name;
  fillForm(entry.schedule);
  ui.command.textContent = "";
  ui.dialog.classList.remove("hidden");
  ui.dialog.setAttribute("aria-hidden", "false");
  document.addEventListener("keydown", onKeydown, true);
  (ui.types.find((input) => input.checked) || ui.types[0]).focus();

  void updateForm();
  void loadSettings().catch(() => {});
  try {
    const preview = await window.rcloneGui.previewJobCommand(entry);
    window.CommandPreview.render(ui.command, preview.command);
  } catch (error) {
    ui.command.textContent = cleanError(error);
  }
}

function close() {
  ui.dialog.classList.add("hidden");
  ui.dialog.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onKeydown, true);
  current = null;
}

async function save() {
  if (!current || ui.saveBtn.disabled) {
    return;
  }
  const { entry, onSaved } = current;
  ui.saveBtn.disabled = true;
  try {
    await window.rcloneGui.setScheduleSettings({
      runInBackground: ui.runInBackground.checked,
      openAtLogin: ui.openAtLogin.checked,
    });
    const jobs = await window.rcloneGui.setJobSchedule(entry.id, readForm());
    close();
    onSaved?.(jobs.find((job) => job.id === entry.id) || null, jobs);
  } catch (error) {
    ui.error.textContent = cleanError(error);
    ui.error.classList.remove("hidden");
  } finally {
    ui.saveBtn.disabled = false;
  }
}

for (const input of [...ui.types, ui.hours, ui.time, ...ui.days]) {
  input.addEventListener("input", () => void updateForm());
  input.addEventListener("change", () => void updateForm());
}
for (const button of ui.dayPresets) {
  button.addEventListener("click", () => {
    const days = presetDays(button);
    for (const input of ui.days) {
      input.checked = days.includes(Number(input.value));
    }
    void updateForm();
  });
}
ui.cancelBtn.addEventListener("click", close);
ui.dialog.querySelector("[data-schedule-close]").addEventListener("click", close);
ui.saveBtn.addEventListener("click", () => void save());

window.JobSchedule = { open, formatNextRun };
})();
