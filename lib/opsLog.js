const VERBOSE =
  String(process.env.VERBOSE_LOGGING || "true").toLowerCase() !== "false";

function timestamp() {
  return new Date().toISOString().replace("T", " ").replace("Z", " UTC");
}

function renderDetails(details) {
  if (details == null || details === "") return "";
  if (typeof details === "string") return ` ${details}`;
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

export function opLog(scope, message, details = null) {
  if (!VERBOSE) return;
  console.log(`[${timestamp()}] [${String(scope).toUpperCase()}] ${message}${renderDetails(details)}`);
}

export function opWarn(scope, message, details = null) {
  console.warn(`[${timestamp()}] [${String(scope).toUpperCase()}] ${message}${renderDetails(details)}`);
}

export function opError(scope, message, details = null) {
  console.error(`[${timestamp()}] [${String(scope).toUpperCase()}] ${message}${renderDetails(details)}`);
}

export function timedOp(scope, message, details = null) {
  const started = Date.now();
  opLog(scope, `${message} — started`, details);

  return (status = "complete", more = null) => {
    opLog(
      scope,
      `${message} — ${status} in ${Date.now() - started}ms`,
      more
    );
  };
}

export function verboseLoggingEnabled() {
  return VERBOSE;
}
