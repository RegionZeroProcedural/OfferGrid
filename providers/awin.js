import { getConfigValue } from "../lib/privateConfig.js";

function required(name) {
  const value = getConfigValue(name, "");
  if (!value) throw new Error(`${name} is not configured in .env`);
  return value;
}

function parseMoney(value) {
  if (value == null) return { amount: null, currency: null };
  if (typeof value === "number") return { amount: value, currency: null };

  const match = String(value).trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]{3})?$/);
  if (!match) return { amount: null, currency: null };

  return {
    amount: Number(match[1]),
    currency: match[2] || null,
  };
}

function buildTrackedLink(advertiserId, destination) {
  const publisherId = required("AWIN_PUBLISHER_ID");
  const url = new URL("https://www.awin1.com/cread.php");
  url.searchParams.set("awinmid", String(advertiserId));
  url.searchParams.set("awinaffid", String(publisherId));
  if (destination) url.searchParams.set("ued", destination);
  return url.toString();
}

function candidateFromLine(obj, advertiserId) {
  const meta = obj.meta || {};
  const basic = obj.product_basic || obj;
  const pricing = obj.price_and_availability || obj;
  const category = obj.product_category || obj;

  const id = basic.id ?? obj.id;
  const title = basic.title ?? obj.title;
  const destination = basic.link ?? obj.link;
  const imageUrl = basic.image_link ?? obj.image_link ?? "";

  const regular = parseMoney(pricing.price ?? obj.price);
  const sale = parseMoney(pricing.sale_price ?? obj.sale_price);

  if (!id || !title || regular.amount == null || !destination) return null;

  const currentPrice = sale.amount != null ? sale.amount : regular.amount;
  const originalPrice =
    sale.amount != null && sale.amount < regular.amount ? regular.amount : null;

  // If Awin gives a pre-tracked URL, use it. Otherwise build a standard Awin
  // tracking URL around the advertiser landing page.
  const affiliateUrl =
    obj.awin_deep_link ||
    obj.aw_deep_link ||
    basic.awin_deep_link ||
    basic.aw_deep_link ||
    buildTrackedLink(advertiserId, destination);

  return {
    provider: "awin",
    externalId: `${advertiserId}:${id}`,
    title,
    merchant: meta.advertiser_name || `Awin advertiser ${advertiserId}`,
    price: currentPrice,
    originalPrice,
    currency: sale.currency || regular.currency || "USD",
    affiliateUrl,
    sourceUrl: destination,
    imageUrl,
    brand: category.brand ?? obj.brand ?? "",
    category:
      category.product_type ??
      category.google_product_category ??
      obj.product_type ??
      obj.google_product_category ??
      "Other",
    availability: pricing.availability ?? obj.availability ?? "in_stock",
    commissionRate: Number(getConfigValue("AWIN_DEFAULT_COMMISSION_RATE", "0.05")),
    commissionIsEstimate: true,
    merchantRatingPct: null,
    gtin: category.gtin ?? obj.gtin ?? "",
    mpn: category.mpn ?? obj.mpn ?? "",
  };
}

export async function fetchAwinFeed(advertiserId, locale = "en_US", limit = 250) {
  const token = required("AWIN_ACCESS_TOKEN");
  required("AWIN_PUBLISHER_ID");

  const safeLocale = String(locale || "en_US").replace(/[^A-Za-z_]/g, "");
  const safeAdvertiser = String(advertiserId).replace(/[^0-9]/g, "");
  if (!safeAdvertiser) throw new Error("Awin advertiser ID must be numeric.");

  const endpoint =
    `https://api.awin.com/publishers/${getConfigValue("AWIN_PUBLISHER_ID", "")}` +
    `/awinfeeds/download/${safeAdvertiser}-retail-${safeLocale}.jsonl`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Awin Enhanced Feed ${response.status}: ${await response.text()}`);
  }

  if (!response.body) throw new Error("Awin returned an empty response body.");

  const max = Math.min(Math.max(Number(limit), 1), 5000);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const candidates = [];
  let buffer = "";
  let lastError = null;

  try {
    while (candidates.length < max) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const obj = JSON.parse(line);
        if (obj.error) {
          lastError = new Error(`Awin feed error ${obj.error}: ${obj.message || "unknown error"}`);
          continue;
        }

        const candidate = candidateFromLine(obj, safeAdvertiser);
        if (candidate) candidates.push(candidate);
        if (candidates.length >= max) break;
      }

      if (done) break;
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  if (lastError && !candidates.length) throw lastError;
  return candidates;
}
