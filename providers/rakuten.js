import { getConfigValue, saveConfigValues } from "../lib/privateConfig.js";
import { opLog, opWarn, timedOp } from "../lib/opsLog.js";

let cachedToken = "";
let cachedTokenExpiresAt = 0;
let cachedTokenFingerprint = "";
let tokenRefreshPromise = null;
let lastSearchAt = 0;
let searchPermitChain = Promise.resolve();
const searchCache = new Map();
const inFlightSearches = new Map();

function enabled() {
  return String(getConfigValue("RAKUTEN_SEARCH_ENABLED", "true")).toLowerCase() !== "false";
}

export function isRakutenSearchConfigured() {
  return enabled() && Boolean(getConfigValue("RAKUTEN_ACCESS_TOKEN", ""));
}

function normalizeQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[&=?{}\\()\[\]\-;~|$!><*%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function decodeXml(value) {
  const text = String(value || "");
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return _; }
    })
    .replace(/&#([0-9]+);/g, (_, num) => {
      try { return String.fromCodePoint(parseInt(num, 10)); } catch { return _; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagValue(xml, tag) {
  const safe = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) : "";
}

function moneyValue(xml, tag) {
  const safe = String(tag).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml || "").match(new RegExp(`<${safe}([^>]*)>([\\s\\S]*?)<\\/${safe}>`, "i"));
  if (!match) return { amount: null, currency: "" };
  const amount = Number(decodeXml(match[2]).replace(/[^0-9.+-]/g, ""));
  const currencyMatch = String(match[1] || "").match(/currency\s*=\s*["']([^"']+)["']/i);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: currencyMatch ? decodeXml(currencyMatch[1]) : "",
  };
}

function itemBlocks(xml) {
  return [...String(xml || "").matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)]
    .map(match => match[1]);
}

function candidateFromItem(block) {
  const mid = tagValue(block, "mid");
  const linkId = tagValue(block, "linkid");
  const sku = tagValue(block, "sku");
  const title = tagValue(block, "productname");
  const merchant = tagValue(block, "merchantname");
  const affiliateUrl = tagValue(block, "linkurl");
  const imageUrl = tagValue(block, "imageurl");
  const upc = tagValue(block, "upccode").replace(/[^0-9]/g, "");
  const categoryBlock = String(block).match(/<category(?:\s[^>]*)?>([\s\S]*?)<\/category>/i)?.[1] || "";
  const primaryCategory = tagValue(categoryBlock, "primary");
  const secondaryCategory = tagValue(categoryBlock, "secondary");
  const retail = moneyValue(block, "price");
  const sale = moneyValue(block, "saleprice");

  const saleUsable = sale.amount != null && sale.amount > 0;
  const retailUsable = retail.amount != null && retail.amount > 0;
  const price = saleUsable ? sale.amount : retail.amount;
  if (!title || !affiliateUrl || !Number.isFinite(Number(price)) || Number(price) <= 0) return null;

  const externalId = sku || linkId || "";
  if (!externalId) return null;

  const originalPrice =
    saleUsable && retailUsable && Number(sale.amount) < Number(retail.amount)
      ? Number(retail.amount)
      : null;

  return {
    provider: "rakuten",
    externalId: mid ? `${mid}:${externalId}` : String(externalId),
    title,
    listingTitle: title,
    merchant: merchant || (mid ? `Rakuten advertiser ${mid}` : "Rakuten advertiser"),
    price: Number(price),
    originalPrice,
    currency: sale.currency || retail.currency || "USD",
    affiliateUrl,
    sourceUrl: affiliateUrl,
    imageUrl,
    brand: "",
    category: (secondaryCategory || primaryCategory || "Other").replace(/~~+/g, " > "),
    availability: "in_stock",
    commissionRate: Number.isFinite(Number(getConfigValue("RAKUTEN_DEFAULT_COMMISSION_RATE", "0.05")))
      ? Number(getConfigValue("RAKUTEN_DEFAULT_COMMISSION_RATE", "0.05"))
      : 0.05,
    commissionIsEstimate: true,
    merchantRatingPct: null,
    gtin: upc,
    mpn: "",
    searchObservedAt: new Date().toISOString(),
    priceSource: "rakuten-product-search",
    matchSource: "rakuten-product-search",
  };
}

