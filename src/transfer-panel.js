const TRANSFER_TICK_MS = 250;
const TRANSFER_RATE_WINDOW_MS = 10000;
const TRANSFER_SUCCESS_HIDE_MS = 4000;

function transferItemsLabel(count) {
  return `${count} item${count === 1 ? "" : "s"}`;
}

function formatTransferDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) {
    return `${total}s`;
  }
  if (total < 3600) {
    return `${Math.floor(total / 60)}m ${total % 60}s`;
  }
  return `${Math.floor(total / 3600)}h ${Math.floor((total % 3600) / 60)}m`;
}

class TransferPanel {
  constructor(container, { labels, formatBytes, subscribe, runBatch, cancel, onBatchFinished }) {
    this.labels = labels;
    this.formatBytes = formatBytes;
    this.subscribe = subscribe;
    this.runBatch = runBatch;
    this.cancel = cancel;
    this.onBatchFinished = onBatchFinished;
    this.queue = [];
    this.running = false;
    this.cancelling = false;
    this.ticker = null;
    this.hideTimer = null;
    this.resetState();
    this.render(container);
  }

  render(container) {
    this.panel = document.createElement("div");
    this.panel.className = "transfer-panel hidden";
    this.panel.setAttribute("role", "status");
    this.panel.setAttribute("aria-live", "polite");

    const info = document.createElement("div");
    info.className = "transfer-panel-info";
    this.title = document.createElement("span");
    this.title.className = "transfer-panel-title";
    this.file = document.createElement("span");
    this.file.className = "transfer-panel-file";
    info.append(this.title, this.file);

    const track = document.createElement("div");
    track.className = "transfer-progress";
    track.setAttribute("aria-hidden", "true");
    this.bar = document.createElement("div");
    this.bar.className = "transfer-progress-bar";
    track.appendChild(this.bar);

    this.percent = document.createElement("span");
    this.percent.className = "transfer-panel-percent";
    this.meta = document.createElement("span");
    this.meta.className = "transfer-panel-meta";
    this.action = document.createElement("button");
    this.action.type = "button";
    this.action.className = "secondary transfer-panel-action";
    this.action.addEventListener("click", () => this.handleAction());

    this.panel.append(info, track, this.percent, this.meta, this.action);
    container.appendChild(this.panel);
  }

  resetState() {
    Object.assign(this, {
      totalItems: 0,
      totalBytes: 0,
      processedItems: 0,
      processedBytes: 0,
      completed: 0,
      failed: [],
      lastDetail: "",
      batch: null,
      itemIndex: 0,
      itemConfirmed: 0,
      itemUpper: 0,
      itemDisplayed: 0,
      confirmedAt: 0,
      rateSamples: [],
      rate: 0,
      displayedBytes: 0,
      currentFile: "",
    });
  }

  enqueue(batch) {
    const offsets = [];
    let batchBytes = 0;
    for (const item of batch.items) {
      offsets.push(batchBytes);
      batchBytes += item.size || 0;
    }

    if (!this.running) {
      this.resetState();
    }
    this.queue.push({ ...batch, offsets, totalBytes: batchBytes });
    this.totalItems += batch.items.length;
    this.totalBytes += batchBytes;

    if (this.running) {
      this.renderProgress();
    } else {
      void this.run();
    }
  }

  async run() {
    this.running = true;
    this.cancelling = false;

    const unsubscribe = this.subscribe?.((progress) => this.handleProgress(progress));
    this.ticker = setInterval(() => {
      if (this.batch && !this.cancelling) {
        this.advance();
        this.renderProgress();
      }
    }, TRANSFER_TICK_MS);

    let cancelled = false;
    try {
      while (this.queue.length && !this.cancelling) {
        const batch = this.queue.shift();
        this.startBatch(batch);

        try {
          const result = await this.runBatch(batch);
          this.completed += result.completed || 0;
          this.failed.push(...(result.failed || []));
          if (result.detail) {
            this.lastDetail = result.detail;
          }
          if (result.cancelled) {
            cancelled = true;
          }
        } catch (error) {
          this.failed.push(
            ...batch.items.map((item) => ({
              name: item.name,
              error: TransferPanel.cleanError(error) || `${this.labels.noun} failed.`,
            })),
          );
        } finally {
          this.finishBatch(batch, cancelled);
          this.onBatchFinished?.(batch);
        }
      }
    } finally {
      unsubscribe?.();
      clearInterval(this.ticker);
      this.ticker = null;
      cancelled = cancelled || this.cancelling;
      this.queue.length = 0;
      this.running = false;
      this.cancelling = false;
      this.renderResult(cancelled);
      this.resetState();
    }
  }

  startBatch(batch) {
    Object.assign(this, { batch, itemIndex: 0, rateSamples: [], rate: 0 });
    this.resetItem();
    this.renderProgress();
  }

  finishBatch(batch, cancelled) {
    this.processedItems += batch.items.length;
    this.processedBytes += batch.totalBytes;
    if (!cancelled && !this.cancelling) {
      this.displayedBytes = Math.max(this.displayedBytes, this.processedBytes);
    }
  }

  handleAction() {
    if (this.running) {
      this.cancelling = true;
      this.renderProgress();
      void this.cancel?.();
      return;
    }
    this.hide();
  }

  resetItem() {
    Object.assign(this, {
      itemConfirmed: 0,
      itemUpper: 0,
      itemDisplayed: 0,
      confirmedAt: performance.now(),
      currentFile: "",
    });
  }

