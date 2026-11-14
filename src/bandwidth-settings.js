(() => {
const UNIT_LABELS = { K: "KB/s", M: "MB/s", G: "GB/s" };
const RATE_PATTERN = /^(\d+(?:\.\d+)?)([KMG])$/;
const SCHEDULE_PATTERN = /^(\d{2}:\d{2}),(\d+(?:\.\d+)?)([KMG]) (\d{2}:\d{2}),off$/;
const CUSTOM_PRESET = "custom";
const MINUTES_PER_DAY = 24 * 60;

const bw = {
  button: document.getElementById("bwlimit-button"),
  buttonLabel: document.getElementById("bwlimit-button-label"),
  dialog: document.getElementById("bwlimit-dialog"),
  presets: [...document.querySelectorAll("#bwlimit-presets input")],
  rateGroup: document.querySelector("#bwlimit-dialog .bwlimit-rate-group"),
  rate: document.getElementById("bwlimit-rate"),
  unit: document.getElementById("bwlimit-unit"),
  scheduled: document.getElementById("bwlimit-scheduled"),
  hours: document.getElementById("bwlimit-hours"),
  from: document.getElementById("bwlimit-from"),
  to: document.getElementById("bwlimit-to"),
  timeline: document.getElementById("bwlimit-timeline"),
  hint: document.getElementById("bwlimit-hint"),
  note: document.getElementById("bwlimit-note"),
  clearBtn: document.getElementById("bwlimit-clear"),
  cancelBtn: document.getElementById("bwlimit-cancel"),
  saveBtn: document.getElementById("bwlimit-save"),
};

let currentLimit = "";

function parse(value) {
  const text = String(value || "").trim();
  const plain = RATE_PATTERN.exec(text);
  if (plain) {
    return { amount: plain[1], unit: plain[2], from: "", to: "" };
  }
  const scheduled = SCHEDULE_PATTERN.exec(text);
  if (scheduled) {
    return { amount: scheduled[2], unit: scheduled[3], from: scheduled[1], to: scheduled[4] };
  }
  return null;
}

function describe(value) {
  const parsed = parse(value);
  if (!parsed) {
    return value || "Full speed";
  }
  const rate = `${parsed.amount} ${UNIT_LABELS[parsed.unit]}`;
  return parsed.from ? `${rate}, ${parsed.from}–${parsed.to}` : rate;
}

function readForm() {
  const amount = Number(bw.rate.value);
  if (!bw.rate.value.trim() || !Number.isFinite(amount)) {
    return "";
  }
  const rounded = Number(amount.toFixed(3));
  if (rounded <= 0 || rounded >= 1e9) {
    return "";
  }
  const rate = `${rounded}${bw.unit.value}`;
  if (bw.scheduled.checked && bw.from.value && bw.to.value && bw.from.value !== bw.to.value) {
    return `${bw.from.value},${rate} ${bw.to.value},off`;
  }
  return rate;
}

function presetFor(amount, unit) {
  const value = Number(amount);
  if (!amount || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  const rate = `${value}${unit}`;
  return bw.presets.some((input) => input.value === rate) ? rate : CUSTOM_PRESET;
}

function selectedPreset() {
  return bw.presets.find((input) => input.checked)?.value ?? "";
}

function showPreset(value) {
  for (const input of bw.presets) {
    input.checked = input.value === value;
  }
  bw.rateGroup.classList.toggle("hidden", value !== CUSTOM_PRESET);
}

function applyPreset(value) {
  showPreset(value);
  if (value === CUSTOM_PRESET) {
    bw.rate.focus();
    bw.rate.select();
  } else {
    const parsed = RATE_PATTERN.exec(value);
    bw.rate.value = parsed ? parsed[1] : "";
    bw.unit.value = parsed ? parsed[2] : "M";
  }
  updateForm();
}

function fillForm(value) {
  const parsed = parse(value);
  if (parsed?.unit === "G") {
    parsed.amount = String(Number(parsed.amount) * 1024);
    parsed.unit = "M";
  }
  bw.rate.value = parsed?.amount || "";
  bw.unit.value = parsed?.unit || "M";
  bw.scheduled.checked = Boolean(parsed?.from);
  bw.from.value = parsed?.from || "08:00";
  bw.to.value = parsed?.to || "18:00";
  showPreset(presetFor(bw.rate.value, bw.unit.value));
  updateForm();
}

function minutesOf(time) {
  const [hours, minutes] = String(time || "").split(":").map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : 0;
}

function updateTimeline() {
  const from = minutesOf(bw.from.value);
  const to = minutesOf(bw.to.value);
  bw.timeline.style.setProperty("--bw-from", `${(from / MINUTES_PER_DAY) * 100}%`);
  bw.timeline.style.setProperty("--bw-to", `${(to / MINUTES_PER_DAY) * 100}%`);
  bw.timeline.classList.toggle("is-wrapped", from > to);
  bw.timeline.classList.toggle("is-empty", from === to);
}

function setHint(state, text) {
  bw.hint.dataset.state = state;
  bw.hint.textContent = text;
}

function updateForm() {
  const hasRate = Boolean(readForm()) || (bw.scheduled.checked && Number(bw.rate.value) > 0);
  bw.hours.classList.toggle("hidden", !bw.scheduled.checked);
  updateTimeline();
  bw.note.textContent = bw.scheduled.checked
    ? "Applies to transfers or jobs you start after saving. Drives that are already mounted pick up a schedule the next time they're mounted, and running serves the next time they start."
    : "Applies to transfers or jobs you start after saving. Mounted drives update instantly, running serves pick it up the next time they start.";

  if (!hasRate) {
    setHint("off", selectedPreset() === CUSTOM_PRESET
      ? "Enter a speed, or pick Unlimited to run at full speed."
      : "No limit: transfers run at full speed.");
  } else if (bw.scheduled.checked && bw.from.value === bw.to.value) {
    setHint("warn", "Pick two different times, or untick to limit all day.");
  } else if (bw.scheduled.checked) {
    setHint("limited", `Limited from ${bw.from.value} to ${bw.to.value}, full speed the rest of the day.`);
  } else {
    setHint("limited", "Limited all day.");
  }
}

function renderButton() {
  bw.buttonLabel.textContent = describe(currentLimit);
  bw.button.classList.toggle("is-limited", Boolean(currentLimit));
  bw.button.title = currentLimit
    ? `Bandwidth limited to ${describe(currentLimit)} for all transfers. Click to change.`
    : "Bandwidth limit for all transfers";
}

function onKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    close();
  } else if (event.key === "Enter" && event.target.tagName === "INPUT") {
    event.preventDefault();
    void save(readForm());
  }
}

function open() {
  fillForm(currentLimit);
  bw.clearBtn.classList.toggle("hidden", !currentLimit);
  bw.dialog.classList.remove("hidden");
  bw.dialog.setAttribute("aria-hidden", "false");
  document.addEventListener("keydown", onKeydown, true);
  if (selectedPreset() === CUSTOM_PRESET) {
    bw.rate.focus();
    bw.rate.select();
  } else {
    bw.presets.find((input) => input.checked)?.focus();
  }
}

function close() {
  bw.dialog.classList.add("hidden");
  bw.dialog.setAttribute("aria-hidden", "true");
  document.removeEventListener("keydown", onKeydown, true);
}

async function save(value) {
  bw.saveBtn.disabled = true;
  bw.clearBtn.disabled = true;
  try {
    const result = await window.rcloneGui.setBwlimit(value);
    currentLimit = result.bwlimit;
    renderButton();
    close();
  } catch (error) {
    setHint("error", String(error?.message || "Could not save the limit.").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
  } finally {
    bw.saveBtn.disabled = false;
    bw.clearBtn.disabled = false;
  }
}

for (const input of bw.presets) {
  input.addEventListener("change", () => {
    if (input.checked) {
      applyPreset(input.value);
    }
  });
}
for (const input of [bw.rate, bw.unit, bw.scheduled, bw.from, bw.to]) {
  input.addEventListener("input", updateForm);
  input.addEventListener("change", updateForm);
}
bw.button.addEventListener("click", open);
bw.cancelBtn.addEventListener("click", close);
bw.dialog.querySelector("[data-bwlimit-close]").addEventListener("click", close);
bw.saveBtn.addEventListener("click", () => void save(readForm()));
bw.clearBtn.addEventListener("click", () => void save(""));

if (window.rcloneGui?.getBwlimit) {
  window.rcloneGui.getBwlimit().then((value) => {
    currentLimit = value || "";
    renderButton();
  }, () => renderButton());
} else {
  renderButton();
}
})();
