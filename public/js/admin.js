import {
  escapeHtml,
  money,
  getConfig,
  connectOfferGridLive,
} from "./common.js?v=3.7.61";

const loginPanel = document.querySelector("#login-panel");
const adminApp = document.querySelector("#admin-app");
const reviewList = document.querySelector("#review-list");
const rulesList = document.querySelector("#rules-list");
const message = document.querySelector("#message");
const adminLiveStatus = document.querySelector("#admin-live-status");
let adminLiveTimer = null;
let adminLivePending = false;
let adminLiveRefreshing = false;
let adminLiveSource = null;
let adminHasUnsavedEdits = false;
let adminMutationInFlight = 0;
let messageTimer = null;
let ebayTelemetryTimer = null;
let ebayTelemetryRefreshing = false;
let visitorAnalyticsTimer = null;
let visitorAnalyticsRefreshing = false;
let lastVisitorAnalytics = {};
let visitorGeoWindow = "live";
let lastEbayVerificationDemand = {};
let lastEbayCapabilities = {};
const EBAY_TELEMETRY_REFRESH_MS = 2000;
const VISITOR_ANALYTICS_REFRESH_MS = 5 * 60 * 1000;

const ADMIN_FOLD_STORAGE_KEY = "offergrid:admin-folds:v1";
const adminFoldSections = {
  rules: {
    button: "#toggle-rules-list",
    content: "#rules-list-wrap",
    noun: "rules",
  },
  products: {
    button: "#toggle-products-list",
    content: "#review-list-wrap",
    noun: "products",
  },
};

function readAdminFoldState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(ADMIN_FOLD_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeAdminFoldState(state) {
  try {
    localStorage.setItem(ADMIN_FOLD_STORAGE_KEY, JSON.stringify(state));
  } catch {}
}

function setAdminFold(section, collapsed, count = null) {
  const config = adminFoldSections[section];
  if (!config) return;
  const button = document.querySelector(config.button);
  const content = document.querySelector(config.content);
  if (!button || !content) return;

  content.classList.toggle("folded", Boolean(collapsed));
  button.setAttribute("aria-expanded", String(!collapsed));
  button.dataset.collapsed = collapsed ? "true" : "false";

  const existingCount = Number(button.dataset.count || 0);
  const resolvedCount = count == null ? existingCount : Math.max(0, Number(count || 0));
  button.dataset.count = String(resolvedCount);
  const countText = resolvedCount ? ` (${resolvedCount.toLocaleString()})` : "";
  button.textContent = `${collapsed ? "Show" : "Collapse"} ${config.noun}${countText}`;
}

function updateAdminFoldCount(section, count) {
  const config = adminFoldSections[section];
  const button = config ? document.querySelector(config.button) : null;
  if (!button) return;
  setAdminFold(section, button.dataset.collapsed === "true", count);
}

function wireAdminFoldControls() {
  const saved = readAdminFoldState();
  for (const [section, config] of Object.entries(adminFoldSections)) {
    const button = document.querySelector(config.button);
    if (!button) continue;
    const collapsed = Boolean(saved[section]);
    setAdminFold(section, collapsed, 0);
    button.addEventListener("click", () => {
      const nextCollapsed = button.dataset.collapsed !== "true";
      const state = readAdminFoldState();
      state[section] = nextCollapsed;
      writeAdminFoldState(state);
      setAdminFold(section, nextCollapsed);
    });
  }
}

wireAdminFoldControls();

function setAdminLiveStatus(state, text = "") {
  if (!adminLiveStatus) return;
  adminLiveStatus.dataset.state = state;
  adminLiveStatus.classList.remove("connected", "reconnecting", "updating");
  if (state === "connected") {
    adminLiveStatus.classList.add("connected");
    adminLiveStatus.textContent = text || "LIVE";
  } else if (state === "updating") {
    adminLiveStatus.classList.add("updating");
    adminLiveStatus.textContent = text || "SYNCING";
  } else {
    adminLiveStatus.classList.add("reconnecting");
    adminLiveStatus.textContent = text || "RECONNECTING";
  }
}

function adminIsActivelyEditing() {
  const active = document.activeElement;
  return Boolean(
    adminHasUnsavedEdits ||
    adminMutationInFlight > 0 ||
    (active && adminApp?.contains(active) && active.matches("input, textarea, select, [contenteditable='true']"))
  );
}

reviewList?.addEventListener("input", event => {
  if (event.target.matches("input, textarea, select, [contenteditable='true']")) {
    adminHasUnsavedEdits = true;
  }
});

async function refreshAdminFromLive() {
  if (adminLiveRefreshing) { adminLivePending = true; return; }
  if (adminIsActivelyEditing()) { adminLivePending = true; return; }
  adminLiveRefreshing = true;
  adminLivePending = false;
  setAdminLiveStatus("updating");
  try {
    await loadAdmin();
    setAdminLiveStatus("connected");
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("admin login required")) {
      adminLiveSource?.close?.();
      adminLiveSource = null;
      await checkAuth();
      return;
    }
    setAdminLiveStatus("reconnecting");
  } finally {
    adminLiveRefreshing = false;

    if (adminLivePending && !adminIsActivelyEditing()) {
      scheduleAdminLiveRefresh();
    }
  }
}

function scheduleAdminLiveRefresh() {
  adminLivePending = true;
  if (adminLiveTimer) clearTimeout(adminLiveTimer);
  adminLiveTimer = setTimeout(() => {
    adminLiveTimer = null;
    refreshAdminFromLive().catch(() => {});
  }, 2000);
}

function connectAdminLive() {
  adminLiveSource?.close?.();
  adminLiveSource = connectOfferGridLive({
    admin: true,
    onEvent: event => {
      if (event.type === "hello") return;
      if (event.type === "analytics" && event.visitors) {
        renderVisitorAnalytics(event.visitors);
        return;
      }
      scheduleAdminLiveRefresh();
    },
    onStatus: status => {
      if (status === "connected") setAdminLiveStatus("connected");
      else if (status === "reconnecting") setAdminLiveStatus("reconnecting");
    },
  });
}

document.addEventListener("focusout", () => {
  if (!adminLivePending) return;
  setTimeout(() => {
    if (!adminIsActivelyEditing()) refreshAdminFromLive().catch(() => {});
  }, 80);
});



