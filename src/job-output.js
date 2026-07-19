const MAX_ACTIVITY_ITEMS = 80;

const STATS_ANYWHERE =
  /(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+-\s+(.+?)\s+\/\s+([^,]+),\s*([\d.]+%|-),\s*([^,]+),\s*ETA\s*(\S+(?:\s+\([^)]*\))?)/;

const STATS_TRANSFERRED =
  /Transferred:\s+(.+?)\s+\/\s+([^,]+),\s*([\d.]+%|-),\s*([^,]+),\s*ETA\s*(\S+(?:\s+\([^)]*\))?)/;

const STATS_CHECKS = /^Checks:\s+(\d+)\s*\/\s*(\d+)/;

const FILE_TRANSFER_COUNT = /\(xfr#(\d+)\/(\d+)\)/;

const LOG_LINE =
  /^(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(ERROR|NOTICE|INFO)\s+:\s*(.+)$/;

const SIMPLE_LOG_LINE = /^(ERROR|NOTICE|INFO)\s+:\s*(.+)$/;

function parsePercent(value) {
  if (!value || value === "-") {
    return null;
  }

  const match = value.match(/^([\d.]+)%$/);
  return match ? Number.parseFloat(match[1]) : null;
}

function extractStats(line) {
  const match = line.match(STATS_ANYWHERE);
  if (!match) {
    return null;
  }

  return {
    timestamp: match[1],
    transferred: match[2].trim(),
    total: match[3].trim(),
    percent: match[4],
    speed: match[5].trim(),
    eta: match[6].trim(),
  };
}

function cleanEta(eta) {
  return eta.replace(/\s+\((?:xfr|chk|err)[^)]*\)/gi, "").trim();
}

function truncatePath(value, maxLength = 72) {
  if (value.length <= maxLength) {
    return value;
  }

  return `…${value.slice(-(maxLength - 1))}`;
}

function pulseElement(element) {
  if (!element) {
    return;
  }

  element.classList.remove("is-pop");
  void element.offsetWidth;
  element.classList.add("is-pop");
}

class JobOutputPanel {
  constructor(root) {
    this.root = root;
    this.idle = root.querySelector("#job-idle");
    this.dashboard = root.querySelector("#job-dashboard");
    this.rawLog = root.querySelector("#raw-log");
    this.toggleRawLogButton = root.querySelector("#toggle-raw-log");
    this.jobBadge = root.querySelector("#job-badge");
    this.jobTitle = root.querySelector("#job-title");
    this.jobPaths = root.querySelector("#job-paths");
    this.jobBanner = root.querySelector("#job-banner");
    this.jobMessage = root.querySelector("#job-message");
    this.progressPercent = root.querySelector("#progress-percent");
    this.progressEta = root.querySelector("#progress-eta");
    this.progressFill = root.querySelector("#progress-fill");
    this.progressSection = root.querySelector("#progress-section");
    this.progressTrack = root.querySelector(".progress-track");
    this.progressDetail = root.querySelector("#progress-detail");
    this.statSpeed = root.querySelector("#stat-speed");
    this.statTransferred = root.querySelector("#stat-transferred");
    this.statChecks = root.querySelector("#stat-checks");
    this.statErrors = root.querySelector("#stat-errors");
    this.activityFeed = root.querySelector("#activity-feed");
    this.activityCount = root.querySelector("#activity-count");

    this.lineBuffer = "";
    this.rawText = "";
    this.activityItems = 0;
    this.errorCount = 0;
    this.showRawLog = false;
    this.currentPercent = 0;

    this.toggleRawLogButton.addEventListener("click", () => {
      this.showRawLog = !this.showRawLog;
      this.rawLog.classList.toggle("hidden", !this.showRawLog);
      this.rawLog.setAttribute("aria-hidden", String(!this.showRawLog));
      this.toggleRawLogButton.textContent = this.showRawLog ? "Hide raw log" : "Show raw log";
    });
  }

  clear() {
    this.resetState();
    this.setIdle();
  }

  resetState() {
    this.lineBuffer = "";
    this.rawText = "";
    this.activityItems = 0;
    this.errorCount = 0;
    this.currentPercent = 0;
    this.rawLog.textContent = "";
    this.activityFeed.innerHTML = "";
    this.activityCount.textContent = "0 events";
    this.statSpeed.textContent = "—";
    this.statTransferred.textContent = "—";
    this.statChecks.textContent = "—";
    this.statErrors.textContent = "0";
    this.progressPercent.textContent = "0%";
    this.progressEta.textContent = "ETA —";
    this.progressDetail.textContent = "Waiting for stats…";
    this.setProgress(0);
    this.progressFill.classList.remove("complete");
    this.progressSection?.classList.remove("is-active");
    this.progressTrack.setAttribute("aria-valuenow", "0");
    this.jobMessage.textContent = "";
  }

  setIdle() {
    this.idle.classList.remove("hidden");
    this.dashboard.classList.add("hidden");
    this.jobBanner.className = "job-banner";
    this.jobBadge.className = "job-badge";
    this.jobBadge.textContent = "Ready";
  }

  startJob({ operation, source, destination }) {
    this.resetState();
    this.idle.classList.add("hidden");
    this.dashboard.classList.remove("hidden");
    this.jobBanner.className = "job-banner is-running";
    this.jobBadge.className = "job-badge running";
    this.jobBadge.textContent = "Running";
    this.jobTitle.textContent = `${operation.charAt(0).toUpperCase()}${operation.slice(1)} job`;
    this.jobPaths.textContent = `${truncatePath(source)} → ${truncatePath(destination)}`;
    this.jobMessage.textContent = "Job started. Waiting for rclone stats…";
    this.progressSection?.classList.add("is-active");
    this.dashboard.style.animation = "none";
    void this.dashboard.offsetWidth;
    this.dashboard.style.animation = "";
    this.addActivity("info", "Job started", `${operation} from ${source} to ${destination}`);
  }

  finishJob({ success, message, cancelled }) {
    this.progressSection?.classList.remove("is-active");
    this.jobBanner.classList.remove("is-running");
    this.jobBadge.classList.remove("running");

    if (cancelled) {
      this.jobBanner.classList.add("is-cancelled");
      this.jobBadge.classList.add("cancelled");
      this.jobBadge.textContent = "Cancelled";
    } else if (success) {
      this.jobBanner.classList.add("is-success");
      this.jobBadge.classList.add("success");
      this.jobBadge.textContent = "Completed";
      this.progressFill.classList.add("complete");
    } else {
      this.jobBanner.classList.add("is-error");
      this.jobBadge.classList.add("error");
      this.jobBadge.textContent = "Failed";
    }

    this.jobMessage.textContent = message;
    this.addActivity(cancelled ? "notice" : success ? "success" : "error", message);
  }

  appendOutput(text) {
    this.rawText += text;
    this.rawLog.textContent = this.rawText;

    this.lineBuffer += text;
    const lines = this.lineBuffer.split(/\r\n|\n|\r/);
    this.lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      this.processLine(line.trim());
    }
  }

  flush() {
    const trailing = this.lineBuffer.trim();
    if (trailing) {
      this.processLine(trailing);
    }

    this.lineBuffer = "";
  }

  processLine(line) {
    if (!line) {
      return;
    }

    const inlineStats = extractStats(line);
    if (inlineStats) {
      this.updateTransferStats(inlineStats);
      return;
    }

    const transferredStats = line.match(STATS_TRANSFERRED);
    if (transferredStats) {
      this.updateTransferStats({
        transferred: transferredStats[1].trim(),
        total: transferredStats[2].trim(),
        percent: transferredStats[3],
        speed: transferredStats[4].trim(),
        eta: transferredStats[5].trim(),
      });
      return;
    }

    const checksStats = line.match(STATS_CHECKS);
    if (checksStats) {
      this.statChecks.textContent = `${checksStats[1]} / ${checksStats[2]}`;
      return;
    }

    const structuredLog = line.match(LOG_LINE) || line.match(SIMPLE_LOG_LINE);
    if (structuredLog) {
      const level = (structuredLog[2] || structuredLog[1]).toLowerCase();
      const message = structuredLog[3] || structuredLog[2];

      if (extractStats(message)) {
        this.updateTransferStats(extractStats(message));
        return;
      }

      this.addActivity(level, message);

      if (level === "error") {
        this.errorCount += 1;
        this.statErrors.textContent = String(this.errorCount);
      }
    }
  }

  setProgress(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    this.currentPercent = clamped;
    this.progressTrack.style.setProperty("--progress", `${clamped}%`);
    this.progressTrack.setAttribute("aria-valuenow", String(Math.round(clamped)));
  }

  updateTransferStats({ timestamp, transferred, total, percent, speed, eta }) {
    const numericPercent = parsePercent(percent);
    const percentLabel = numericPercent === null ? "—" : `${Math.round(numericPercent)}%`;
    const etaLabel = cleanEta(eta);
    const fileTransfer = eta.match(FILE_TRANSFER_COUNT);

    if (this.progressPercent.textContent !== percentLabel) {
      this.progressPercent.textContent = percentLabel;
      pulseElement(this.progressPercent);
    }

    this.progressEta.textContent = !etaLabel || etaLabel === "-" ? "ETA —" : `ETA ${etaLabel}`;
    this.progressDetail.textContent = `${transferred} / ${total}`;
    this.statSpeed.textContent = speed;
    this.statTransferred.textContent = transferred;
    this.jobMessage.textContent = timestamp
      ? `Last update ${timestamp.split(" ")[1]}`
      : "Transfer in progress";

    if (fileTransfer) {
      this.statChecks.textContent = `${fileTransfer[1]} / ${fileTransfer[2]}`;
    }

    if (numericPercent !== null) {
      this.setProgress(numericPercent);
    }
  }

  addActivity(level, title, detail = "") {
    const item = document.createElement("article");
    item.className = `activity-item ${level}`;

    const time = document.createElement("time");
    time.textContent = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    const content = document.createElement("div");
    content.className = "activity-content";

    const heading = document.createElement("p");
    heading.className = "activity-title";
    heading.textContent = title;

    content.appendChild(heading);

    if (detail && detail !== title) {
      const body = document.createElement("p");
      body.className = "activity-detail";
      body.textContent = detail;
      content.appendChild(body);
    }

    item.appendChild(time);
    item.appendChild(content);
    this.activityFeed.prepend(item);

    this.activityItems += 1;
    this.activityCount.textContent = `${this.activityItems} event${this.activityItems === 1 ? "" : "s"}`;

    while (this.activityFeed.children.length > MAX_ACTIVITY_ITEMS) {
      this.activityFeed.lastElementChild?.remove();
    }
  }
}

window.JobOutputPanel = JobOutputPanel;