function configuredAccessToken() {
  const token = String(getConfigValue("RAKUTEN_ACCESS_TOKEN", "") || "").trim();
  if (!token) return "";

  if (token !== cachedTokenFingerprint) {
    cachedToken = token;
    cachedTokenFingerprint = token;
    // A manually-entered token may already be partway through its 60-minute life.
    // Treat it as usable now and rely on a 401-triggered refresh if refresh credentials exist.
    cachedTokenExpiresAt = 0;
  }

  return cachedToken;
}

function refreshCredentials() {
  const clientId = String(getConfigValue("RAKUTEN_CLIENT_ID", "") || "").trim();
  const clientSecret = String(getConfigValue("RAKUTEN_CLIENT_SECRET", "") || "").trim();
  const refreshToken = String(getConfigValue("RAKUTEN_REFRESH_TOKEN", "") || "").trim();
  const scope = String(getConfigValue("RAKUTEN_ACCOUNT_ID", "") || "").replace(/[^0-9]/g, "");
  return { clientId, clientSecret, refreshToken, scope };
}

function canRefresh() {
  const values = refreshCredentials();
  return Boolean(values.clientId && values.clientSecret && values.refreshToken && values.scope);
}

async function refreshAccessToken() {
  if (tokenRefreshPromise) return tokenRefreshPromise;

  tokenRefreshPromise = (async () => {
    const { clientId, clientSecret, refreshToken, scope } = refreshCredentials();
    if (!clientId || !clientSecret || !refreshToken || !scope) {
      throw new Error(
        "Rakuten access token expired and automatic refresh is not fully configured. " +
        "Add Client ID, Client Secret, Refresh Token, and Publisher Account ID/SID in Admin → API connections."
      );
    }

    const tokenKey = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
    const response = await fetch("https://api.linksynergy.com/token", {
      method: "POST",
      signal: AbortSignal.timeout(12_000),
      headers: {
        Authorization: `Bearer ${tokenKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        scope,
      }),
    });

    const body = await response.text();
    let data = {};
    try { data = body ? JSON.parse(body) : {}; } catch {}

    if (!response.ok || !data.access_token) {
      throw new Error(
        `Rakuten token refresh ${response.status}: ${String(data.error_description || data.error || body || "unknown error").slice(0, 400)}`
      );
    }

    const newAccess = String(data.access_token);
    const newRefresh = String(data.refresh_token || refreshToken);
    const expiresIn = Math.max(60, Number(data.expires_in || 3600));

    saveConfigValues({
      RAKUTEN_ACCESS_TOKEN: newAccess,
      RAKUTEN_REFRESH_TOKEN: newRefresh,
    });

    cachedToken = newAccess;
    cachedTokenFingerprint = newAccess;
    cachedTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 120) * 1000;

    opLog("rakuten-token", "access token refreshed automatically", {
      expiresIn,
      scope,
    });

    return newAccess;
  })().finally(() => {
    tokenRefreshPromise = null;
  });

  return tokenRefreshPromise;
}

async function accessToken({ forceRefresh = false } = {}) {
  if (forceRefresh) return refreshAccessToken();

  const current = configuredAccessToken();
  if (!current) {
    throw new Error("RAKUTEN_ACCESS_TOKEN is not configured.");
  }

  if (cachedTokenExpiresAt && Date.now() >= cachedTokenExpiresAt && canRefresh()) {
    return refreshAccessToken();
  }

  return current;
}

async function paceSearch() {
  const task = searchPermitChain.then(async () => {
    const minInterval = Math.max(0, Number(getConfigValue("RAKUTEN_RATE_MIN_INTERVAL_MS", "650") || 650));
    const wait = Math.max(0, lastSearchAt + minInterval - Date.now());
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    lastSearchAt = Date.now();
  });
  searchPermitChain = task.catch(() => {});
  return task;
}

function cacheSeconds() {
  return Math.min(Math.max(Number(getConfigValue("RAKUTEN_SEARCH_CACHE_SECONDS", "120") || 120), 0), 3600);
}

function cachedSearch(key) {
  const item = searchCache.get(key);
  if (!item) return null;
  if (Date.now() - item.at > cacheSeconds() * 1000) {
    searchCache.delete(key);
    return null;
  }
  return item.value;
}

function storeSearch(key, value) {
  if (cacheSeconds() <= 0) return;
  searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > 500) {
    const oldest = [...searchCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
    for (const [oldKey] of oldest) searchCache.delete(oldKey);
  }
}

async function performSearch(query, limit, pageNumber, { retryAuth = true } = {}) {
  const token = await accessToken();
  await paceSearch();

  const url = new URL("https://api.linksynergy.com/productsearch/1.0");
  url.searchParams.set("keyword", query);
  url.searchParams.set("language", String(getConfigValue("RAKUTEN_LANGUAGE", "en_US") || "en_US"));
  url.searchParams.set("max", String(Math.min(Math.max(Number(limit || 30), 1), 100)));
  url.searchParams.set("pagenumber", String(Math.max(1, Number(pageNumber || 1))));

  const finish = timedOp("rakuten-search", `Product Search \"${query}\"`, {
    pageNumber,
    limit: Math.min(Math.max(Number(limit || 30), 1), 100),
  });

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(
      Math.min(Math.max(Number(getConfigValue("RAKUTEN_SEARCH_TIMEOUT_MS", "12000") || 12000), 3000), 30000)
    ),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.1",
      "User-Agent": "OfferGrid/3.7.30 Rakuten Product Search",
    },
  });

  if (response.status === 401 && retryAuth && canRefresh()) {
    finish("access token expired; refreshing");
    await accessToken({ forceRefresh: true });
    return performSearch(query, limit, pageNumber, { retryAuth: false });
  }

  const body = await response.text();
  if (!response.ok) {
    const error = new Error(`Rakuten Product Search ${response.status}: ${body.slice(0, 500)}`);
    error.code = response.status === 429 ? "RAKUTEN_RATE_LIMIT" : "RAKUTEN_SEARCH_ERROR";
    error.status = response.status;
    finish("failed", { status: response.status });
    throw error;
  }

  const candidates = itemBlocks(body)
    .map(candidateFromItem)
    .filter(Boolean);

  finish("complete", { returned: candidates.length });
  return candidates;
}

