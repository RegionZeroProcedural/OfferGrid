import {
  setImmediate as setImmediatePromise,
  setTimeout as setTimeoutPromise,
} from "node:timers/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";


const EVENT_LOOP_DELAY = monitorEventLoopDelay({ resolution: 20 });
EVENT_LOOP_DELAY.enable();

let activeInteractiveRequests = 0;
let totalInteractiveRequests = 0;
let lastInteractiveAt = 0;
let backgroundPauseCount = 0;
let backgroundPausedMs = 0;
let lastBackgroundPauseReason = "";
let completedInteractiveRequests = 0;
let slowInteractiveRequests = 0;
let lastInteractiveDurationMs = 0;
let maxInteractiveDurationMs = 0;

function graceMs() {
  return Math.min(
    Math.max(Number(process.env.INTERACTIVE_PRIORITY_GRACE_MS || 175), 0),
    5000
  );
}

function pollMs() {
  return Math.min(
    Math.max(Number(process.env.INTERACTIVE_PRIORITY_POLL_MS || 12), 1),
    100
  );
}

export function interactivePriorityEnabled() {
  return String(process.env.INTERACTIVE_PRIORITY_ENABLED || "true").toLowerCase() !== "false";
}

export function beginInteractiveRequest() {
  if (!interactivePriorityEnabled()) return () => {};

  activeInteractiveRequests++;
  totalInteractiveRequests++;
  const startedAt = Date.now();
  lastInteractiveAt = startedAt;
  let finished = false;

  return () => {
    if (finished) return;
    finished = true;
    activeInteractiveRequests = Math.max(0, activeInteractiveRequests - 1);
    lastInteractiveAt = Date.now();
    const durationMs = Math.max(0, lastInteractiveAt - startedAt);
    completedInteractiveRequests++;
    lastInteractiveDurationMs = durationMs;
    maxInteractiveDurationMs = Math.max(maxInteractiveDurationMs, durationMs);
    if (durationMs >= Math.max(100, Number(process.env.INTERACTIVE_SLOW_REQUEST_MS || 500))) {
      slowInteractiveRequests++;
    }
  };
}

export function hasInteractiveDemand({ quietMs = graceMs() } = {}) {
  if (!interactivePriorityEnabled()) return false;
  if (activeInteractiveRequests > 0) return true;
  return Date.now() - lastInteractiveAt < Math.max(0, Number(quietMs || 0));
}

export async function waitForInteractiveIdle({
  reason = "background-work",
  quietMs = graceMs(),
  alwaysYield = true,
} = {}) {
  if (alwaysYield) {
    // setImmediate runs after pending I/O callbacks, so client sockets get a
    // chance to run before background work continues.
    await setImmediatePromise();
  }

  if (!interactivePriorityEnabled()) {
    return { paused: false, waitedMs: 0 };
  }

  const startedAt = Date.now();
  let paused = false;

  while (hasInteractiveDemand({ quietMs })) {
    paused = true;
    await setTimeoutPromise(pollMs(), undefined, { ref: false });
  }

  const waitedMs = Date.now() - startedAt;
  if (paused) {
    backgroundPauseCount++;
    backgroundPausedMs += waitedMs;
    lastBackgroundPauseReason = String(reason || "background-work").slice(0, 160);
  }

  return { paused, waitedMs };
}

export async function backgroundCheckpoint(reason = "background-work", options = {}) {
  return waitForInteractiveIdle({ reason, ...options, alwaysYield: true });
}

export function getInteractivePriorityStatus() {
  const elu = performance.eventLoopUtilization();
  const toMs = value => Number.isFinite(Number(value)) ? Number(value) / 1e6 : 0;
  return {
    enabled: interactivePriorityEnabled(),
    activeInteractiveRequests,
    totalInteractiveRequests,
    lastInteractiveAt: lastInteractiveAt ? new Date(lastInteractiveAt).toISOString() : null,
    graceMs: graceMs(),
    backgroundPauseCount,
    backgroundPausedMs,
    lastBackgroundPauseReason: lastBackgroundPauseReason || null,
    completedInteractiveRequests,
    slowInteractiveRequests,
    slowRequestThresholdMs: Math.max(100, Number(process.env.INTERACTIVE_SLOW_REQUEST_MS || 500)),
    lastInteractiveDurationMs,
    maxInteractiveDurationMs,
    eventLoopUtilization: Number(elu.utilization || 0),
    eventLoopDelayMeanMs: toMs(EVENT_LOOP_DELAY.mean),
    eventLoopDelayP95Ms: toMs(EVENT_LOOP_DELAY.percentile(95)),
    eventLoopDelayMaxMs: toMs(EVENT_LOOP_DELAY.max),
  };
}
