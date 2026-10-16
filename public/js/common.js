let configPromise = null;

export const CLIENT_BUILD_VERSION = "3.7.61-js";
const CLIENT_VERSION_KEY = "offergrid:client-build";
const CLIENT_RELOAD_KEY = "offergrid:reload-target";
const CLIENT_VIEW_STATE_KEY = "offergrid:view-state";
const CLIENT_VIEW_STATE_MAX_AGE_MS = 15 * 60 * 1000;
const CLIENT_CACHE_PREFIXES = [
  "offergrid:cache:",
  "offergrid:data:",
  "offergrid:catalog:",
];
const VERSION_CHECK_INTERVAL_MS = 2 * 60 * 1000;
let versionCheckStarted = false;
let versionReconcilePromise = null;

const VISITOR_STORAGE_KEY = "offergrid:visitor-id:v1";
const VISITOR_CONNECTION_STORAGE_KEY = "offergrid:visitor-connection:v1";
const VISITOR_HEARTBEAT_MS = 5 * 60 * 1000;
let visitorHeartbeatTimer = null;
let visitorPresenceStarted = false;
let versionCheckTimer = null;

function randomAnonymousId(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function persistentAnonymousVisitorId() {
  const local = safeStorage(localStorage);
  if (local) {
    const existing = String(local.getItem(VISITOR_STORAGE_KEY) || "").trim();
    if (existing) return existing;
    const created = randomAnonymousId("visitor");
    try { local.setItem(VISITOR_STORAGE_KEY, created); } catch {}
    return created;
  }
  const session = safeStorage(sessionStorage);
  const existing = String(session?.getItem(VISITOR_STORAGE_KEY) || "").trim();
  if (existing) return existing;
  const created = randomAnonymousId("visitor-session");
  try { session?.setItem(VISITOR_STORAGE_KEY, created); } catch {}
  return created;
}

function anonymousConnectionId() {
  const session = safeStorage(sessionStorage);
  const existing = String(session?.getItem(VISITOR_CONNECTION_STORAGE_KEY) || "").trim();
  if (existing) return existing;
  const created = randomAnonymousId("connection");
  try { session?.setItem(VISITOR_CONNECTION_STORAGE_KEY, created); } catch {}
  return created;
}

const ANONYMOUS_VISITOR_ID = persistentAnonymousVisitorId();
const ANONYMOUS_CONNECTION_ID = anonymousConnectionId();

function sendVisitorPresence(active = true) {
  // The private Admin dashboard is operational traffic, not a shopper/user.
  if (location.pathname.toLowerCase().endsWith("/admin.html")) return;
  const body = JSON.stringify({
    visitorId: ANONYMOUS_VISITOR_ID,
    connectionId: ANONYMOUS_CONNECTION_ID,
    active: Boolean(active),
    path: `${location.pathname}${location.search}`.slice(0, 500),
    referrer: document.referrer.slice(0, 500),
  });

  if (!active && navigator.sendBeacon) {
    try {
      navigator.sendBeacon("/api/presence", new Blob([body], { type: "application/json" }));
      return;
    } catch {}
  }

  fetch("/api/presence", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    cache: "no-store",
  }).catch(() => {});
}

function startVisitorPresenceHeartbeat() {
  if (visitorPresenceStarted || location.pathname.toLowerCase().endsWith("/admin.html")) return;
  visitorPresenceStarted = true;

  const stopHeartbeat = () => {
    if (visitorHeartbeatTimer) clearTimeout(visitorHeartbeatTimer);
    visitorHeartbeatTimer = null;
  };

  const scheduleHeartbeat = () => {
    stopHeartbeat();
    if (document.visibilityState !== "visible") return;
    visitorHeartbeatTimer = setTimeout(() => {
      sendVisitorPresence(true);
      scheduleHeartbeat();
    }, VISITOR_HEARTBEAT_MS);
  };

  if (document.visibilityState === "visible") sendVisitorPresence(true);
  scheduleHeartbeat();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      sendVisitorPresence(true);
      scheduleHeartbeat();
    } else {
      stopHeartbeat();
    }
  });
  window.addEventListener("pagehide", () => {
    stopHeartbeat();
    sendVisitorPresence(false);
  });
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function money(value, currency = "USD") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(number);
  } catch {
    return `${currency} ${number.toFixed(2)}`;
  }
}

export function percent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "—";
}

