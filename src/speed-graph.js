(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const VIEW_WIDTH = 1000;
  const VIEW_HEIGHT = 100;
  const MAX_POINTS = 720;
  const UNIT_POWERS = { "": 0, k: 1, m: 2, g: 3, t: 4, p: 5 };
  const RATE_UNITS = ["B/s", "KiB/s", "MiB/s", "GiB/s", "TiB/s", "PiB/s"];

  function parseRate(text) {
    const match = String(text || "").trim().match(/^([\d.]+)\s*([kmgtp]?)(i?)(b|bits?|bytes?)?(?:\/s|ps)?$/i);
    if (!match) {
      return null;
    }
    const value = Number.parseFloat(match[1]);
    if (!Number.isFinite(value)) {
      return null;
    }
    const base = match[3] || match[2].toLowerCase() === "k" ? 1024 : 1000;
    const bits = /^bits?$/i.test(match[4] || "") || match[4] === "b";
    const bytes = value * base ** UNIT_POWERS[match[2].toLowerCase()];
    return bits ? bytes / 8 : bytes;
  }

  function formatRate(bytesPerSecond, { compact = false } = {}) {
    let value = Math.max(0, bytesPerSecond || 0);
    let unit = 0;
    while (value >= 1024 && unit < RATE_UNITS.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
    const number = compact ? String(Number(value.toFixed(digits))) : value.toFixed(digits);
    return `${number} ${RATE_UNITS[unit]}`;
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
  }

  function niceCeiling(value) {
    if (value <= 0) {
      return 1024;
    }
    let unit = 1;
    while (value / unit >= 1024) {
      unit *= 1024;
    }
    const scaled = value / unit;
    const magnitude = 10 ** Math.floor(Math.log10(scaled));
    const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((candidate) => candidate * magnitude >= scaled) * magnitude;
    return step * unit;
  }

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

  function svg(tag, className) {
    const node = document.createElementNS(SVG_NS, tag);
    node.setAttribute("class", className);
    return node;
  }

  class SpeedGraph {
    constructor(root) {
      this.root = root;
      this.points = [];
      this.startedAt = 0;
      this.running = false;
      this.renderQueued = false;
      this.peak = 0;
      this.sum = 0;
      this.count = 0;
      this.build();
    }

    build() {
      const head = el("div", "speed-head");
      head.appendChild(el("h3", "speed-title", "Transfer speed"));
      const readouts = el("dl", "speed-readouts");
      this.readouts = {};
      for (const [key, label] of [["now", "Now"], ["average", "Average"], ["peak", "Peak"]]) {
        const item = el("div", `speed-readout speed-readout-${key}`);
        const value = el("dd", "speed-readout-value", "—");
        item.append(el("dt", "speed-readout-label", label), value);
        readouts.appendChild(item);
        this.readouts[key] = value;
      }
      head.appendChild(readouts);

      this.plot = el("div", "speed-plot");
      this.chart = svg("svg", "speed-svg");
      this.chart.setAttribute("viewBox", `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`);
      this.chart.setAttribute("preserveAspectRatio", "none");
      this.chart.setAttribute("role", "img");
      this.grid = svg("g", "speed-grid");
      this.area = svg("path", "speed-area");
      this.line = svg("path", "speed-line");
      this.line.setAttribute("vector-effect", "non-scaling-stroke");
      this.chart.append(this.grid, this.area, this.line);
      this.yLabels = el("div", "speed-y-labels");
      this.yLabels.setAttribute("aria-hidden", "true");
      this.cursor = el("div", "speed-cursor hidden");
      this.dot = el("div", "speed-dot hidden");
      this.tip = el("div", "speed-tip hidden");
      this.empty = el("p", "speed-empty", "The speed shows up here once data starts moving.");
      this.plot.append(this.chart, this.yLabels, this.cursor, this.dot, this.tip, this.empty);

      this.axis = el("div", "speed-axis");
      this.axisStart = el("span", null, "0:00");
      this.axisEnd = el("span", null, "");
      this.axis.append(this.axisStart, this.axisEnd);
      this.axis.setAttribute("aria-hidden", "true");

      this.root.replaceChildren(head, this.plot, this.axis);
      this.plot.addEventListener("mousemove", (event) => this.hover(event));
      this.plot.addEventListener("mouseleave", () => this.clearHover());
    }

    reset() {
      this.points = [];
      this.startedAt = Date.now();
      this.running = true;
      this.peak = 0;
      this.sum = 0;
      this.count = 0;
      this.root.classList.add("is-running");
      this.clearHover();
      this.scheduleRender();
    }

    push(rateText) {
      const rate = parseRate(rateText);
      if (rate == null) {
        return;
      }
      if (!this.startedAt) {
        this.startedAt = Date.now();
      }
      if (!this.points.length) {
        this.points.push({ t: 0, v: 0 });
      }
      this.points.push({ t: Date.now() - this.startedAt, v: rate });
      this.peak = Math.max(this.peak, rate);
      this.sum += rate;
      this.count += 1;
      if (this.points.length > MAX_POINTS) {
        const merged = [];
        for (let index = 0; index < this.points.length; index += 2) {
          const pair = this.points.slice(index, index + 2);
          merged.push({ t: pair[pair.length - 1].t, v: pair.reduce((sum, point) => sum + point.v, 0) / pair.length });
        }
        this.points = merged;
      }
      this.scheduleRender();
    }

    finish() {
      this.running = false;
      this.root.classList.remove("is-running");
      this.scheduleRender();
    }

    scheduleRender() {
      if (this.renderQueued) {
        return;
      }
      this.renderQueued = true;
      requestAnimationFrame(() => {
        this.renderQueued = false;
        this.render();
      });
    }

    scale() {
      const last = this.points[this.points.length - 1];
      const span = Math.max(1000, last ? last.t : 0);
      const top = niceCeiling(this.peak * 1.08);
      return {
        span,
        top,
        x: (t) => (t / span) * VIEW_WIDTH,
        y: (v) => VIEW_HEIGHT - (v / top) * (VIEW_HEIGHT - 4),
      };
    }

    render() {
      const last = this.points[this.points.length - 1];
      this.readouts.now.textContent = last ? formatRate(last.v) : "—";
      this.readouts.now.parentElement.classList.toggle("hidden", !this.running);
      this.readouts.average.textContent = this.count ? formatRate(this.sum / this.count) : "—";
      this.readouts.peak.textContent = this.count ? formatRate(this.peak) : "—";

      const hasData = this.points.length >= 2;
      this.empty.classList.toggle("hidden", hasData);
      this.chart.classList.toggle("hidden", !hasData);
      this.yLabels.classList.toggle("hidden", !hasData);
      this.axis.classList.toggle("is-empty", !hasData);
      if (!hasData) {
        this.chart.setAttribute("aria-label", "Transfer speed, waiting for data");
        this.axisEnd.textContent = "";
        return;
      }

      const { span, top, x, y } = this.scale();
      const coords = this.points.map((point) => [x(point.t), y(point.v)]);
      const path = coords.map(([px, py], index) => `${index ? "L" : "M"}${px.toFixed(1)},${py.toFixed(2)}`).join(" ");
      this.line.setAttribute("d", path);
      this.area.setAttribute("d", `${path} L${coords[coords.length - 1][0].toFixed(1)},${VIEW_HEIGHT} L${coords[0][0].toFixed(1)},${VIEW_HEIGHT} Z`);

      const gridLines = [top, top / 2].map((value) => {
        const line = svg("line", "speed-grid-line");
        line.setAttribute("x1", "0");
        line.setAttribute("x2", String(VIEW_WIDTH));
        line.setAttribute("y1", String(y(value)));
        line.setAttribute("y2", String(y(value)));
        line.setAttribute("vector-effect", "non-scaling-stroke");
        return line;
      });
      this.grid.replaceChildren(...gridLines);
      this.yLabels.replaceChildren(...[top, top / 2].map((value) => {
        const label = el("span", "speed-y-label", formatRate(value, { compact: true }));
        label.style.top = `${(y(value) / VIEW_HEIGHT) * 100}%`;
        return label;
      }));

      this.axisEnd.textContent = this.running ? "Now" : formatElapsed(span);
      this.chart.setAttribute(
        "aria-label",
        `Transfer speed over ${formatElapsed(span)}, average ${formatRate(this.sum / this.count)}, peak ${formatRate(this.peak)}`,
      );

      if (this.hoverX != null) {
        this.showHover(this.hoverX);
      }
    }

    hover(event) {
      const box = this.plot.getBoundingClientRect();
      this.hoverX = event.clientX - box.left;
      this.showHover(this.hoverX);
    }

    showHover(offsetX) {
      if (this.points.length < 2) {
        return;
      }
      const box = this.plot.getBoundingClientRect();
      const { x, y } = this.scale();
      const relative = (offsetX / box.width) * VIEW_WIDTH;
      let nearest = 0;
      for (let index = 1; index < this.points.length; index += 1) {
        if (Math.abs(x(this.points[index].t) - relative) < Math.abs(x(this.points[nearest].t) - relative)) {
          nearest = index;
        }
      }
      const point = this.points[nearest];
      const left = (x(point.t) / VIEW_WIDTH) * box.width;
      const top = (y(point.v) / VIEW_HEIGHT) * box.height;
      this.cursor.style.left = `${left}px`;
      this.dot.style.left = `${left}px`;
      this.dot.style.top = `${top}px`;
      this.tip.textContent = `${formatElapsed(point.t)} · ${formatRate(point.v)}`;
      this.tip.style.left = `${Math.min(Math.max(left, 64), box.width - 64)}px`;
      for (const node of [this.cursor, this.dot, this.tip]) {
        node.classList.remove("hidden");
      }
    }

    clearHover() {
      this.hoverX = null;
      for (const node of [this.cursor, this.dot, this.tip]) {
        node.classList.add("hidden");
      }
    }
  }

  window.SpeedGraph = SpeedGraph;
  window.SpeedGraph.parseRate = parseRate;
})();
