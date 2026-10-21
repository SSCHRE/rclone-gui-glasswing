const SCHEDULE_TYPES = ["interval", "daily", "weekly"];
const HOUR_MS = 60 * 60 * 1000;
const MAX_INTERVAL_HOURS = 168;
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function normalizeSchedule(input) {
  if (!input?.enabled) {
    return null;
  }

  const type = input.type;
  if (!SCHEDULE_TYPES.includes(type)) {
    throw new Error(`Unknown schedule type "${type}".`);
  }

  const schedule = { enabled: true, type, catchUp: input.catchUp !== false };

  if (type === "interval") {
    const everyHours = Number(input.everyHours);
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > MAX_INTERVAL_HOURS) {
      throw new Error(`Pick a whole number of hours between 1 and ${MAX_INTERVAL_HOURS}.`);
    }
    schedule.everyHours = everyHours;
    return schedule;
  }

  const match = /^(\d{2}):(\d{2})$/.exec(String(input.time || ""));
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error("Pick a valid time of day.");
  }
  schedule.time = input.time;

  if (type === "weekly") {
    const days = [...new Set((input.days || []).map(Number))].filter((day) => ALL_DAYS.includes(day)).sort();
    if (days.length === 0) {
      throw new Error("Pick at least one day.");
    }
    schedule.days = days;
  }

  return schedule;
}

function computeNextRun(schedule, from, anchorAt = null) {
  if (!schedule?.enabled) {
    return null;
  }

  if (schedule.type === "interval") {
    const step = schedule.everyHours * HOUR_MS;
    const anchor = anchorAt ?? from;
    if (anchor > from) {
      return anchor;
    }
    return anchor + (Math.floor((from - anchor) / step) + 1) * step;
  }

  const [hours, minutes] = schedule.time.split(":").map(Number);
  const days = schedule.type === "weekly" ? schedule.days : ALL_DAYS;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + offset);
    candidate.setHours(hours, minutes, 0, 0);
    if (candidate.getTime() > from && days.includes(candidate.getDay())) {
      return candidate.getTime();
    }
  }
  return null;
}

function describeSchedule(schedule) {
  if (!schedule?.enabled) {
    return "";
  }
  if (schedule.type === "interval") {
    return schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
  }
  if (schedule.type === "daily") {
    return `Daily at ${schedule.time}`;
  }
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((day) => schedule.days.includes(day));
  return `${ordered.map((day) => names[day]).join(", ")} at ${schedule.time}`;
}

module.exports = {
  HOUR_MS,
  normalizeSchedule,
  computeNextRun,
  describeSchedule,
};