function automationMetric(value, label, { tone = "", title = "" } = {}) {
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `
    <div class="automation-metric ${tone ? `automation-metric-${tone}` : ""}"${titleAttr}>
      <strong>${escapeHtml(String(value ?? "—"))}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function automationGroup(title, subtitle, metrics = []) {
  return `
    <section class="automation-metric-group">
      <div class="automation-metric-group-head">
        <strong>${escapeHtml(title)}</strong>
        ${subtitle ? `<span>${escapeHtml(subtitle)}</span>` : ""}
      </div>
      <div class="automation-metric-grid">${metrics.join("")}</div>
    </section>
  `;
}

function localDateOrDash(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "—";
}

function showMessage(text, kind = "info") {
  if (messageTimer) clearTimeout(messageTimer);
  message.textContent = text;
  message.className = `flash ${kind}`;
  message.classList.remove("hidden");
  messageTimer = setTimeout(() => {
    message.classList.add("hidden");
    messageTimer = null;
  }, 7000);
}

async function api(url, options = {}) {
  const {
    headers: optionHeaders = {},
    ...restOptions
  } = options;

  const mutating = String(restOptions.method || "GET").toUpperCase() !== "GET";
  if (mutating) adminMutationInFlight++;
  try {
    const response = await fetch(url, {
      ...restOptions,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...optionHeaders,
        // Keep this last so individual calls cannot accidentally remove the
        // Admin CSRF/request-guard marker.
        "X-OfferGrid-Admin": "1",
      },
    });

    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
    return data;
  } finally {
    if (mutating) adminMutationInFlight = Math.max(0, adminMutationInFlight - 1);
  }
}


const deploymentReadiness = document.querySelector("#deployment-readiness");

function renderDeployment(deployment) {
  if (!deploymentReadiness || !deployment) return;

  const checks = deployment.checks || [];
  const passing = checks.filter(item => item.ok).length;

  deploymentReadiness.innerHTML = `
    <div class="deployment-head">
      <div>
        <div class="eyebrow">LIVE DEPLOYMENT</div>
        <h2>${passing}/${checks.length} production checks passing</h2>
        <p class="muted">
          Canonical URL: <strong>${escapeHtml(deployment.siteBaseUrl || "")}</strong>
          · Bind: <strong>${escapeHtml(deployment.bind || "")}</strong>
        </p>
      </div>
      <span class="deployment-score ${passing === checks.length ? "ready" : ""}">
        ${passing === checks.length ? "LIVE READY" : "ACTION NEEDED"}
      </span>
    </div>
    <div class="deployment-checks">
      ${checks.map(check => `
        <div class="deployment-check ${check.ok ? "pass" : "fail"}">
          <span>${check.ok ? "✓" : "!"}</span>
          <div>
            <strong>${escapeHtml(check.name)}</strong>
            <small>${escapeHtml(check.detail || "")}</small>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function integrationChip(label, active, warning = false) {
  return `<span class="integration-chip ${active ? "on" : warning ? "warn" : ""}"><i></i>${escapeHtml(label)}</span>`;
}


const credentialVault = document.querySelector("#credential-vault");
const vaultSecurity = document.querySelector("#vault-security");

function sourceBadge(field) {
  const labels = {
    admin: "Admin vault",
    env: ".env",
    default: "Default",
    none: "Not set",
  };

  return `<span class="credential-source ${escapeHtml(field.source)}">${escapeHtml(labels[field.source] || field.source)}</span>`;
}

function integrationField(field) {
  const status = field.secret
    ? (field.configured ? field.masked : "Not configured")
    : (field.value || "Not configured");

  if (field.options && field.inputMode === "radio") {
    const current = String(field.value || "");
    const radios = field.options.map(([value, label]) => `
      <label class="credential-radio-option">
        <input
          type="radio"
          name="${escapeHtml(field.key)}"
          value="${escapeHtml(value)}"
          ${current === String(value) ? "checked" : ""}
        >
        <span>${escapeHtml(label)}</span>
      </label>
    `).join("");

    return `
      <div class="credential-field credential-radio-field">
        <span>${escapeHtml(field.label)} ${sourceBadge(field)}</span>
        <div class="credential-radio-group">${radios}</div>
        <small>Sandbox uses eBay test infrastructure. Production uses live eBay marketplace APIs.</small>
      </div>
    `;
  }

  if (field.options) {
    const options = field.options.map(([value, label]) => `
      <option value="${escapeHtml(value)}" ${String(field.value) === String(value) ? "selected" : ""}>
        ${escapeHtml(label)}
      </option>
    `).join("");

    return `
      <label class="credential-field">
        <span>${escapeHtml(field.label)} ${sourceBadge(field)}</span>
        <select name="${escapeHtml(field.key)}">${options}</select>
      </label>
    `;
  }

  const inputType = field.secret ? "password" : field.inputMode === "email" ? "email" : "text";
  const value = field.secret ? "" : escapeHtml(field.value || "");
  const placeholder = field.secret && field.configured
    ? `${status} — leave blank to keep`
    : field.secret
      ? "Enter credential"
      : "";

  return `
    <label class="credential-field">
      <span>
        ${escapeHtml(field.label)}
        ${field.required ? '<b class="required-mark">required</b>' : ""}
        ${sourceBadge(field)}
      </span>
      <input
        name="${escapeHtml(field.key)}"
        type="${inputType}"
        value="${value}"
        placeholder="${escapeHtml(placeholder)}"
        autocomplete="off"
        spellcheck="false"
        ${field.inputMode === "decimal" ? 'inputmode="decimal"' : ""}
      >
      ${field.secret && field.configured ? `<small>Saved as ${escapeHtml(status)}. The full value is never sent back to this page.</small>` : ""}
    </label>
  `;
}

function integrationCard(item) {
  const stateClass = item.configured ? "connected" : item.optionalWithoutCredentials ? "free-ready" : "";
  const stateLabel = item.configured
    ? "CONFIGURED"
    : item.optionalWithoutCredentials
      ? "READY WITHOUT KEY"
      : "NOT CONFIGURED";

  return `
    <article class="credential-card ${stateClass}" data-integration="${escapeHtml(item.id)}">
      <div class="credential-card-head">
        <div>
          <div class="credential-title-row">
            <h3>${escapeHtml(item.name)}</h3>
            <span class="connection-state">${stateLabel}</span>
          </div>
          <div class="meta">${escapeHtml(item.type)}</div>
          <p>${escapeHtml(item.description)}</p>
        </div>
        <a href="${escapeHtml(item.docsUrl)}" target="_blank" rel="noopener">Docs ↗</a>
      </div>

      <form class="credential-form" data-integration-form="${escapeHtml(item.id)}">
        <div class="credential-fields">
          ${item.fields.map(integrationField).join("")}
        </div>

        <div class="credential-actions">
          <button type="submit">Save</button>
          <button type="button" class="ghost" data-credential-action="test">${escapeHtml(item.testLabel || "Test connection")}</button>
          ${item.id === "ebay"
            ? `<button type="button" class="ghost" data-credential-action="test-ebay-deletion">Test deletion callback</button>`
            : ""}
          ${item.id === "rakuten"
            ? `<button type="button" class="ghost" data-credential-action="sync-rakuten-catalog">Sync Product Catalog now</button>`
            : ""}
          <button type="button" class="ghost danger" data-credential-action="clear">Clear Admin values</button>
        </div>

        ${item.id === "ebay" ? `
          <div class="ebay-compliance-note">
            <strong>eBay production compliance callback</strong>
            <span>
              Use the exact endpoint saved above in eBay Developer Portal →
              Alerts & Notifications → Marketplace Account Deletion.
            </span>
          </div>
        ` : ""}

        ${item.id === "rakuten" ? `
          <div class="ebay-compliance-note">
            <strong>Rakuten Product Catalog</strong>
            <span>
              Save the replacement SFTP username/password here after Rakuten activates them.
              OfferGrid uses one SFTP connection, imports full feeds periodically, and applies
              smaller delta feeds between full refreshes.
            </span>
          </div>
        ` : ""}

        <div class="credential-result meta" aria-live="polite"></div>
      </form>
    </article>
  `;
}

async function loadIntegrations() {
  if (!credentialVault) return;
  const data = await api("/api/admin/integrations");

  const vault = data.vault || {};
  vaultSecurity.innerHTML = `
    <div class="vault-lock">🔐</div>
    <div>
      <strong>${vault.encrypted ? "Encrypted credential storage enabled" : "Credential storage"}</strong>
      <div class="meta">
        ${escapeHtml(vault.algorithm || "")} · ${escapeHtml(vault.file || "")} · key source:
        <strong>${escapeHtml(vault.keySource || "unknown")}</strong>
      </div>
      ${vault.productionReadyKey
        ? `<div class="vault-good">Encryption key configuration looks suitable for deployment.</div>`
        : `<div class="vault-warning">
             Development encryption key in use. Before real deployment, set a stable random
             <code>CONFIG_ENCRYPTION_KEY</code> in <code>.env</code>.
           </div>`}
    </div>
  `;

  credentialVault.innerHTML = data.items.map(integrationCard).join("");
}

credentialVault?.addEventListener("submit", async event => {
  const form = event.target.closest("[data-integration-form]");
  if (!form) return;
  event.preventDefault();

  const id = form.dataset.integrationForm;
  const result = form.querySelector(".credential-result");
  const values = {};

  for (const element of form.elements) {
    if (!element.name) continue;
    if (element.type === "radio" && !element.checked) continue;
    if (String(element.value || "").trim() === "") continue;
    values[element.name] = element.value;
  }

  try {
    result.textContent = "Saving securely…";
    await api(`/api/admin/integrations/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
    result.textContent = "Saved. Secret fields were cleared from the browser form.";
    showMessage(`${id} credentials saved.`);
    await Promise.all([loadIntegrations(), loadAdmin()]);
  } catch (error) {
    result.textContent = error.message;
    showMessage(error.message, "error");
  }
});