export async function searchRakutenProducts(query, limit = 30, options = {}) {
  if (!enabled()) return [];
  if (!getConfigValue("RAKUTEN_ACCESS_TOKEN", "")) return [];

  const cleanQuery = normalizeQuery(query);
  if (!cleanQuery) return [];

  const safeLimit = Math.min(Math.max(Number(limit || 30), 1), 100);
  const pageNumber = Math.max(1, Number(options?.pageNumber || 1));
  const key = `${cleanQuery.toLowerCase()}|${safeLimit}|${pageNumber}|${String(getConfigValue("RAKUTEN_LANGUAGE", "en_US"))}`;
  const cached = cachedSearch(key);
  if (cached) {
    opLog("rakuten-search", `cache hit \"${cleanQuery}\"`, { pageNumber, returned: cached.length });
    return cached;
  }

  const existing = inFlightSearches.get(key);
  if (existing) {
    opLog("rakuten-search", `joined in-flight \"${cleanQuery}\"`, { pageNumber });
    return existing;
  }

  const promise = performSearch(cleanQuery, safeLimit, pageNumber)
    .then(candidates => {
      storeSearch(key, candidates);
      return candidates;
    })
    .catch(error => {
      opWarn("rakuten-search", "Product Search failed", {
        query: cleanQuery,
        pageNumber,
        code: error.code || null,
        status: error.status || null,
        error: String(error.message || error).slice(0, 500),
      });
      throw error;
    })
    .finally(() => {
      if (inFlightSearches.get(key) === promise) inFlightSearches.delete(key);
    });

  inFlightSearches.set(key, promise);
  return promise;
}

export const __rakutenTest = {
  normalizeQuery,
  parseProductSearchXml(xml) {
    return itemBlocks(xml).map(candidateFromItem).filter(Boolean);
  },
};
