function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const hh = hours > 0 ? `${String(hours).padStart(2, "0")}:` : "";
  return `${hh}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) return "? item/s";
  if (rate >= 100) return `${Math.round(rate).toLocaleString()} item/s`;
  if (rate >= 10) return `${rate.toFixed(1)} item/s`;
  return `${rate.toFixed(2)} item/s`;
}

function displayWidth(text) {
  return String(text || "").replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncateLabel(label, maxLength) {
  const text = String(label || "startup work");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

export class StartupTqdmBar {
  constructor({
    stream = process.stdout,
    minIntervalMs = Number(process.env.STARTUP_TQDM_MIN_INTERVAL_MS || 100),
    ascii = String(process.env.STARTUP_TQDM_ASCII || "false").toLowerCase() === "true",
    enabled = String(process.env.STARTUP_TQDM || "true").toLowerCase() !== "false",
    force = String(process.env.STARTUP_TQDM_FORCE || "false").toLowerCase() === "true",
  } = {}) {
    this.stream = stream;
    this.minIntervalMs = Math.max(40, Number(minIntervalMs) || 100);
    this.ascii = Boolean(ascii);
    this.enabled = Boolean(enabled) && (Boolean(stream?.isTTY) || Boolean(force));
    this.active = false;
    this.label = "";
    this.total = 0;
    this.current = 0;
    this.startedAt = 0;
    this.lastRenderedAt = 0;
    this.lastRenderedCurrent = -1;
    this.lastLineWidth = 0;
  }

  start(label, total, current = 0) {
    this.stop({ clear: true });
    this.label = String(label || "startup work");
    this.total = Math.max(0, Number(total) || 0);
    this.current = clamp(Number(current) || 0, 0, this.total || Number.MAX_SAFE_INTEGER);
    this.startedAt = Date.now();
    this.lastRenderedAt = 0;
    this.lastRenderedCurrent = -1;
    this.active = this.enabled && this.total > 0;
    if (this.active) this.render(true);
    return this.active;
  }

  update(current, { label = null, force = false } = {}) {
    if (label != null) this.label = String(label);
    this.current = clamp(Number(current) || 0, 0, this.total || Number.MAX_SAFE_INTEGER);
    if (!this.active) return;
    this.render(Boolean(force) || this.current >= this.total);
  }

  render(force = false) {
    if (!this.active) return;
    const now = Date.now();
    if (
      !force &&
      now - this.lastRenderedAt < this.minIntervalMs &&
      this.current < this.total
    ) return;
    if (!force && this.current === this.lastRenderedCurrent) return;

    const elapsedMs = Math.max(1, now - this.startedAt);
    const rate = this.current > 0 ? this.current / (elapsedMs / 1000) : 0;
    const remaining = Math.max(0, this.total - this.current);
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : Infinity;
    const percentage = this.total > 0 ? (this.current / this.total) * 100 : 0;

    const terminalWidth = Math.max(60, Number(this.stream?.columns || 100));
    const countText = `${this.current.toLocaleString()}/${this.total.toLocaleString()}`;
    const timingText = `[${formatClock(elapsedMs)}<${Number.isFinite(etaMs) ? formatClock(etaMs) : "--:--"}, ${formatRate(rate)}]`;
    const percentText = `${percentage.toFixed(0).padStart(3, " ")}%`;
    const labelMax = clamp(Math.floor(terminalWidth * 0.28), 16, 42);
    const renderedLabel = truncateLabel(this.label, labelMax);
    const fixedWidth = displayWidth(`${renderedLabel}: ${percentText}|| ${countText} ${timingText}`) + 2;
    const barWidth = clamp(terminalWidth - fixedWidth, 10, 48);
    const completeCount = clamp(Math.floor((percentage / 100) * barWidth), 0, barWidth);
    const incompleteCount = Math.max(0, barWidth - completeCount);
    const completeChar = this.ascii ? "#" : "█";
    const incompleteChar = this.ascii ? "-" : "░";
    const bar = `${completeChar.repeat(completeCount)}${incompleteChar.repeat(incompleteCount)}`;
    const line = `${renderedLabel}: ${percentText}|${bar}| ${countText} ${timingText}`;

    const padding = Math.max(0, this.lastLineWidth - displayWidth(line));
    this.stream.write(`\r${line}${" ".repeat(padding)}`);
    this.lastLineWidth = displayWidth(line);
    this.lastRenderedAt = now;
    this.lastRenderedCurrent = this.current;
  }

  clearLine() {
    if (!this.active) return;
    const width = Math.max(this.lastLineWidth, Number(this.stream?.columns || 0));
    this.stream.write(`\r${" ".repeat(Math.max(1, width))}\r`);
    this.lastLineWidth = 0;
  }

  interrupt(message) {
    if (!message) return;
    if (!this.active) {
      console.log(message);
      return;
    }
    this.clearLine();
    console.log(message);
    this.lastRenderedAt = 0;
    this.lastRenderedCurrent = -1;
    this.render(true);
  }

  stop({ complete = false, clear = false } = {}) {
    if (!this.active) return;
    if (complete) {
      this.current = this.total;
      this.render(true);
    }
    if (clear) {
      this.clearLine();
    } else {
      this.stream.write("\n");
    }
    this.active = false;
    this.lastLineWidth = 0;
  }
}