credentialVault?.addEventListener("click", async event => {
  const button = event.target.closest("[data-credential-action]");
  if (!button) return;

  const card = button.closest("[data-integration]");
  const id = card.dataset.integration;
  const action = button.dataset.credentialAction;
  const result = card.querySelector(".credential-result");

  try {
    button.disabled = true;

    if (action === "test") {
      result.textContent = "Testing connection…";
      const data = await api(`/api/admin/integrations/${encodeURIComponent(id)}/test`, {
        method: "POST",
        body: "{}",
      });
      result.textContent = data.message || "Connection test succeeded.";
      showMessage(`${id}: connection test succeeded.`);
    }

    if (action === "test-ebay-deletion") {
      result.textContent = "Testing the public deletion callback through Cloudflare…";
      const data = await api("/api/admin/ebay/account-deletion/test", {
        method: "POST",
        body: "{}",
      });
      result.textContent = data.message || "eBay deletion callback test passed.";
      showMessage("eBay deletion callback challenge test passed.");
    }

    if (action === "sync-rakuten-catalog") {
      result.textContent = "Starting Rakuten Product Catalog sync…";
      const data = await api("/api/admin/rakuten/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ mode: "auto", force: true }),
      });
      result.textContent = data.started
        ? "Product Catalog sync started in the background. Shopper requests keep priority while the feed imports."
        : "A Product Catalog sync is already running.";
      showMessage(data.started ? "Rakuten Product Catalog sync started." : "Rakuten Product Catalog sync is already running.");

      const pollStarted = Date.now();
      const poll = async () => {
        if (!card.isConnected || Date.now() - pollStarted > 120000) return;
        try {
          const status = await api("/api/admin/rakuten/catalog/status");
          if (status.runtime?.running) {
            result.textContent = "Rakuten Product Catalog sync is running in the background…";
            setTimeout(poll, 2500);
            return;
          }
          if (status.runtime?.lastError) {
            result.textContent = `Product Catalog sync failed: ${status.runtime.lastError}`;
            return;
          }
          const totals = status.runtime?.lastResult?.totals || {};
          result.textContent = status.runtime?.lastResult
            ? `Product Catalog sync complete · ${Number(totals.parsed || 0)} products parsed · ${Number(totals.productsCreated || 0)} created · ${Number(totals.offersUpdated || 0)} offers updated${Number(totals.offersRehomed || 0) ? ` · ${Number(totals.offersRehomed || 0)} package variant${Number(totals.offersRehomed || 0) === 1 ? "" : "s"} corrected` : ""}.`
            : "Product Catalog sync finished.";
          await loadAdmin();
        } catch {}
      };
      setTimeout(poll, 1500);
    }

    if (action === "clear") {
      if (!confirm(
        "Clear values saved through Admin for this provider? " +
        "Any matching .env values will become active again."
      )) return;

      await api(`/api/admin/integrations/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      result.textContent = "Admin-saved values cleared.";
      showMessage(`${id}: Admin credential overrides cleared.`);
      await Promise.all([loadIntegrations(), loadAdmin()]);
    }
  } catch (error) {
    result.textContent = error.message;
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
});

function heatBadge(product) {
  const s = product.priceStats || {};
  const cls = s.dealHeat >= 75 ? "hot" : s.dealHeat >= 60 ? "warm" : "";
  return `<span class="heat-badge ${cls}">🔥 ${s.dealHeat || 0} · ${escapeHtml(s.heatLabel || "Watch")}</span>`;
}

function reviewCard(product) {
  const offer = product.bestOffer;
  const s = product.priceStats || {};
  const image = product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="">` : `<div class="mini-art">${escapeHtml((product.category || "?").slice(0, 2).toUpperCase())}</div>`;
  const historyText = s.historyCount >= 2 ? `30d avg ${money(s.average30d, offer?.currency || "USD")} · low ${money(s.low30d, offer?.currency || "USD")}` : `history ${s.historyCount || 0} sample(s)`;

  return `<article class="review-card" data-id="${product.id}">
    <div class="review-head">${image}<div><div class="card-badges">${heatBadge(product)}${s.newLow ? `<span class="new-low">NEW LOW</span>` : ""}<span class="status-pill">${escapeHtml(product.lifecycleState || "ACTIVE")}</span>${product.lifecyclePinned ? `<span class="status-pill live">PINNED</span>` : ""}</div><div class="meta">${escapeHtml(product.category)} · ${product.offers.length} offer(s) · ${product.clicks30d || 0} clicks/30d</div><h3>${escapeHtml(product.title)}</h3>${offer ? `<div class="meta">Top: ${escapeHtml(offer.merchant)} · ${money(offer.price, offer.currency)} · offer ${offer.score.toFixed(1)}/100 · ${historyText}</div>` : ""}</div><span class="status-pill ${product.approved ? "live" : ""}">${product.approved ? "LIVE" : product.lifecycleState === "ARCHIVED" ? "TOMBSTONE" : "DRAFT"}</span></div>
    <div class="edit-grid"><label>Public title</label><input class="title-input" value="${escapeHtml(product.title)}"><label>Category</label><input class="category-input" value="${escapeHtml(product.category)}"><label class="wide">Your original note <span class="muted">— strongly recommended before publishing</span></label><textarea class="note-input wide" rows="3" placeholder="What makes this useful? Who is it for? How does it compare?">${escapeHtml(product.editorNote || "")}</textarea>${product.aiSummary ? `<div class="ai-summary wide"><strong>AI summary:</strong> ${escapeHtml(product.aiSummary)}</div>` : ""}<div class="wide card-actions"><button data-action="save">Save</button>${product.lifecycleState === "ARCHIVED" ? `<button type="button" disabled>Reactivates on rediscovery</button>` : `<button data-action="${product.approved ? "hide" : "approve"}">${product.approved ? "Hide" : "Approve"}</button>`}<button data-action="pin-lifecycle" class="ghost">${product.lifecyclePinned ? "Unpin lifecycle" : "Pin lifecycle"}</button><button data-action="ai" class="ghost">AI enrich</button><button data-action="delete" class="danger ghost">Delete</button>${product.approved ? `<a href="/product.html?id=${product.id}" target="_blank">Open page ↗</a>` : ""}</div></div>
    <details><summary>Offers</summary><div class="admin-offers">${product.offers.map(o => `<div><span><strong>${escapeHtml(o.merchant)}</strong><small>${escapeHtml(o.provider)}</small></span><span>${money(o.price, o.currency)}</span><span>${o.score.toFixed(1)}</span><a href="/go/${o.id}" target="_blank" rel="nofollow sponsored noopener">Open ↗</a></div>`).join("")}</div></details>
  </article>`;
}

function ruleCard(rule) {
  const source = rule.provider === "ebay" ? `Search: ${rule.query || "—"}` : `Advertiser: ${rule.advertiserId || "—"} · ${rule.locale}`;
  const last = rule.lastRunAt ? new Date(rule.lastRunAt).toLocaleString() : "Never";
  const result = rule.lastError ? `<span class="rule-error">${escapeHtml(rule.lastError)}</span>` : rule.lastResult ? `${rule.lastResult.received || 0} offers · ${rule.lastResult.autoApproved || 0} auto-approved` : "No run yet";
  return `<article class="rule-card" data-rule-id="${rule.id}"><div><div class="rule-title"><strong>${escapeHtml(rule.name)}</strong><span class="status-pill ${rule.enabled ? "live" : ""}">${rule.enabled ? "ENABLED" : "PAUSED"}</span></div><div class="meta">
        ${escapeHtml(rule.provider.toUpperCase())} · ${escapeHtml(source)} · limit ${rule.limit}
        ${rule.categoryOverride ? ` · category ${escapeHtml(rule.categoryOverride)}` : ""}
        ${rule.generated ? ` · AUTO-GENERATED · depth ${Number(rule.generationDepth || 0)}` : ""}
        ${Number(rule.stallCount || 0) ? ` · stalled ${Number(rule.stallCount || 0)}x` : ""}
      </div><div class="rule-thresholds"><span>Offer ≥ ${rule.minScore}</span><span>Heat ≥ ${rule.minHeat}</span><span>Discount ≥ ${rule.minDiscount}%</span><span>Commission ≥ ${(rule.minCommissionRate * 100).toFixed(1)}%</span>${rule.autoApprove ? `<span class="auto-pill">AUTO-PUBLISH</span>` : ""}</div><div class="meta">Last run: ${escapeHtml(last)} · ${result}</div></div><div class="rule-actions"><button data-rule-action="run">Run now</button><button data-rule-action="toggle" class="ghost">${rule.enabled ? "Pause" : "Enable"}</button><button data-rule-action="delete" class="ghost danger">Delete</button></div></article>`;
}

function renderEbayApiUsage(usage = {}, rateGuard = {}, verificationDemand = null, capabilities = null) {
  if (verificationDemand && typeof verificationDemand === "object") {
    lastEbayVerificationDemand = verificationDemand;
  }
  verificationDemand = lastEbayVerificationDemand || {};
  if (capabilities && typeof capabilities === "object") {
    lastEbayCapabilities = capabilities;
  }
  capabilities = lastEbayCapabilities || {};
  const bulkCapability = capabilities.bulkGetItems || {};
  const bulkState = String(bulkCapability.state || "unknown");
  const bulkTransport = bulkState === "denied"
    ? "getItem fallback"
    : bulkState === "allowed"
      ? "bulk getItems"
      : bulkState === "probing"
        ? "testing bulk access"
        : "auto-detect";

  const summary = document.querySelector("#ebay-api-usage-summary");
  const endpoints = document.querySelector("#ebay-api-endpoints");
  if (!summary || !endpoints) return;

  const remaining = Number(usage.percentageRemaining || 0);
  const projection = Number(usage.estimatedCallsPerDay || 0);
  const unconstrainedProjection = Number(usage.estimatedUnconstrainedCallsPerDay || projection);
  const configured = Number(usage.configuredDailyAllowance || 0);
  const pressure = [
    rateGuard?.browse?.softLimitMode,
    rateGuard?.getItems?.softLimitMode,
  ].filter(Boolean).join(" / ") || "normal";

  summary.innerHTML = `
    <div class="ebay-metric"><strong>${Number(usage.callsUsedToday || 0).toLocaleString()}</strong><span>Calls used today</span></div>
    <div class="ebay-metric"><strong>${configured.toLocaleString()}</strong><span>Configured daily allowance</span></div>
    <div class="ebay-metric"><strong>${remaining.toFixed(1)}%</strong><span>Quota remaining</span></div>
    <div class="ebay-metric"><strong>${Number(usage.callsThisHour || 0).toLocaleString()}</strong><span>Calls this hour</span></div>
    <div class="ebay-metric"><strong>${Number(usage.cacheHitRate || 0).toFixed(1)}%</strong><span>Cache hit rate</span></div>
    <div class="ebay-metric"><strong>${Number(usage.avoidedCallsToday || 0).toLocaleString()}</strong><span>Calls avoided</span></div>
    <div class="ebay-metric"><strong>${Number(usage.rateLimitEventsToday || 0).toLocaleString()}</strong><span>Rate-limit events</span></div>
    <div class="ebay-metric"><strong>${Number(usage.deferredAttemptsToday || 0).toLocaleString()}</strong><span>Deferred attempts today</span></div>
    <div class="ebay-metric"><strong>${Number(usage.pendingDeferredCalls || 0).toLocaleString()}</strong><span>Unique calls currently blocked</span></div>
    <div class="ebay-metric"><strong>${Number(usage.pendingDeferredUnits || 0).toLocaleString()}</strong><span>Unique blocked work units</span></div>
    <div class="ebay-metric"><strong>${projection.toLocaleString()}</strong><span>Actual call pace/day</span></div>
    <div class="ebay-metric"><strong>${unconstrainedProjection.toLocaleString()}</strong><span>Measured uncapped demand/day</span></div>
    <div class="ebay-metric"><strong>${Number(usage.averageMeasuredUncappedCalls || unconstrainedProjection).toLocaleString()}</strong><span>7-day uncapped average</span></div>
    <div class="ebay-metric"><strong>${Number(usage.peakMeasuredUncappedCalls || unconstrainedProjection).toLocaleString()}</strong><span>7-day uncapped peak</span></div>
  `;

  const rows = Array.isArray(usage.endpoints) ? usage.endpoints : [];
  const browseBucket = usage.buckets?.browse || {};
  const getItemsBucket = usage.buckets?.getItems || {};

  const bucketCard = (label, usageBucket, guardBucket = {}) => {
    const used = Number(usageBucket.callsToday || guardBucket.usedLast24h || 0);
    const allowance = Number(usageBucket.configuredDailyAllowance || guardBucket.configuredLimit || 0);
    const pctRemaining = Number(usageBucket.percentageRemaining || 0);
    const authoritativeKnown = Boolean(guardBucket.remoteKnown);
    const authoritativeRemaining = authoritativeKnown ? guardBucket.remoteRemaining : null;
    const authoritativeLimit = authoritativeKnown ? guardBucket.remoteLimit : null;
    const authoritativeDisplay = authoritativeKnown
      ? `${authoritativeRemaining} / ${authoritativeLimit}`
      : "Not reported · using safe local budget";
    const reset = guardBucket.remoteResetAtIso
      ? new Date(guardBucket.remoteResetAtIso).toLocaleString()
      : "—";
    const cooldown = Number(guardBucket.cooldownUntil || 0) > Date.now()
      ? new Date(Number(guardBucket.cooldownUntil)).toLocaleTimeString()
      : "None";

    return `
      <article class="ebay-quota-card">
        <div class="ebay-quota-card-head">
          <div><span>eBay quota bucket</span><strong>${escapeHtml(label)}</strong></div>
          <b class="ebay-quota-mode">${escapeHtml(String(guardBucket.softLimitMode || "normal").toUpperCase())}</b>
        </div>
        <div class="ebay-quota-main">
          <strong>${used.toLocaleString()} / ${allowance.toLocaleString()}</strong>
          <span>${pctRemaining.toFixed(1)}% configured quota remaining</span>
        </div>
        <div class="ebay-quota-facts">
          <div><span>Interactive left</span><strong>${guardBucket.interactiveRemaining ?? "—"}</strong></div>
          <div><span>Background left</span><strong>${guardBucket.backgroundRemaining ?? "—"}</strong></div>
          <div><span>eBay authoritative</span><strong>${escapeHtml(authoritativeDisplay)}</strong></div>
          <div><span>Deferred attempts today</span><strong>${Number(usageBucket.deferredAttemptsToday || 0).toLocaleString()}</strong></div>
          <div><span>Unique blocked calls</span><strong>${Number(usageBucket.pendingDeferredCalls || 0).toLocaleString()}</strong></div>
          <div><span>Unique blocked units</span><strong>${Number(usageBucket.pendingDeferredUnits || 0).toLocaleString()}</strong></div>
          <div><span>Uncapped demand/day</span><strong>${Number(usageBucket.estimatedUnconstrainedCallsPerDay || usageBucket.callsToday || 0).toLocaleString()}</strong></div>
          <div><span>7-day uncapped avg</span><strong>${Number(usageBucket.averageMeasuredUncappedCalls || usageBucket.estimatedUnconstrainedCallsPerDay || 0).toLocaleString()}</strong></div>
          <div><span>7-day uncapped peak</span><strong>${Number(usageBucket.peakMeasuredUncappedCalls || usageBucket.estimatedUnconstrainedCallsPerDay || 0).toLocaleString()}</strong></div>
          <div><span>Recommended request</span><strong>${Number(usageBucket.recommendedRequestedDailyLimit || allowance || 0).toLocaleString()}/day</strong></div>
          <div><span>Batch fill</span><strong>${Number(usageBucket.batchFillPct || 0).toFixed(1)}%</strong></div>
          ${label === "getItems" ? `<div><span>Items / API call</span><strong>${Number(usageBucket.averageUnitsPerCall || 0).toFixed(1)}</strong></div>` : ""}
          ${label === "getItems" ? `<div><span>Bulk calls saved</span><strong>${Number(usageBucket.bulkCallsSavedVsOneItem || 0).toLocaleString()}</strong></div>` : ""}
          <div><span>Reset</span><strong>${escapeHtml(reset)}</strong></div>
          <div><span>Cooldown</span><strong>${escapeHtml(cooldown)}</strong></div>
          <div><span>429 hits</span><strong>${Number(guardBucket.remoteRateLimitHits || 0)}</strong></div>
        </div>
      </article>
    `;
  };

  const endpointRows = rows.length
    ? rows.map(row => `
        <div class="ebay-endpoint-row">
          <strong>${escapeHtml(row.endpoint)}</strong>
          <span>${Number(row.callsToday || 0).toLocaleString()}</span>
          <span>${Number(row.callsThisHour || 0).toLocaleString()}</span>
          <span>${Number(row.peakHourlyCalls || 0).toLocaleString()}/hr</span>
          <span>${Number(row.peakDailyCalls || 0).toLocaleString()}/day</span>
          <span>${Number(row.cacheHitRate || 0).toFixed(1)}%</span>
          <span>${Number(row.avoidedCallsToday || 0).toLocaleString()}</span>
          <span>${Number(row.deferredAttemptsToday || 0).toLocaleString()}</span>
          <span>${Number(row.pendingDeferredCalls || 0).toLocaleString()}</span>
          <span>${Number(row.batchFillPct || 0).toFixed(1)}%</span>
          <span>${Number(row.rateLimitResponsesToday || 0).toLocaleString()}</span>
        </div>
      `).join("")
    : `<div class="ebay-endpoint-empty">No eBay API calls recorded yet. Metrics will populate after the first request.</div>`;

  const demandHistory = Array.isArray(usage.demandHistory) ? usage.demandHistory : [];
  const demandHistoryRows = demandHistory.length
    ? [...demandHistory].reverse().map(day => `
        <div class="ebay-demand-row">
          <strong>${escapeHtml(day.dayUtc || "—")}</strong>
          <span>${Number(day.buckets?.browse?.actualCalls || 0).toLocaleString()}</span>
          <span>${Number(day.buckets?.browse?.unresolvedShadowCalls || 0).toLocaleString()}</span>
          <span>${Number(day.buckets?.browse?.measuredUncappedCalls || 0).toLocaleString()}</span>
          <span>${Number(day.buckets?.getItems?.actualCalls || 0).toLocaleString()}</span>
          <span>${Number(day.buckets?.getItems?.unresolvedShadowCalls || 0).toLocaleString()}</span>
          <span>${Number(day.buckets?.getItems?.measuredUncappedCalls || 0).toLocaleString()}</span>
        </div>
      `).join("")
    : `<div class="ebay-endpoint-empty">Daily quota evidence will appear after eBay work is measured.</div>`;

  endpoints.innerHTML = `
    <div class="ebay-quota-grid">
      ${bucketCard("Browse", browseBucket, rateGuard?.browse || {})}
      ${bucketCard("getItems", getItemsBucket, rateGuard?.getItems || {})}
    </div>

    <div class="ebay-api-meta-grid">
      <div><span>Adaptive quota mode</span><strong>${escapeHtml(pressure.toUpperCase())}</strong></div>
      <div><span>Growth Check threshold</span><strong>${usage.growthCheckSuggested ? "YES" : "NO"}</strong></div>
      <div><span>Failed calls today</span><strong>${Number(usage.failedCallsToday || 0).toLocaleString()}</strong></div>
      <div><span>Infrastructure retries</span><strong>${Number(usage.retriesToday || 0).toLocaleString()}</strong></div>
      <div><span>Unverified unique eBay listings</span><strong>${Number(verificationDemand.exactUnverifiedUniqueListings || 0).toLocaleString()}</strong></div>
      <div><span>Minimum calls to clear backlog</span><strong>${Number(verificationDemand.minimumCallsToClearUnverifiedBacklog || 0).toLocaleString()}</strong></div>
      <div><span>Full active refresh sweep</span><strong>${Number(verificationDemand.minimumCallsForFullRefreshSweep || 0).toLocaleString()} calls</strong></div>
      <div><span>Quota request headroom</span><strong>${Number(usage.quotaRequestHeadroomMultiplier || 1.5).toFixed(2)}×</strong></div>
      <div><span>Exact-detail transport</span><strong>${escapeHtml(bulkTransport)}</strong></div>
      <div><span>Verification catch-up mode</span><strong>${bulkCapability.fallbackActive ? escapeHtml(String(bulkCapability.fallbackAdaptiveMode || "normal").toUpperCase()) : "—"}</strong></div>
      <div><span>Competitor identity backlog</span><strong>${bulkCapability.fallbackActive ? Number(bulkCapability.fallbackIdentityBacklog || 0).toLocaleString() : "—"}</strong></div>
      <div><span>Fallback window budget</span><strong>${bulkCapability.fallbackActive ? Number(bulkCapability.fallbackWindowBudget || 0).toLocaleString() : "—"}</strong></div>
      <div><span>Fallback identity budget left</span><strong>${bulkCapability.fallbackActive ? Number(bulkCapability.fallbackIdentityWindowRemaining || 0).toLocaleString() : "—"}</strong></div>
      <div><span>Fallback price budget left</span><strong>${bulkCapability.fallbackActive ? Number(bulkCapability.fallbackPriceWindowRemaining || 0).toLocaleString() : "—"}</strong></div>
    </div>

    <div class="ebay-demand-history-head"><strong>7-day quota evidence</strong><span>Actual calls + unresolved unique shadow demand</span></div>
    <div class="ebay-demand-table-wrap">
      <div class="ebay-demand-table" role="table" aria-label="eBay seven-day quota demand evidence">
        <div class="ebay-demand-row ebay-endpoint-header" role="row">
          <strong>UTC day</strong><span>Browse actual</span><span>Browse blocked</span><span>Browse uncapped</span><span>getItems actual</span><span>getItems blocked</span><span>getItems uncapped</span>
        </div>
        ${demandHistoryRows}
      </div>
    </div>

    <div class="ebay-endpoint-table-wrap">
      <div class="ebay-endpoint-table" role="table" aria-label="eBay API endpoint counters">
        <div class="ebay-endpoint-row ebay-endpoint-header" role="row">
          <strong>Endpoint</strong><span>Today</span><span>Hour</span><span>Peak/hr</span><span>Peak/day</span><span>Cache</span><span>Avoided</span><span>Deferred</span><span>Pending</span><span>Fill</span><span>429</span>
        </div>
        ${endpointRows}
      </div>
    </div>
  `;
}

function visitorGeoRows(geolocation = {}, windowName = "live") {
  if (windowName === "live") {
    return (geolocation.activeLocations || [])
      .map(row => ({ ...row, mapCount: Number(row.activeUsers || 0), observationCount: Number(row.activeUsers || 0) }))
      .filter(row => row.mapCount > 0);
  }
  const suffix = windowName === "24h" ? "24h" : windowName === "7d" ? "7d" : "30d";
  return (geolocation.historyLocations || [])
    .map(row => ({
      ...row,
      mapCount: Number(row[`uniqueVisitors${suffix}`] || 0),
      observationCount: Number(row[`observations${suffix}`] || 0),
    }))
    .filter(row => row.mapCount > 0);
}

function relativeTime(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function visitorWorldMap(rows = [], windowName = "live") {
  const width = 1000;
  const height = 500;
  const points = rows.map(row => {
    const latitude = Math.max(-90, Math.min(90, Number(row.latitude || 0)));
    const longitude = Math.max(-180, Math.min(180, Number(row.longitude || 0)));
    const x = ((longitude + 180) / 360) * width;
    const y = ((90 - latitude) / 180) * height;
    const radius = Math.min(18, 5 + Math.sqrt(Math.max(1, Number(row.mapCount || 1))) * 2.6);
    const label = `${row.label || "Approximate location"}: ${Number(row.mapCount || 0).toLocaleString()} ${windowName === "live" ? "currently connected" : "unique visitors"}`;
    return `
      <g class="visitor-geo-pin ${windowName === "live" ? "live" : "history"}" transform="translate(${x.toFixed(2)} ${y.toFixed(2)})">
        <title>${escapeHtml(label)}</title>
        <circle class="visitor-geo-pin-halo" r="${(radius + 6).toFixed(1)}"></circle>
        <circle class="visitor-geo-pin-core" r="${radius.toFixed(1)}"></circle>
        <text y="4">${Number(row.mapCount || 0).toLocaleString()}</text>
      </g>`;
  }).join("");

  return `
    <svg viewBox="0 0 1000 500" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="visitor-map-ocean" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#071523"></stop>
          <stop offset="1" stop-color="#091b2c"></stop>
        </linearGradient>
      </defs>
      <rect class="visitor-geo-ocean" width="1000" height="500" rx="24"></rect>
      <g class="visitor-geo-grid-lines">
        <path d="M0 125H1000M0 250H1000M0 375H1000"></path>
        <path d="M250 0V500M500 0V500M750 0V500"></path>
      </g>
      <g class="visitor-geo-land">
        <path d="M40 86L94 49 166 45 223 66 279 91 326 126 310 155 278 169 259 203 226 213 202 184 169 172 143 144 101 133 66 111Z"></path>
        <path d="M237 199L270 214 292 249 305 286 289 329 267 376 246 414 229 374 219 326 207 278 215 235Z"></path>
        <path d="M337 50L381 43 405 70 388 105 349 111 326 82Z"></path>
        <path d="M438 116L474 92 526 87 566 70 630 76 683 66 750 82 815 105 882 117 934 147 918 179 860 176 813 195 760 181 713 201 660 190 618 161 572 165 536 145 493 154 459 143Z"></path>
        <path d="M478 166L524 157 563 181 579 225 562 276 536 327 505 348 481 309 462 261 451 211Z"></path>
        <path d="M795 333L832 315 880 325 912 354 895 391 847 405 807 382 780 354Z"></path>
        <path d="M948 303L962 296 970 314 956 329Z"></path>
        <path d="M0 459L94 446 206 452 321 442 444 450 568 440 702 450 828 443 1000 458V500H0Z"></path>
      </g>
      <g class="visitor-geo-map-labels">
        <text x="145" y="122">NORTH AMERICA</text><text x="235" y="300">SOUTH AMERICA</text>
        <text x="492" y="133">EUROPE</text><text x="497" y="248">AFRICA</text>
        <text x="707" y="133">ASIA</text><text x="823" y="365">OCEANIA</text>
      </g>
      <g class="visitor-geo-pins">${points}</g>
    </svg>
    ${rows.length ? "" : `<div class="visitor-geo-empty">No mapped visitors in this window yet.</div>`}`;
}

function renderVisitorGeolocation(visitors = {}) {
  const geolocation = visitors.geolocation || {};
  const map = document.querySelector("#visitor-geo-map");
  const summary = document.querySelector("#visitor-geo-summary");
  const list = document.querySelector("#visitor-geo-list");
  const status = document.querySelector("#visitor-geo-status");
  const note = document.querySelector("#visitor-geo-note");
  if (!map || !summary || !list || !status || !note) return;

  const rows = visitorGeoRows(geolocation, visitorGeoWindow);
  const total = rows.reduce((sum, row) => sum + Number(row.mapCount || 0), 0);
  const observations = rows.reduce((sum, row) => sum + Number(row.observationCount || 0), 0);
  const windowLabel = visitorGeoWindow === "live"
    ? "currently connected"
    : visitorGeoWindow === "24h" ? "last 24 hours" : visitorGeoWindow === "7d" ? "last 7 days" : "last 30 days";

  map.innerHTML = visitorWorldMap(rows, visitorGeoWindow);
  map.setAttribute("aria-label", `${total.toLocaleString()} mapped visitor${total === 1 ? "" : "s"}, ${windowLabel}`);
  summary.innerHTML = `
    <div><strong>${total.toLocaleString()}</strong><span>${visitorGeoWindow === "live" ? "Mapped now" : "Unique mapped"}</span></div>
    <div><strong>${rows.length.toLocaleString()}</strong><span>Approx. locations</span></div>
    <div><strong>${observations.toLocaleString()}</strong><span>${visitorGeoWindow === "live" ? "Active browsers" : "Location observations"}</span></div>`;

  list.innerHTML = rows.length
    ? rows.slice(0, 30).map(row => `
        <div class="visitor-geo-row">
          <span class="visitor-geo-row-dot ${visitorGeoWindow === "live" ? "live" : "history"}" aria-hidden="true"></span>
          <span><strong>${escapeHtml(row.label || "Approximate location")}</strong><small>${Number(row.latitude).toFixed(2)}, ${Number(row.longitude).toFixed(2)} · ${escapeHtml(relativeTime(row.lastSeenAt))}</small></span>
          <b>${Number(row.mapCount || 0).toLocaleString()}</b>
        </div>`).join("")
    : `<p class="muted">No approximate location records in the ${escapeHtml(windowLabel)} window.</p>`;

  status.classList.toggle("live", visitorGeoWindow === "live" && total > 0);
  status.textContent = !geolocation.enabled
    ? "LOCATION HISTORY OFF"
    : total > 0
      ? visitorGeoWindow === "live" ? `${total.toLocaleString()} LIVE MAPPED` : `${total.toLocaleString()} IN HISTORY`
      : "WAITING FOR EDGE DATA";

  const unlocated = Number(geolocation.activeUnlocatedUsers || 0);
  note.textContent = !geolocation.enabled
    ? "Location collection is disabled by VISITOR_GEOLOCATION_ENABLED."
    : !geolocation.lastObservedAt
      ? "No location headers have reached OfferGrid yet. Enable Cloudflare’s “Add visitor location headers” Managed Transform, then open a public page through the Cloudflare hostname."
      : `${unlocated.toLocaleString()} currently connected browser${unlocated === 1 ? " is" : "s are"} not mapped. Approximate coordinates are rounded to two decimals and retained for ${Number(geolocation.retentionDays || 30)} days.`;
}

function wireVisitorGeoControls() {
  document.querySelectorAll("[data-geo-window]").forEach(button => {
    button.addEventListener("click", () => {
      visitorGeoWindow = button.dataset.geoWindow || "live";
      document.querySelectorAll("[data-geo-window]").forEach(candidate => {
        const active = candidate === button;
        candidate.classList.toggle("active", active);
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderVisitorGeolocation(lastVisitorAnalytics);
    });
  });
}

wireVisitorGeoControls();

function renderVisitorAnalytics(visitors = {}) {
  lastVisitorAnalytics = { ...lastVisitorAnalytics, ...(visitors || {}) };
  const current = document.querySelector("#currently-connected-users");
  const historical = document.querySelector("#historically-unique-users");
  const returning30d = document.querySelector("#returning-visitors-30d");
  const unique30d = document.querySelector("#unique-visitors-30d");
  const firstTime30d = document.querySelector("#first-time-visitors-30d");
  const returnRate30d = document.querySelector("#visitor-return-rate-30d");
  const retentionNote = document.querySelector("#visitor-retention-note");

  if (current) current.textContent = Number(lastVisitorAnalytics.currentlyConnectedUsers || 0).toLocaleString();
  if (historical) historical.textContent = Number(lastVisitorAnalytics.historicallyUniqueUsers || 0).toLocaleString();
  if (returning30d) returning30d.textContent = Number(lastVisitorAnalytics.returningVisitors30d || 0).toLocaleString();
  if (unique30d) unique30d.textContent = Number(lastVisitorAnalytics.uniqueVisitors30d || 0).toLocaleString();
  if (firstTime30d) firstTime30d.textContent = Number(lastVisitorAnalytics.firstTimeVisitors30d || 0).toLocaleString();
  if (returnRate30d) returnRate30d.textContent = `${Number(lastVisitorAnalytics.returnRate30d || 0).toFixed(1)}%`;

  if (retentionNote) {
    const trackingStartedAt = lastVisitorAnalytics.returnTrackingStartedAt
      ? new Date(lastVisitorAnalytics.returnTrackingStartedAt)
      : null;
    const trackingLabel = trackingStartedAt && Number.isFinite(trackingStartedAt.getTime())
      ? trackingStartedAt.toLocaleString()
      : "the first public visit after this upgrade";
    const gapMinutes = Number(lastVisitorAnalytics.returnVisitGapMinutes || 30);
    retentionNote.textContent =
      `Timed return tracking started ${trackingLabel}. A return means a known anonymous browser is seen again after at least ${gapMinutes.toLocaleString()} minutes away. ` +
      `The historical unique total predates timed retention tracking, so the rolling 30-day metrics become fully representative after 30 days.`;
  }
  renderVisitorGeolocation(lastVisitorAnalytics);
}

async function refreshVisitorAnalytics() {
  if (visitorAnalyticsRefreshing || document.hidden || adminApp?.classList.contains("hidden")) return;
  visitorAnalyticsRefreshing = true;
  try {
    const data = await api("/api/admin/visitors");
    renderVisitorAnalytics(data.visitors || {});
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("admin login required")) {
      stopVisitorAnalyticsPolling();
    }
  } finally {
    visitorAnalyticsRefreshing = false;
  }
}

function stopVisitorAnalyticsPolling() {
  if (visitorAnalyticsTimer) clearInterval(visitorAnalyticsTimer);
  visitorAnalyticsTimer = null;
  visitorAnalyticsRefreshing = false;
}

function startVisitorAnalyticsPolling() {
  stopVisitorAnalyticsPolling();
  refreshVisitorAnalytics().catch(() => {});
  visitorAnalyticsTimer = setInterval(() => {
    refreshVisitorAnalytics().catch(() => {});
  }, VISITOR_ANALYTICS_REFRESH_MS);
}

function renderTrafficBreakdown(rows = [], emptyMessage = "No attributed traffic yet.") {
  if (!rows.length) return `<p class="muted">${escapeHtml(emptyMessage)}</p>`;
  return `
    <div class="campaign-table" role="table">
      <div class="campaign-row campaign-row-head" role="row"><strong>Label</strong><span>Visits</span><span>Unique</span><span>Clicks</span><span>CTR</span></div>
      ${rows.slice(0, 20).map(row => `
        <div class="campaign-row" role="row">
          <strong>${escapeHtml(row.key || "(unattributed)")}</strong>
          <span>${Number(row.visits || 0).toLocaleString()}</span>
          <span>${Number(row.uniqueVisitors || 0).toLocaleString()}</span>
          <span>${Number(row.outboundClicks || 0).toLocaleString()}</span>
          <span>${Number(row.clickThroughRate || 0).toFixed(1)}%</span>
        </div>
      `).join("")}
    </div>`;
}

function renderCommissionBreakdown(rows = [], label = "Network") {
  if (!rows.length) return `<p class="muted">No commission transactions imported yet.</p>`;
  return `
    <div class="campaign-table commission-table" role="table">
      <div class="campaign-row campaign-row-head" role="row"><strong>${escapeHtml(label)}</strong><span>Transactions</span><span>Approved</span><span>Pending</span><span>Reversed</span></div>
      ${rows.slice(0, 20).map(row => `
        <div class="campaign-row" role="row">
          <strong>${escapeHtml(row.key || "(unattributed)")}</strong>
          <span>${Number(row.transactions || 0).toLocaleString()}</span>
          <span>${money(row.approvedCommission || 0)}</span>
          <span>${money(row.pendingCommission || 0)}</span>
          <span>${money(row.reversedCommission || 0)}</span>
        </div>
      `).join("")}
    </div>`;
}

function renderMarketingAnalytics(data = {}) {
  const marketing = data.marketing || {};
  const commissions = data.commissions || {};
  const marketingSummary = document.querySelector("#marketing-summary");
  const attributionNote = document.querySelector("#marketing-attribution-note");
  const commissionSummary = document.querySelector("#commission-summary");
  if (marketingSummary) {
    marketingSummary.innerHTML = `
      <div><strong>${Number(marketing.visits || 0).toLocaleString()}</strong><span>Visits · ${Number(marketing.days || 30)}d</span></div>
      <div><strong>${Number(marketing.uniqueVisitors || 0).toLocaleString()}</strong><span>Unique visitors</span></div>
      <div><strong>${Number(marketing.outboundClicks || 0).toLocaleString()}</strong><span>Outbound clicks</span></div>
      <div><strong>${Number(marketing.clickThroughRate || 0).toFixed(1)}%</strong><span>Visit-to-click rate</span></div>`;
  }
  if (attributionNote) {
    const attributed = Number(marketing.attributedVisits || 0);
    const untagged = Number(marketing.unattributedVisits || 0);
    const areaTagged = Number(marketing.areaTaggedVisits || 0);
    attributionNote.innerHTML = `
      <strong>${areaTagged.toLocaleString()} Dallas placement visit${areaTagged === 1 ? "" : "s"}</strong>
      <span>${attributed.toLocaleString()} campaign-tagged · ${untagged.toLocaleString()} direct/untagged. Dallas placement totals come from <code>/dallas/area-1</code>, <code>/dallas/area-2</code>, and <code>/dallas/area-3</code>—not IP geolocation.</span>`;
  }
  if (commissionSummary) {
    commissionSummary.innerHTML = `
      <div><strong>${money(commissions.approvedCommission || 0)}</strong><span>Approved · ${Number(commissions.days || 90)}d</span></div>
      <div><strong>${money(commissions.pendingCommission || 0)}</strong><span>Pending</span></div>
      <div><strong>${money(commissions.reversedCommission || 0)}</strong><span>Reversed / declined</span></div>
      <div><strong>${Number(commissions.transactions || 0).toLocaleString()}</strong><span>Transactions</span></div>`;
  }
  const campaign = document.querySelector("#campaign-breakdown");
  const area = document.querySelector("#area-breakdown");
  const commission = document.querySelector("#commission-breakdown");
  if (campaign) campaign.innerHTML = renderTrafficBreakdown(marketing.byCampaign || [], "No campaign-tagged traffic yet.");
  if (area) area.innerHTML = renderTrafficBreakdown(marketing.byArea || [], "No area-tagged traffic yet.");
  if (commission) commission.innerHTML = `
    <section><h4>By affiliate network</h4>${renderCommissionBreakdown(commissions.byNetwork || [], "Network")}</section>
    <section><h4>By campaign</h4>${renderCommissionBreakdown(commissions.byCampaign || [], "Campaign")}</section>
    <section><h4>By Dallas area</h4>${renderCommissionBreakdown(commissions.byArea || [], "Area")}</section>`;
}

async function refreshMarketingAnalytics() {
  const data = await api("/api/admin/marketing?days=30&commissionDays=90");
  renderMarketingAnalytics(data);
}

async function loadAdmin() {
  const data = await api("/api/admin/catalog");
  document.querySelector("#stats").innerHTML = `<div><strong>${data.stats.liveCatalogProducts ?? data.stats.products}</strong><span>Live catalog</span></div><div><strong>${data.stats.archivedProducts || 0}</strong><span>Archived identities</span></div><div><strong>${data.stats.offers}</strong><span>Offers</span></div><div><strong>${(data.stats.historyPoints || 0) + (data.stats.priceAggregates || 0)}</strong><span>Price history rows</span></div>`;
  document.querySelector("#analytics").innerHTML = `<div><strong>${data.analytics.clicks24h}</strong><span>Clicks 24h</span></div><div><strong>${data.analytics.clicks7d}</strong><span>Clicks 7d</span></div><div><strong>${data.analytics.clicks30d}</strong><span>Clicks 30d</span></div><div><strong>${data.analytics.totalClicks}</strong><span>Total clicks</span></div><div><strong id="currently-connected-users">${Number(data.visitors?.currentlyConnectedUsers || 0).toLocaleString()}</strong><span>Currently connected users</span></div><div><strong id="historically-unique-users">${Number(data.visitors?.historicallyUniqueUsers || 0).toLocaleString()}</strong><span>Historically unique users</span></div>`;
  renderVisitorAnalytics(data.visitors || {});
  document.querySelector("#top-clicks").innerHTML = data.analytics.topProducts.length ? data.analytics.topProducts.map(p => `<span>${escapeHtml(p.title)} <b>${p.clicks}</b></span>`).join("") : `<span class="muted">No outbound clicks recorded yet.</span>`;
  const clickResetNote = document.querySelector("#click-reset-note");
  if (clickResetNote) {
    clickResetNote.textContent = data.analytics.resetAt
      ? `Counters are measured since ${new Date(data.analytics.resetAt).toLocaleString()}. Historical click evidence is retained for lifecycle accuracy.`
      : "Counters currently include all recorded outbound clicks.";
  }
  const campaignModeStatus = document.querySelector("#campaign-mode-status");
  if (campaignModeStatus) {
    campaignModeStatus.classList.toggle("live", Boolean(data.campaignTrafficMode));
    campaignModeStatus.textContent = data.campaignTrafficMode ? "PAID TRAFFIC PROTECTION ON" : "CAMPAIGN MODE OFF";
  }

  const i = data.integrations;
  document.querySelector("#integration-status").innerHTML = [
    integrationChip("Squirrel", i.squirrel),
    integrationChip(
      `eBay ${i.ebayEnvironment === "sandbox" ? "Sandbox" : "Production"}`,
      i.ebay
    ),
    integrationChip("eBay affiliate", i.ebayAffiliate, i.ebay && !i.ebayAffiliate),
    integrationChip("Best Buy", i.bestbuy),
    integrationChip("UPCitemdb", i.upcitemdb),
    integrationChip("Open Facts", i.openfacts),
    integrationChip("Awin", i.awin),
    integrationChip("Rakuten API", i.rakuten),
    integrationChip("Rakuten Catalog", i.rakutenCatalog),
    integrationChip("Amazon", i.amazon),
    integrationChip("OpenAI", i.openai),
    integrationChip("AdSense", i.adsense),
    integrationChip("Auto-discovery", i.autoSync),
    integrationChip("eBay competitor scan", i.ebayCompetitorScan)
  ].join("");

  const automation = data.automation || {};
  const automationDetails = document.querySelector("#automation-details");
  if (automationDetails) {
    const coverage = automation.competitorCoverage || {};
    const sanitizer = automation.competitorSanitizer || {};
    const browseGuard = automation.rateGuard?.browse || {};
    const getItemsGuard = automation.rateGuard?.getItems || {};
    const lifecycle = automation.lifecycle || {};
    const integrity = automation.integrity || {};
    const draftReview = automation.draftAutoReview || {};
    const localCleanup = automation.localDatabaseCleanup || {};

    const groups = [
      automationGroup(
        "Catalog + discovery",
        "Catalog growth and marketplace ingestion",
        [
          automationMetric(`${automation.catalogProducts || 0}/${automation.catalogTarget || 10000}`, "catalog target"),
          automationMetric(automation.totalRules || 0, "discovery searches"),
          automationMetric(automation.generatedRules || 0, "auto-generated searches"),
          automationMetric(`${automation.discoveryMinutes || 0} min`, "growth interval"),
          automationMetric(automation.rakutenCatalog?.state?.merchantCount || 0, "Rakuten advertisers synced"),
          automationMetric(automation.rakutenCatalog?.runtime?.running ? "RUNNING" : "IDLE", "Rakuten catalog sync"),
        ]
      ),
      automationGroup(
        "eBay competitor coverage",
        "One-seller products are intentionally prioritized",
        [
          automationMetric(
            coverage.multiVerifiedEbayListings || 0,
            "products with 2+ verified eBay sellers",
            { tone: Number(coverage.multiVerifiedEbayListings || 0) > 0 ? "good" : "" }
          ),
          automationMetric(coverage.oneVerifiedEbayListing || 0, "products with exactly 1 verified eBay seller", { tone: "attention" }),
          automationMetric(coverage.zeroVerifiedEbayListings || 0, "public products with 0 verified eBay sellers"),
          automationMetric(coverage.pendingListings || 0, "seller candidates awaiting exact verification", { tone: Number(coverage.pendingListings || 0) > 0 ? "pending" : "" }),
          automationMetric(`${Number(coverage.multiSellerCoveragePct || 0).toFixed(1)}%`, "multi-seller coverage"),
          automationMetric(`${automation.competitorMinutes || 10} min`, "discovery scheduler"),
          automationMetric(`${automation.competitorRescanMinutes || 60} min`, "same-product rescan floor"),
          automationMetric(automation.competitorProductsPerRun || 0, "max products per pass"),
          automationMetric(automation.competitorResultsPerSearch || 100, "seller candidates requested per Browse search"),
        ]
      ),
      automationGroup(
        "eBay quota + exact verification",
        "Browse discovers candidates; exact detail uses bulk getItems when entitled or quota-aware getItem fallback",
        [
          automationMetric(`${browseGuard.backgroundRemaining ?? "—"}`, "Browse background calls left"),
          automationMetric(`${browseGuard.interactiveRemaining ?? "—"}`, "Browse interactive calls left"),
          automationMetric(`${getItemsGuard.backgroundRemaining ?? "—"}`, "getItems background calls left"),
          automationMetric(`${getItemsGuard.interactiveRemaining ?? "—"}`, "getItems interactive calls left"),
          automationMetric(sanitizer.pending || 0, "pending competitor listings"),
          automationMetric(sanitizer.eligiblePending || 0, "pending eligible for exact-detail verification", { tone: Number(sanitizer.eligiblePending || 0) > 0 ? "pending" : "" }),
          automationMetric(sanitizer.identityBlockedPending || 0, "pending waiting for stronger product identity"),
          automationMetric(sanitizer.retryDeferredPending || 0, "pending in exact-detail retry backoff"),
          automationMetric(`${sanitizer.lastVerified || 0}/${sanitizer.lastSelected || 0}`, "verified / selected last sanitizer pass"),
          automationMetric(`${sanitizer.lastApiCalls || 0}/${sanitizer.lastCallBudget || 0}`, "exact-detail calls / sanitizer budget"),
          automationMetric(integrity.unverifiedPublicEbayOffers || 0, "source eBay offers awaiting exact verification"),
        ]
      ),
      automationGroup(
        "Automation health",
        "Foreground shopper traffic still outranks background work",
        [
          automationMetric(draftReview.enabled ? "ON" : "OFF", "confident draft auto-review"),
          automationMetric(draftReview.recentUnlockedDrafts || 0, "recent drafts eligible"),
          automationMetric(data.responsiveness?.activeInteractiveRequests || 0, "active user-priority requests"),
          automationMetric(data.responsiveness?.backgroundPauseCount || 0, "background pauses for shoppers"),
          automationMetric(`${Number(data.responsiveness?.eventLoopDelayP95Ms || 0).toFixed(1)} ms`, "event-loop delay p95"),
          automationMetric(`${Number(data.responsiveness?.eventLoopDelayMaxMs || 0).toFixed(1)} ms`, "event-loop delay max"),
        ]
      ),
      automationGroup(
        "Lifecycle + cleanup",
        "Long-term catalog retention and trust cleanup",
        [
          automationMetric(lifecycle.counts?.ACTIVE || 0, "ACTIVE products"),
          automationMetric(lifecycle.counts?.DORMANT || 0, "DORMANT products"),
          automationMetric(lifecycle.counts?.STALE || 0, "STALE products"),
          automationMetric(lifecycle.counts?.ARCHIVED || 0, "archived tombstones"),
          automationMetric(automation.cleanup?.pending ?? sanitizer.pending ?? 0, "competitor offers pending proof"),
          automationMetric(automation.cleanup?.lastRemoved || 0, "unsafe competitors removed last audit"),
          automationMetric(integrity.invalidCanonicalProducts || 0, "invalid strong canonical owners", { tone: Number(integrity.invalidCanonicalProducts || 0) > 0 ? "attention" : "good" }),
          automationMetric(integrity.invalidStoredGtins || 0, "invalid stored GTINs", { tone: Number(integrity.invalidStoredGtins || 0) > 0 ? "attention" : "good" }),
          automationMetric(integrity.invalidStoredMpns || 0, "invalid stored MPNs", { tone: Number(integrity.invalidStoredMpns || 0) > 0 ? "attention" : "good" }),
          automationMetric(integrity.invalidStoredEpids || 0, "invalid stored ePIDs", { tone: Number(integrity.invalidStoredEpids || 0) > 0 ? "attention" : "good" }),
          automationMetric(integrity.rejectedAffiliateUrls || 0, "unsafe affiliate URLs quarantined", { tone: Number(integrity.rejectedAffiliateUrls || 0) > 0 ? "attention" : "good" }),
          automationMetric(integrity.duplicateCanonicalProducts || 0, "duplicate strong canonical groups", { tone: Number(integrity.duplicateCanonicalProducts || 0) > 0 ? "attention" : "good" }),
          automationMetric(localCleanup.lastTouched || 0, "products touched by last local normalization"),
          automationMetric(localCleanup.report?.strongEvidenceListingDuplicatesMerged || 0, "strong-evidence duplicate products merged last pass", { tone: Number(localCleanup.report?.strongEvidenceListingDuplicatesMerged || 0) > 0 ? "good" : "" }),
          automationMetric(localDateOrDash(localCleanup.lastRunAt), "local normalization last run"),
          automationMetric(`${lifecycle.rawPricePoints || 0}`, "raw price observations"),
        ]
      ),
    ];

    automationDetails.innerHTML = groups.join("");
  }


  renderEbayApiUsage(
    automation.ebayApiUsage || {},
    automation.rateGuard || {},
    automation.ebayVerificationDemand || {}
  );

  rulesList.innerHTML = data.rules.length ? data.rules.map(ruleCard).join("") : `<div class="empty"><h3>No discovery rules yet.</h3><p>Create one below to automate product hunting.</p></div>`;
  reviewList.innerHTML = data.products.length ? data.products.map(reviewCard).join("") : `<div class="empty"><h3>Nothing imported yet.</h3><p>Load demo data, import manually, or run a discovery rule.</p></div>`;
  adminHasUnsavedEdits = false;
  updateAdminFoldCount("rules", data.rules.length);
  updateAdminFoldCount("products", data.products.length);
}

async function refreshEbayTelemetry() {
  if (ebayTelemetryRefreshing || document.hidden || adminApp?.classList.contains("hidden")) return;
  ebayTelemetryRefreshing = true;
  try {
    const data = await api("/api/admin/ebay/usage?light=1");
    renderEbayApiUsage(
      data.usage || {},
      data.rateGuard || {},
      null,
      data.capabilities || {}
    );
  } catch (error) {
    if (String(error?.message || "").toLowerCase().includes("admin login required")) {
      stopEbayTelemetryPolling();
    }
  } finally {
    ebayTelemetryRefreshing = false;
  }
}

function stopEbayTelemetryPolling() {
  if (ebayTelemetryTimer) clearInterval(ebayTelemetryTimer);
  ebayTelemetryTimer = null;
  ebayTelemetryRefreshing = false;
}

function startEbayTelemetryPolling() {
  stopEbayTelemetryPolling();
  refreshEbayTelemetry().catch(() => {});
  ebayTelemetryTimer = setInterval(() => {
    refreshEbayTelemetry().catch(() => {});
  }, EBAY_TELEMETRY_REFRESH_MS);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!adminApp?.classList.contains("hidden")) {
    refreshEbayTelemetry().catch(() => {});
    refreshVisitorAnalytics().catch(() => {});
    refreshMarketingAnalytics().catch(() => {});
  }
});

async function checkAuth() {
  const status = await api("/api/admin/status");
  loginPanel.classList.toggle("hidden", status.authenticated);
  adminApp.classList.toggle("hidden", !status.authenticated);
  if (status.authenticated) {
    await Promise.all([loadAdmin(), loadIntegrations(), refreshMarketingAnalytics()]);
    connectAdminLive();
    startEbayTelemetryPolling();
    startVisitorAnalyticsPolling();
  } else {
    stopEbayTelemetryPolling();
    stopVisitorAnalyticsPolling();
    adminLiveSource?.close?.();
    adminLiveSource = null;
    setAdminLiveStatus("reconnecting", "OFFLINE");
  }
}

document.querySelector("#login-form").addEventListener("submit", async event => { event.preventDefault(); const error = document.querySelector("#login-error"); error.textContent = ""; try { await api("/api/admin/login", { method: "POST", body: JSON.stringify({ password: document.querySelector("#password").value }) }); await checkAuth(); } catch (e) { error.textContent = e.message; } });
document.querySelector("#logout").addEventListener("click", async () => { stopEbayTelemetryPolling(); stopVisitorAnalyticsPolling(); adminLiveSource?.close?.(); adminLiveSource = null; await api("/api/admin/logout", { method: "POST" }); location.reload(); });
document.querySelector("#refresh").addEventListener("click", () => loadAdmin().catch(e => showMessage(e.message, "error")));

document.querySelector("#reset-clicks")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  if (!confirm("Reset the visible click counters to zero? Historical click evidence will be retained for OfferGrid lifecycle accuracy.")) return;
  try {
    button.disabled = true;
    const data = await api("/api/admin/analytics/reset-clicks", { method: "POST", body: "{}" });
    showMessage(`Click counters reset${data.analytics?.resetAt ? ` at ${new Date(data.analytics.resetAt).toLocaleString()}` : ""}.`, "success");
    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#commission-import-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const file = document.querySelector("#commission-file")?.files?.[0];
  const network = document.querySelector("#commission-network")?.value || "";
  if (!file) return showMessage("Choose a commission CSV first.", "error");
  if (file.size > 2 * 1024 * 1024) return showMessage("Commission CSV must be 2 MB or smaller.", "error");
  try {
    button.disabled = true;
    const csv = await file.text();
    const data = await api(`/api/admin/commissions/import?network=${encodeURIComponent(network)}`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: csv,
    });
    const result = data.result || {};
    showMessage(
      `Commission import complete: ${Number(result.imported || 0)} new, ${Number(result.updated || 0)} updated, ${Number(result.skipped || 0)} skipped, ${Number(result.matchedClicks || 0)} matched to OfferGrid clicks.`,
      result.errors?.length ? "info" : "success"
    );
    renderMarketingAnalytics({ marketing: (await api("/api/admin/marketing?days=30&commissionDays=90")).marketing, commissions: data.commissions });
    event.currentTarget.reset();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#run-all-rules").addEventListener("click", async () => { try { showMessage("Running enabled discovery rules…"); const data = await api("/api/admin/rules/run-all", { method: "POST", body: "{}" }); const ok = data.results.filter(x => x.ok).length; showMessage(`Finished ${data.results.length} rules; ${ok} succeeded.`); await loadAdmin(); } catch (e) { showMessage(e.message, "error"); } });


document.querySelector("#run-ebay-competitors")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    showMessage("Running dedicated eBay same-product competitor scan…");
    const data = await api("/api/admin/ebay/competitors/run", { method: "POST", body: "{}" });
    const r = data.result;
    showMessage(
      `Competitor scan: ${r.scanned} products scanned, ${r.offersMatched} matching listings, ` +
      `${r.offersCreated} new offers, ${r.offersUpdated} refreshed.` +
      `${r.failures?.length ? ` ${r.failures.length} failed.` : ""}`
    );
    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#verify-ebay-prices")?.addEventListener("click", async event => {
  const button = event.currentTarget;

  try {
    button.disabled = true;
    showMessage("Verifying exact eBay listing prices, availability, quantity metadata and shipping…");

    const data = await api("/api/admin/ebay/prices/verify", {
      method: "POST",
      body: "{}",
    });

    const r = data.result;

    showMessage(
      `Price verification: ${r.verified} verified, ${r.changed} changed, ` +
      `${r.missing} unavailable, ${r.failures?.length || 0} failures.`
    );

    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#run-catalog-integrity")?.addEventListener("click", async event => {
  const button = event.currentTarget;

  try {
    button.disabled = true;
    showMessage("Auditing duplicate listing IDs, product variants, canonical IDs and price-history integrity…");

    const data = await api("/api/admin/catalog/integrity", {
      method: "POST",
      body: "{}",
    });

    const r = data.result;

    showMessage(
      `Integrity audit: ${r.duplicateOffersRemoved} duplicate offers removed, ` +
      `${r.incompatibleOffersSplit} incompatible variants split, ` +
      `${r.duplicateProductsMerged} strong-ID duplicates merged.`
    );

    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});


document.querySelector("#run-product-lifecycle")?.addEventListener("click", async event => {
  const button = event.currentTarget;

  try {
    button.disabled = true;
    showMessage("Running product lifecycle classification, price-history compaction, and eligible tombstone cleanup…");

    const data = await api("/api/admin/catalog/lifecycle", {
      method: "POST",
      body: JSON.stringify({ archiveEligible: true }),
    });

    const r = data.result;
    showMessage(
      `Lifecycle: ACTIVE ${r.after.ACTIVE || 0}, DORMANT ${r.after.DORMANT || 0}, ` +
      `STALE ${r.after.STALE || 0}, PRUNABLE ${r.after.PRUNABLE || 0}, ` +
      `ARCHIVED ${r.after.ARCHIVED || 0}. ${r.archived || 0} archived this pass; ` +
      `${r.compression?.rawPointsCompressed || 0} old price observations compressed.`
    );

    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#cleanup-ebay-competitors")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    showMessage("Checking stored eBay competitor offers for unsafe matches…");
    const data = await api("/api/admin/ebay/competitors/cleanup", {
      method: "POST",
      body: "{}",
    });
    const r = data.result;
    showMessage(
      `Competitor quarantine: ${r.quarantinedOffers || 0} moved out of public calculations, ` +
      `${r.removedOffers || 0} proven-unsafe offers removed locally, ` +
      `${r.pendingAfter || 0} queued for exact-detail proof.`
    );
    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});



document.querySelector("#sanitize-ebay-competitors")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    showMessage("Bulk-verifying quarantined eBay competitors with quota-aware getItems batches…");
    const data = await api("/api/admin/ebay/competitors/sanitize", {
      method: "POST",
      body: "{}",
    });
    const r = data.result;
    showMessage(
      `Bulk sanitizer: ${r.verified || 0} exact matches restored, ${r.rejected || 0} bad matches removed, ` +
      `${r.pendingAfter || 0} still pending. Used ${r.apiCalls || 0} eBay call(s) from a ${r.callBudget || 0}-call safe budget.`
    );
    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});


document.querySelector("#populate-starter-store")?.addEventListener("click", async event => {
  const button = event.currentTarget;
  try {
    button.disabled = true;
    showMessage("Pulling real starter products from eBay. This can take a little while…");
    const data = await api("/api/admin/populate/starter", {
      method: "POST",
      body: JSON.stringify({
        autoPublish: document.querySelector("#starter-auto-publish")?.checked !== false
      })
    });

    const r = data.result;
    const failureText = r.failures?.length ? ` ${r.failures.length} searches failed.` : "";
    showMessage(
      `Starter catalog complete: ${r.offersReceived} live offers received, ` +
      `${r.productsCreated} products created, ${r.published} published.${failureText}`
    );
    await loadAdmin();
  } catch (e) {
    showMessage(e.message, "error");
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#demo-form").addEventListener("submit", async event => { event.preventDefault(); try { const data = await api("/api/admin/import/demo", { method: "POST", body: "{}" }); showMessage(`Demo loaded: ${data.result.productsCreated} products created.`); await loadAdmin(); } catch (e) { showMessage(e.message, "error"); } });
document.querySelector("#ebay-form").addEventListener("submit", async event => { event.preventDefault(); try { showMessage("Searching eBay + Rakuten…"); const data = await api("/api/admin/import/ebay", { method: "POST", body: JSON.stringify({ query: document.querySelector("#ebay-query").value, limit: Number(document.querySelector("#ebay-limit").value) }) }); const providers = data.providers || {}; showMessage(`Marketplaces returned ${data.received} offers · eBay ${Number(providers.ebay || 0)} · Rakuten ${Number(providers.rakuten || 0)}.`); await loadAdmin(); } catch (e) { showMessage(e.message, "error"); } });
document.querySelector("#awin-form").addEventListener("submit", async event => { event.preventDefault(); try { showMessage("Downloading Awin feed…"); const data = await api("/api/admin/import/awin", { method: "POST", body: JSON.stringify({ advertiserId: document.querySelector("#awin-id").value, locale: document.querySelector("#awin-locale").value, limit: Number(document.querySelector("#awin-limit").value) }) }); showMessage(`Awin returned ${data.received} offers.`); await loadAdmin(); } catch (e) { showMessage(e.message, "error"); } });

document.querySelector("#rule-form").addEventListener("submit", async event => {
  event.preventDefault();
  const provider = document.querySelector("#rule-provider").value;
  const commissionPct = Number(document.querySelector("#rule-commission").value || 0);
  try {
    await api("/api/admin/rules", { method: "POST", body: JSON.stringify({
      name: document.querySelector("#rule-name").value,
      provider,
      query: document.querySelector("#rule-query").value,
      advertiserId: document.querySelector("#rule-awin-id").value,
      locale: document.querySelector("#rule-locale").value,
      limit: Number(document.querySelector("#rule-limit").value),
      enabled: true,
      autoApprove: document.querySelector("#rule-auto-approve").checked,
      minScore: Number(document.querySelector("#rule-score").value),
      minHeat: Number(document.querySelector("#rule-heat").value),
      minDiscount: Number(document.querySelector("#rule-discount").value),
      minCommissionRate: commissionPct / 100,
    }) });
    showMessage("Discovery rule saved.");
    event.target.reset();
    document.querySelector("#rule-provider").value = "ebay";
    document.querySelector("#rule-locale").value = "en_US";
    document.querySelector("#rule-limit").value = "50";
    document.querySelector("#rule-score").value = "70";
    document.querySelector("#rule-heat").value = "0";
    document.querySelector("#rule-discount").value = "0";
    document.querySelector("#rule-commission").value = "0";
    await loadAdmin();
  } catch (e) { showMessage(e.message, "error"); }
});

rulesList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-rule-action]");
  if (!button) return;
  const card = button.closest(".rule-card");
  const id = Number(card.dataset.ruleId);
  const action = button.dataset.ruleAction;
  try {
    button.disabled = true;
    if (action === "run") { showMessage("Running discovery rule…"); const data = await api(`/api/admin/rules/${id}/run`, { method: "POST", body: "{}" }); showMessage(`Rule processed ${data.result.received} offers; ${data.result.autoApproved} auto-approved.`); }
    if (action === "toggle") {
      const current = button.textContent.trim() === "Pause";
      await api(`/api/admin/rules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: !current }) });
      showMessage(current ? "Rule paused." : "Rule enabled.");
    }
    if (action === "delete") { if (!confirm("Delete this discovery rule?")) return; await api(`/api/admin/rules/${id}`, { method: "DELETE" }); showMessage("Rule deleted."); }
    await loadAdmin();
  } catch (e) { showMessage(e.message, "error"); } finally { button.disabled = false; }
});

reviewList.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".review-card");
  const id = Number(card.dataset.id);
  const action = button.dataset.action;
  try {
    button.disabled = true;
    if (action === "save") { await api(`/api/admin/products/${id}`, { method: "PATCH", body: JSON.stringify({ title: card.querySelector(".title-input").value, category: card.querySelector(".category-input").value, editorNote: card.querySelector(".note-input").value }) }); showMessage("Saved."); }
    if (action === "approve") { await api(`/api/admin/products/${id}/approve`, { method: "POST", body: "{}" }); showMessage("Product is live."); }
    if (action === "hide") { await api(`/api/admin/products/${id}/hide`, { method: "POST", body: "{}" }); showMessage("Product hidden."); }
    if (action === "pin-lifecycle") {
      const isPinned = button.textContent.trim().startsWith("Unpin");
      await api(`/api/admin/products/${id}/lifecycle/pin`, {
        method: "POST",
        body: JSON.stringify({ pinned: !isPinned }),
      });
      showMessage(isPinned ? "Lifecycle pin removed." : "Product protected from automatic archival.");
    }
    if (action === "ai") { showMessage("AI is enriching the product…"); await api(`/api/admin/products/${id}/enrich`, { method: "POST", body: "{}" }); showMessage("AI enrichment complete."); }
    if (action === "delete") { if (!confirm("Delete this product and all of its history?")) return; await api(`/api/admin/products/${id}`, { method: "DELETE" }); showMessage("Product deleted."); }
    await loadAdmin();
  } catch (e) { showMessage(e.message, "error"); } finally { button.disabled = false; }
});

(async () => { try { await getConfig(); await checkAuth(); } catch (e) { document.querySelector("#login-error").textContent = e.message; } })();
