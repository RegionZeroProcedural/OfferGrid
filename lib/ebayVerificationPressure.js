function envNumber(name, fallback, min, max) {
  const raw = Number(process.env[name]);
  const value = Number.isFinite(raw) ? raw : fallback;
  return Math.min(Math.max(value, min), max);
}

function envBoolean(name, fallback = true) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return Boolean(fallback);
  return String(raw).trim().toLowerCase() === "true";
}

function thresholds() {
  const elevated = Math.floor(
    envNumber("EBAY_ADAPTIVE_VERIFY_ELEVATED_PENDING", 500, 1, 100_000)
  );
  const high = Math.max(
    elevated + 1,
    Math.floor(envNumber("EBAY_ADAPTIVE_VERIFY_HIGH_PENDING", 1500, 2, 200_000))
  );
  const catchup = Math.max(
    high + 1,
    Math.floor(envNumber("EBAY_ADAPTIVE_VERIFY_CATCHUP_PENDING", 3000, 3, 500_000))
  );
  return { elevated, high, catchup };
}

function policyForMode(mode) {
  if (mode === "catchup") {
    return {
      fallbackBrowseShare: envNumber(
        "EBAY_ADAPTIVE_VERIFY_CATCHUP_BROWSE_SHARE",
        1.0,
        0.05,
        1.0
      ),
      fallbackMaxCallsPerWindow: Math.floor(
        envNumber("EBAY_ADAPTIVE_VERIFY_CATCHUP_MAX_CALLS_PER_WINDOW", 35, 1, 250)
      ),
      discoveryScale: envNumber(
        "EBAY_ADAPTIVE_VERIFY_CATCHUP_DISCOVERY_SCALE",
        0.15,
        0,
        1.0
      ),
      suspendBackgroundPriceRefresh: envBoolean(
        "EBAY_ADAPTIVE_VERIFY_CATCHUP_SUSPEND_PRICE_REFRESH",
        true
      ),
    };
  }

  if (mode === "high") {
    return {
      fallbackBrowseShare: envNumber(
        "EBAY_ADAPTIVE_VERIFY_HIGH_BROWSE_SHARE",
        0.75,
        0.05,
        1.0
      ),
      fallbackMaxCallsPerWindow: Math.floor(
        envNumber("EBAY_ADAPTIVE_VERIFY_HIGH_MAX_CALLS_PER_WINDOW", 26, 1, 250)
      ),
      discoveryScale: envNumber(
        "EBAY_ADAPTIVE_VERIFY_HIGH_DISCOVERY_SCALE",
        0.40,
        0,
        1.0
      ),
      suspendBackgroundPriceRefresh: false,
    };
  }

  if (mode === "elevated") {
    return {
      fallbackBrowseShare: envNumber(
        "EBAY_ADAPTIVE_VERIFY_ELEVATED_BROWSE_SHARE",
        0.50,
        0.05,
        1.0
      ),
      fallbackMaxCallsPerWindow: Math.floor(
        envNumber("EBAY_ADAPTIVE_VERIFY_ELEVATED_MAX_CALLS_PER_WINDOW", 18, 1, 250)
      ),
      discoveryScale: envNumber(
        "EBAY_ADAPTIVE_VERIFY_ELEVATED_DISCOVERY_SCALE",
        0.70,
        0,
        1.0
      ),
      suspendBackgroundPriceRefresh: false,
    };
  }

  return {
    fallbackBrowseShare: 0,
    fallbackMaxCallsPerWindow: 0,
    discoveryScale: 1,
    suspendBackgroundPriceRefresh: false,
  };
}

export function getEbayAdaptiveVerificationPolicy(pending = 0) {
  const safePending = Math.max(0, Math.floor(Number(pending) || 0));
  const enabled = envBoolean("EBAY_ADAPTIVE_VERIFICATION_ENABLED", true);
  const limits = thresholds();

  let mode = "normal";
  if (enabled && safePending >= limits.catchup) mode = "catchup";
  else if (enabled && safePending >= limits.high) mode = "high";
  else if (enabled && safePending >= limits.elevated) mode = "elevated";

  return {
    enabled,
    mode,
    pending: safePending,
    thresholds: limits,
    ...policyForMode(mode),
  };
}
