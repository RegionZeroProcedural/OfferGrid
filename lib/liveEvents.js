import { EventEmitter } from "events";

const emitter = new EventEmitter();
emitter.setMaxListeners(5000);
let revision = 0;

function safeAudience(value) {
  return ["public", "admin", "all"].includes(String(value))
    ? String(value)
    : "all";
}

export function publishLiveEvent(type, payload = {}, { audience = "all" } = {}) {
  revision++;
  const event = {
    id: revision,
    revision,
    type: String(type || "catalog").slice(0, 80),
    audience: safeAudience(audience),
    at: new Date().toISOString(),
    payload: payload && typeof payload === "object" ? payload : { value: payload },
  };

  queueMicrotask(() => emitter.emit("event", event));
  return event;
}

export function subscribeLiveEvents(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("Live event listener must be a function.");
  }
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export function getLiveEventRevision() {
  return revision;
}