function safeStorage(storage) {
  try {
    const probe = "__offergrid_probe__";
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

function removePrefixedStorage(storage) {
  const target = safeStorage(storage);
  if (!target) return 0;
  const keys = [];
  for (let i = 0; i < target.length; i++) {
    const key = target.key(i);
    if (key) keys.push(key);
  }
  let removed = 0;
  for (const key of keys) {
    if (CLIENT_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) {
      target.removeItem(key);
      removed++;
    }
  }
  return removed;
}

async function clearOfferGridCacheStorage() {
  if (!("caches" in window)) return 0;
  try {
    const keys = await caches.keys();
    const targets = keys.filter(key => /^offergrid(?:-|:|$)/i.test(String(key)));
    const results = await Promise.all(targets.map(key => caches.delete(key)));
    return results.filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function refreshSameOriginServiceWorkers() {
  if (!("serviceWorker" in navigator)) return 0;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    const sameOrigin = registrations.filter(registration => {
      try { return new URL(registration.scope).origin === location.origin; }
      catch { return false; }
    });
    await Promise.all(sameOrigin.map(registration => registration.update().catch(() => {})));
    return sameOrigin.length;
  } catch {
    return 0;
  }
}

async function purgeOutdatedClientData(serverVersion) {
  const local = safeStorage(localStorage);
  const previousVersion = local?.getItem(CLIENT_VERSION_KEY) || "";
  const [cacheEntriesRemoved, serviceWorkersChecked] = await Promise.all([
    clearOfferGridCacheStorage(),
    refreshSameOriginServiceWorkers(),
  ]);
  const localEntriesRemoved = removePrefixedStorage(localStorage);
  const sessionEntriesRemoved = removePrefixedStorage(sessionStorage);
  try { local?.setItem(CLIENT_VERSION_KEY, serverVersion); } catch {}
  return { previousVersion, serverVersion, cacheEntriesRemoved, serviceWorkersChecked, localEntriesRemoved, sessionEntriesRemoved };
}


function stableAnchorSelector(element) {
  if (!element) return "";
  const productId = String(element.dataset?.productId || "").trim();
  if (productId) return `[data-product-id="${CSS.escape(productId)}"]`;
  const offerId = String(element.dataset?.offerId || "").trim();
  if (offerId) return `[data-offer-id="${CSS.escape(offerId)}"]`;
  if (element.id) return `#${CSS.escape(element.id)}`;
  return "";
}

export function captureScrollAnchor(selector = ".product-card[data-product-id]") {
  const snapshot = {
    scrollX: Number(window.scrollX || 0),
    scrollY: Number(window.scrollY || 0),
    selector: "",
    offsetTop: 0,
  };

  if (!selector) return snapshot;

  const candidates = [...document.querySelectorAll(selector)];
  const visible = candidates
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .filter(item => item.rect.bottom > 0 && item.rect.top < window.innerHeight)
    .sort((a, b) => {
      const aVisibleTop = Math.max(0, a.rect.top);
      const bVisibleTop = Math.max(0, b.rect.top);
      return aVisibleTop - bVisibleTop || a.rect.top - b.rect.top;
    });

  const anchor = visible[0] || null;
  const anchorSelector = stableAnchorSelector(anchor?.element);
  if (anchor && anchorSelector) {
    snapshot.selector = anchorSelector;
    snapshot.offsetTop = Number(anchor.rect.top || 0);
  }

  return snapshot;
}

export function restoreScrollAnchor(snapshot, { retries = 4 } = {}) {
  if (!snapshot || typeof snapshot !== "object") return;

  let attempts = 0;
  const restore = () => {
    attempts++;
    let restored = false;

    if (snapshot.selector) {
      try {
        const element = document.querySelector(snapshot.selector);
        if (element) {
          const delta = Number(element.getBoundingClientRect().top || 0) - Number(snapshot.offsetTop || 0);
          if (Math.abs(delta) > 0.5) {
            window.scrollBy({ left: 0, top: delta, behavior: "auto" });
          }
          restored = true;
        }
      } catch {}
    }

    if (!restored) {
      window.scrollTo({
        left: Number(snapshot.scrollX || 0),
        top: Number(snapshot.scrollY || 0),
        behavior: "auto",
      });
    }

    if (attempts < Math.max(1, Number(retries) || 1)) {
      setTimeout(restore, attempts === 1 ? 40 : attempts === 2 ? 120 : 300);
    }
  };

  requestAnimationFrame(() => requestAnimationFrame(restore));
}

export function preserveCurrentViewState(reason = "client-update") {
  const session = safeStorage(sessionStorage);
  if (!session) return null;

  let pageState = null;
  try {
    if (typeof window.__OFFERGRID_CAPTURE_VIEW_STATE__ === "function") {
      pageState = window.__OFFERGRID_CAPTURE_VIEW_STATE__();
    }
  } catch {}

  const snapshot = {
    version: CLIENT_BUILD_VERSION,
    reason: String(reason || "client-update").slice(0, 80),
    at: Date.now(),
    pathname: location.pathname,
    search: location.search,
    viewport: captureScrollAnchor(),
    pageState: pageState && typeof pageState === "object" ? pageState : null,
  };

  try {
    session.setItem(CLIENT_VIEW_STATE_KEY, JSON.stringify(snapshot));
    return snapshot;
  } catch {
    return null;
  }
}

export function takePreservedViewState() {
  const session = safeStorage(sessionStorage);
  if (!session) return null;

  let snapshot = null;
  try {
    const raw = session.getItem(CLIENT_VIEW_STATE_KEY);
    session.removeItem(CLIENT_VIEW_STATE_KEY);
    if (!raw) return null;
    snapshot = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!snapshot || typeof snapshot !== "object") return null;
  if (String(snapshot.pathname || "") !== location.pathname) return null;

  const at = Number(snapshot.at || 0);
  if (!Number.isFinite(at) || Date.now() - at > CLIENT_VIEW_STATE_MAX_AGE_MS) {
    return null;
  }

  return snapshot;
}

function reloadForCurrentBuild(serverVersion) {
  const session = safeStorage(sessionStorage);
  const alreadyTried = session?.getItem(CLIENT_RELOAD_KEY) === serverVersion;
  if (alreadyTried) {
    console.warn(`[OfferGrid] Client/server build mismatch remains after reload attempt: ${CLIENT_BUILD_VERSION} vs ${serverVersion}`);
    return false;
  }
  try { session?.setItem(CLIENT_RELOAD_KEY, serverVersion); } catch {}
  preserveCurrentViewState("client-build-update");
  const url = new URL(location.href);
  url.searchParams.set("og_build", serverVersion);
  location.replace(url.toString());
  return true;
}

export async function reconcileClientVersion(serverVersion) {
  const current = String(serverVersion || "").trim();
  if (!current) return { current: true };
  if (versionReconcilePromise) return versionReconcilePromise;

  versionReconcilePromise = (async () => {
    const local = safeStorage(localStorage);
    const storedVersion = local?.getItem(CLIENT_VERSION_KEY) || "";
    const loadedBuildMatches = current === CLIENT_BUILD_VERSION;

    if (storedVersion !== current) {
      const cleanup = await purgeOutdatedClientData(current);
      if (!loadedBuildMatches) {
        return { current: false, reloading: reloadForCurrentBuild(current), ...cleanup };
      }
      try { safeStorage(sessionStorage)?.removeItem(CLIENT_RELOAD_KEY); } catch {}
      return { current: true, migrated: true, ...cleanup };
    }

    if (!loadedBuildMatches) {
      const cleanup = await purgeOutdatedClientData(current);
      return { current: false, reloading: reloadForCurrentBuild(current), ...cleanup };
    }

    try { safeStorage(sessionStorage)?.removeItem(CLIENT_RELOAD_KEY); } catch {}
    return { current: true, migrated: false, previousVersion: storedVersion, serverVersion: current };
  })();

  try { return await versionReconcilePromise; }
  finally { versionReconcilePromise = null; }
}

export async function checkForOfferGridUpdate() {
  try {
    const response = await fetch("/api/config", {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "X-OfferGrid-Client-Version": CLIENT_BUILD_VERSION,
      },
    });
    if (!response.ok) return false;
    const config = await response.json();
    const result = await reconcileClientVersion(config.version);
    return !result.current || Boolean(result.migrated);
  } catch {
    return false;
  }
}

function startVersionChecks() {
  if (versionCheckStarted) return;
  versionCheckStarted = true;

  const stopTimer = () => {
    if (versionCheckTimer) clearTimeout(versionCheckTimer);
    versionCheckTimer = null;
  };
  const schedule = () => {
    stopTimer();
    if (document.visibilityState !== "visible") return;
    versionCheckTimer = setTimeout(async () => {
      await checkForOfferGridUpdate().catch(() => {});
      schedule();
    }, VERSION_CHECK_INTERVAL_MS);
  };
  const checkNow = () => {
    if (document.visibilityState !== "visible") return;
    checkForOfferGridUpdate().catch(() => {});
    schedule();
  };
  window.addEventListener("focus", checkNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkNow();
    else stopTimer();
  });
  window.addEventListener("pagehide", stopTimer);
  schedule();
}

function parseLiveEvent(event) {
  try { return JSON.parse(event.data || "{}"); }
  catch { return {}; }
}

export function connectOfferGridLive({ admin = false, onEvent = () => {}, onStatus = () => {} } = {}) {
  if (!("EventSource" in window)) {
    onStatus("unsupported");
    return { close() {} };
  }

  const endpoint = admin ? "/api/admin/live/stream" : "/api/live/stream";
  const source = new EventSource(endpoint, { withCredentials: true });
  const handle = type => event => {
    const data = parseLiveEvent(event);
    if (type === "hello") {
      onStatus("connected");
      if (data.version) reconcileClientVersion(data.version).catch(() => {});
    }
    onEvent({ type, ...data });
  };

  for (const type of ["hello", "catalog", "price", "analytics", "admin", "hydration"]) {
    source.addEventListener(type, handle(type));
  }
  source.addEventListener("open", () => onStatus("connected"));
  source.addEventListener("error", () => onStatus("reconnecting"));
  return source;
}

function currentSection() {
  const path = location.pathname.toLowerCase();
  if (path.endsWith("/admin.html")) return "admin";
  if (path.endsWith("/trending.html")) return "trending";
  if (path.endsWith("/disclosure.html")) return "disclosure";
  if (path.endsWith("/methodology.html")) return "methodology";
  if (path.endsWith("/privacy.html")) return "privacy";
  if (path.endsWith("/terms.html")) return "terms";
  return "store";
}

function upsertMeta(selector, attributes) {
  let element = document.head.querySelector(selector);
  if (!element) {
    element = document.createElement("meta");
    document.head.appendChild(element);
  }
  for (const [key, value] of Object.entries(attributes)) {
    element.setAttribute(key, value);
  }
  return element;
}

function applyPublicMetadata(config = {}) {
  const base = String(config.siteBaseUrl || "").replace(/\/$/, "");
  if (!base) return;

  const canonical = new URL(`${base}${location.pathname}${location.search}`);
  for (const transient of ["og_build", "og_recover", "og_t"]) {
    canonical.searchParams.delete(transient);
  }
  const canonicalUrl = canonical.toString();

  let canonicalLink = document.head.querySelector('link[rel="canonical"]');
  if (!canonicalLink) {
    canonicalLink = document.createElement("link");
    canonicalLink.rel = "canonical";
    document.head.appendChild(canonicalLink);
  }
  canonicalLink.href = canonicalUrl;

  upsertMeta('meta[property="og:site_name"]', {
    property: "og:site_name",
    content: config.appName || "OfferGrid",
  });
  upsertMeta('meta[property="og:url"]', {
    property: "og:url",
    content: canonicalUrl,
  });
  upsertMeta('meta[property="og:type"]', {
    property: "og:type",
    content: currentSection() === "store" ? "website" : "article",
  });
  upsertMeta('meta[name="twitter:card"]', {
    name: "twitter:card",
    content: "summary_large_image",
  });
}

export function renderSiteChrome(config = {}) {
  const appName = config.appName || "OfferGrid";
  const active = currentSection();

  document.body.classList.add("offergrid-theme", `offergrid-section-${active}`);

  const nav = [
    { key: "store", href: "/", label: "Price Intelligence" },
    { key: "trending", href: "/trending.html", label: "Price Signals" },
    { key: "methodology", href: "/methodology.html", label: "Methodology" },
    { key: "disclosure", href: "/disclosure.html", label: "Disclosure" },
  ];

  if (active === "admin" || config.showAdminNav) {
    nav.push({ key: "admin", href: "/admin.html", label: "Admin" });
  }

  const header = document.querySelector("[data-site-header]");
  if (header) {
    header.className = "site-header shell";
    header.innerHTML = `
      <a class="brand-lockup" href="/">
        <span class="brand-mark" aria-hidden="true"><i></i></span>
        <span class="brand-copy">
          <span class="brand-name">${escapeHtml(appName)}</span>
          <span class="brand-tagline">Know when a deal is actually a deal.</span>
        </span>
      </a>
      <button class="nav-toggle" type="button" aria-expanded="false" aria-controls="offergrid-main-nav" aria-label="Open navigation"><span aria-hidden="true">☰</span></button>
      <nav class="main-nav" id="offergrid-main-nav" aria-label="Primary navigation">
        ${nav.map(item => `
          <a href="${item.href}" class="${active === item.key ? "active" : ""}">
            ${item.label}
          </a>
        `).join("")}
      </nav>
    `;

    const toggle = header.querySelector(".nav-toggle");
    const mainNav = header.querySelector(".main-nav");
    const setNavOpen = open => {
      mainNav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      toggle.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
      const glyph = toggle.querySelector("span");
      if (glyph) glyph.textContent = open ? "×" : "☰";
    };
    toggle?.addEventListener("click", () => setNavOpen(!mainNav.classList.contains("open")));
    mainNav?.addEventListener("click", event => {
      if (event.target.closest("a")) setNavOpen(false);
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") setNavOpen(false);
    });
    document.addEventListener("click", event => {
      if (!header.contains(event.target)) setNavOpen(false);
    });
  }

  const footer = document.querySelector("[data-site-footer]");
  if (footer) {
    footer.className = "site-footer shell";
    footer.innerHTML = `
      <div class="footer-brand">
        <strong>${escapeHtml(appName)}</strong>
        <p>Know when a deal is actually a deal.</p>
        <span>Verified prices · Market comparisons · Recorded history · Transparent monetization</span>
      </div>
      <div class="footer-links">
        <a href="/">Price Intelligence</a>
        <a href="/trending.html">Price Signals</a>
        <a href="/methodology.html">Methodology</a>
        <a href="/disclosure.html">Affiliate disclosure</a>
        <a href="/privacy.html">Privacy</a>
        <a href="/terms.html">Terms of Use</a>
      </div>
      <p class="footer-note">OfferGrid compares offers it currently tracks; a lower price may exist elsewhere. Prices and availability can change; verify final checkout details with the merchant.</p>
    `;
  }

  document.querySelectorAll("[data-app-name]").forEach(el => {
    el.textContent = appName;
  });

  window.__OFFERGRID_CHROME_READY__ = CLIENT_BUILD_VERSION;
}


function validSquirrelUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "getsquirrel.co" || host.endsWith(".getsquirrel.co"))
    );
  } catch {
    return false;
  }
}

