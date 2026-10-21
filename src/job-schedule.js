(() => {
const ui = {
  dialog: document.getElementById("schedule-dialog"),
  jobName: document.getElementById("schedule-job-name"),
  type: document.getElementById("schedule-type"),
  intervalRow: document.getElementById("schedule-interval-row"),
  hours: document.getElementById("schedule-hours"),
  daysRow: document.getElementById("schedule-days-row"),
  days: [...document.querySelectorAll("#schedule-days-row input")],
  timeRow: document.getElementById("schedule-time-row"),
  time: document.getElementById("schedule-time"),
  catchUpRow: document.getElementById("schedule-catchup-row"),
  catchUp: document.getElementById("schedule-catchup"),
  next: document.getElementById("schedule-next"),
  commandWrap: document.getElementById("schedule-command-wrap"),
  command: document.getElementById("schedule-command"),
  runInBackground: document.getElementById("schedule-run-in-background"),
  openAtLogin: document.getElementById("schedule-open-at-login"),
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

function readForm() {
  const type = ui.type.value;
  if (type === "off") {
    return { enabled: false };
  }
  return {
    enabled: true,
    type,
    everyHours: Number(ui.hours.value),
    time: ui.time.value,
    days: ui.days.filter((input) => input.checked).map((input) => Number(input.value)),
    catchUp: ui.catchUp.checked,
  };
}

function fillForm(schedule) {
  ui.type.value = schedule?.enabled ? schedule.type : "off";
  ui.hours.value = String(schedule?.everyHours || 6);
  ui.time.value = schedule?.time || "02:00";
  const days = schedule?.days || WEEKDAYS;
  for (const input of ui.days) {
    input.checked = days.includes(Number(input.value));
  }
  ui.catchUp.checked = schedule?.catchUp !== false;
}

async function updateForm() {
  const type = ui.type.value;
  const enabled = type !== "off";
  ui.intervalRow.classList.toggle("hidden", type !== "interval");
  ui.daysRow.classList.toggle("hidden", type !== "weekly");
  ui.timeRow.classList.toggle("hidden", type !== "daily" && type !== "weekly");
  ui.catchUpRow.classList.toggle("hidden", !enabled);
  ui.commandWrap.classList.toggle("hidden", !enabled);
  ui.error.classList.add("hidden");

  if (!enabled) {
    ui.next.textContent = current?.entry.schedule?.enabled
      ? "Saving turns this schedule off. The job stays in Saved jobs."
      : "This job only runs when you start it.";
    ui.saveBtn.disabled = false;
    return;
  }

  const token = ++previewToken;
  try {
    const preview = await window.rcloneGui.previewJobSchedule(readForm());
    if (token !== previewToken) {
      return;
    }
    ui.next.textContent = `${preview.description}. Next run ${formatNextRun(preview.nextRunAt)}.`;
    ui.saveBtn.disabled = false;
  } catch (error) {
    if (token !== previewToken) {
      return;
    }
    ui.next.textContent = cleanError(error);
    ui.saveBtn.disabled = true;
  }
}

async function loadSettings() {
  const settings = await window.rcloneGui.getScheduleSettings();
  ui.runInBackground.checked = settings.runInBackground;
  ui.openAtLogin.checked = settings.openAtLogin;
  ui.openAtLogin.disabled = !settings.canOpenAtLogin;
  ui.loginNote.textContent = settings.canOpenAtLogin ? "(starts in the tray)" : "(only in the installed app)";
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
  ui.type.focus();

  void updateForm();
  void loadSettings().catch(() => {});
  try {
    const preview = await window.rcloneGui.previewJobCommand(entry);
    ui.command.textContent = preview.command;
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

for (const input of [ui.type, ui.hours, ui.time, ...ui.days]) {
  input.addEventListener("input", () => void updateForm());
  input.addEventListener("change", () => void updateForm());
}
ui.cancelBtn.addEventListener("click", close);
ui.dialog.querySelector("[data-schedule-close]").addEventListener("click", close);
ui.saveBtn.addEventListener("click", () => void save());

window.JobSchedule = { open, formatNextRun };
})();