  handleProgress(progress) {
    const batch = this.batch;
    if (!batch || typeof progress?.index !== "number") {
      return;
    }

    if (progress.index !== this.itemIndex) {
      this.itemIndex = progress.index;
      this.resetItem();
    }

    const item = batch.items[progress.index];
    if (item && !item.size && progress.total > 0) {
      item.size = progress.total;
      batch.totalBytes += progress.total;
      this.totalBytes += progress.total;
    }
    const size = item?.size || 0;
    const cap = (value) => (size > 0 ? Math.min(value, size) : value);

    if (typeof progress.bytes === "number") {
      this.itemUpper = Math.max(this.itemUpper, cap(progress.bytes));
    }
    const confirmed = cap(typeof progress.confirmed === "number" ? progress.confirmed : progress.bytes || 0);
    if (confirmed > this.itemConfirmed) {
      this.itemConfirmed = confirmed;
      this.confirmedAt = performance.now();
    }
    if (typeof progress.current === "string" && progress.current) {
      this.currentFile = progress.current;
    }

    this.recordRate(this.processedBytes + (batch.offsets[progress.index] || 0) + this.itemConfirmed);
    this.advance();
    this.renderProgress();
  }

  recordRate(confirmedTotal) {
    const now = performance.now();
    const samples = this.rateSamples;
    samples.push({ time: now, bytes: confirmedTotal });
    while (samples.length > 2 && now - samples[1].time > TRANSFER_RATE_WINDOW_MS) {
      samples.shift();
    }
    const first = samples[0];
    const elapsed = (now - first.time) / 1000;
    if (elapsed >= 1) {
      this.rate = Math.max(0, (confirmedTotal - first.bytes) / elapsed);
    }
  }

  advance() {
    const batch = this.batch;
    if (!batch) {
      return;
    }
    const item = batch.items[this.itemIndex];
    const size = item?.size || 0;
    const projected = this.itemConfirmed + this.rate * ((performance.now() - this.confirmedAt) / 1000);
    const limit = size > 0 ? Math.min(this.itemUpper, size - 1) : this.itemUpper;
    this.itemDisplayed = Math.max(this.itemDisplayed, this.itemConfirmed, Math.min(projected, limit));

    const overall = this.processedBytes + (batch.offsets[this.itemIndex] || 0) + this.itemDisplayed;
    this.displayedBytes = Math.max(this.displayedBytes, Math.min(overall, this.totalBytes));
  }

  fraction() {
    if (this.totalBytes > 0) {
      return Math.min(1, this.displayedBytes / this.totalBytes);
    }
    return this.totalItems ? this.processedItems / this.totalItems : 0;
  }

  show(variant) {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.panel.classList.remove("hidden", "is-success", "is-error");
    if (variant) {
      this.panel.classList.add(variant);
    }
  }

  hide() {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
    this.panel.classList.add("hidden");
  }

  renderProgress() {
    const item = this.batch?.items[this.itemIndex];
    const done = this.fraction();
    const position = Math.min(this.processedItems + this.itemIndex + 1, this.totalItems);

    this.show();
    this.title.textContent = this.cancelling
      ? "Cancelling…"
      : this.totalItems > 1
        ? `${this.labels.active} ${position} of ${this.totalItems}`
        : this.labels.active;
    this.percent.textContent = `${Math.floor(done * 100)}%`;

    const fileLabel = item
      ? item.isDir && this.currentFile
        ? `${item.name}/${this.currentFile}`
        : item.name
      : "";
    this.file.textContent = fileLabel;
    this.file.title = fileLabel;
    this.bar.style.width = `${done * 100}%`;

    let meta = "Starting…";
    if (this.totalBytes > 0) {
      const amount = `${this.formatBytes(this.displayedBytes)} of ${this.formatBytes(this.totalBytes)}`;
      if (item && item.size > 0 && this.itemUpper >= item.size && this.itemDisplayed >= item.size - 1) {
        meta = `${amount} · Finishing up…`;
      } else if (this.rate > 0) {
        const left = formatTransferDuration((this.totalBytes - this.displayedBytes) / this.rate);
        meta = `${amount} · ${this.formatBytes(this.rate)}/s · ${left} left`;
      } else {
        meta = amount;
      }
    }
    this.meta.textContent = meta;
    this.action.textContent = "Cancel";
    this.action.disabled = this.cancelling;
  }

  renderResult(cancelled) {
    const { noun, past } = this.labels;
    const failedCount = this.failed.length;
    const variant = cancelled || failedCount ? "is-error" : "is-success";

    this.show(variant);
    if (cancelled) {
      this.title.textContent = `${noun} cancelled`;
    } else if (failedCount) {
      this.title.textContent = failedCount === this.totalItems ? `${noun} failed` : `${noun} finished with errors`;
    } else {
      this.title.textContent = `${noun} complete`;
    }
    this.percent.textContent = "";

    const summary = this.completed === 1 && this.lastDetail
      ? this.lastDetail
      : `${transferItemsLabel(this.completed)} ${past}`;
    this.file.textContent = failedCount ? `${this.failed[0].name}: ${this.failed[0].error}` : summary;
    this.file.title = failedCount
      ? this.failed.map((item) => `${item.name}: ${item.error}`).join("\n")
      : summary;
    this.bar.style.width = cancelled || failedCount ? `${this.fraction() * 100}%` : "100%";
    this.meta.textContent = cancelled || failedCount
      ? `${this.completed} of ${this.totalItems} ${past}${failedCount ? ` · ${failedCount} failed` : ""}`
      : this.formatBytes(this.totalBytes);
    this.action.textContent = "Dismiss";
    this.action.disabled = false;

    if (variant === "is-success") {
      this.hideTimer = setTimeout(() => this.hide(), TRANSFER_SUCCESS_HIDE_MS);
    }
  }

  static cleanError(error) {
    return String(error?.message || "").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  }
}

window.TransferPanel = TransferPanel;