export function loadSquirrel(config) {
  // Never load affiliate rewrite scripts inside the Admin dashboard.
  if (currentSection() === "admin") return;
  if (!config?.squirrelEnabled) return;
  if (!validSquirrelUrl(config?.squirrelScriptUrl)) return;
  if (document.querySelector("script[data-offergrid-squirrel]")) return;

  const script = document.createElement("script");
  script.async = true;
  script.dataset.offergridSquirrel = "1";
  script.src = config.squirrelScriptUrl;
  document.head.appendChild(script);
}

export async function getConfig() {
  if (!configPromise) {
    configPromise = fetch("/api/config", {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        "X-OfferGrid-Client-Version": CLIENT_BUILD_VERSION,
      },
    })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load site configuration.");
        return response.json();
      })
      .then(async config => {
        const versionState = await reconcileClientVersion(config.version);
        if (versionState?.reloading) return config;
        renderSiteChrome(config);
        applyPublicMetadata(config);
        loadSquirrel(config);
        startVersionChecks();
        return config;
      });
  }

  try {
    return await configPromise;
  } catch (error) {
    configPromise = null;
    throw error;
  }
}

export function renderAd(container, config) {
  if (!container || !config?.adsenseClient || !config?.adsenseSlot) return;

  if (!document.querySelector('script[data-offergrid-adsense]')) {
    const script = document.createElement("script");
    script.async = true;
    script.dataset.offergridAdsense = "1";
    script.crossOrigin = "anonymous";
    script.src =
      `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=` +
      encodeURIComponent(config.adsenseClient);
    document.head.appendChild(script);
  }

  container.className = "ad-zone";
  container.innerHTML = `
    <div class="ad-label">Advertisement</div>
    <ins class="adsbygoogle"
         data-ad-client="${escapeHtml(config.adsenseClient)}"
         data-ad-slot="${escapeHtml(config.adsenseSlot)}"
         data-ad-format="auto"
         data-full-width-responsive="true"></ins>
  `;

  try {
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  } catch {}
}

// Every public/admin page imports this module, so render the exact same navbar everywhere.
startVisitorPresenceHeartbeat();
getConfig().catch(() => {});
