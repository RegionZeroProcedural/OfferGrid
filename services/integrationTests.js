import { getConfigValue } from "../lib/privateConfig.js";
import { searchRakutenProducts } from "../providers/rakuten.js";
import {
  isRakutenCatalogConfigured,
  testRakutenCatalogConnection,
} from "../providers/rakutenCatalog.js";

function required(name) {
  const value = getConfigValue(name, "");
  if (!value) throw new Error(`${name} is not configured.`);
  return String(value);
}

async function responseError(label, response) {
  const body = (await response.text()).slice(0, 500);
  throw new Error(`${label} ${response.status}${body ? `: ${body}` : ""}`);
}


function squirrelScriptUrl() {
  const value = required("SQUIRREL_SCRIPT_URL");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("SQUIRREL_SCRIPT_URL must be a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("Squirrel script URL must use HTTPS.");
  }

  const host = url.hostname.toLowerCase();
  if (!(host === "getsquirrel.co" || host.endsWith(".getsquirrel.co"))) {
    throw new Error("Squirrel script URL must be hosted on getsquirrel.co.");
  }

  return url.toString();
}

async function testSquirrel() {
  const url = squirrelScriptUrl();

  const response = await fetch(url, {
    method: "GET",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Accept: "application/javascript,text/javascript,*/*;q=0.1",
      "User-Agent": "OfferGrid/2.4 Squirrel integration test",
    },
  });

  if (!response.ok) await responseError("Squirrel script", response);

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();

  if (!body.trim()) {
    throw new Error("Squirrel script endpoint responded successfully but returned an empty body.");
  }

  return {
    ok: true,
    message: `Squirrel script is reachable (${contentType || "content type not reported"}). It will load on public OfferGrid pages while enabled.`,
  };
}

async function testEbay() {
  const clientId = required("EBAY_CLIENT_ID");
  const clientSecret = required("EBAY_CLIENT_SECRET");
  const environment =
    String(getConfigValue("EBAY_ENVIRONMENT", "sandbox")).toLowerCase() === "production"
      ? "production"
      : "sandbox";

  const apiBase =
    environment === "sandbox"
      ? "https://api.sandbox.ebay.com"
      : "https://api.ebay.com";

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const response = await fetch(`${apiBase}/identity/v1/oauth2/token`, {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(
      `eBay ${environment === "sandbox" ? "Sandbox" : "Production"} OAuth ${response.status}` +
      `${body ? `: ${body}` : ""}`
    );
  }

  const data = await response.json();

  return {
    ok: true,
    message:
      environment === "sandbox"
        ? `Sandbox OAuth succeeded. Token expires in ${Number(data.expires_in || 0)} seconds. OfferGrid will use api.sandbox.ebay.com for Browse calls.`
        : `Production OAuth succeeded. Token expires in ${Number(data.expires_in || 0)} seconds. Production Buy/Browse entitlement and ePN approval are separate eBay requirements.`,
  };
}

async function testBestBuy() {
  const key = required("BESTBUY_API_KEY");
  const url = new URL("https://api.bestbuy.com/v1/products(sku=43900)");
  url.searchParams.set("apiKey", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageSize", "1");

  const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) await responseError("Best Buy API", response);

  return {
    ok: true,
    message: "Best Buy API key accepted.",
  };
}

async function testUpcItemDb() {
  const userKey = getConfigValue("UPCITEMDB_USER_KEY", "");
  const keyType = getConfigValue("UPCITEMDB_KEY_TYPE", "3scale");

  const paid = Boolean(userKey);
  const url = new URL(
    paid
      ? "https://api.upcitemdb.com/prod/v1/lookup"
      : "https://api.upcitemdb.com/prod/trial/lookup"
  );
  url.searchParams.set("upc", "4002293401102");

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (paid) {
    headers.user_key = String(userKey);
    headers.key_type = String(keyType || "3scale");
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) await responseError("UPCitemdb", response);

  const remaining = response.headers.get("x-ratelimit-remaining");
  return {
    ok: true,
    message: paid
      ? `Paid UPCitemdb credentials accepted${remaining ? ` · ${remaining} requests remaining in the current limit window` : ""}.`
      : `Free UPCitemdb endpoint is reachable${remaining ? ` · ${remaining} requests remaining` : ""}.`,
  };
}

function openFactsHost(dataset) {
  const allowed = new Set([
    "openproductsfacts",
    "openfoodfacts",
    "openbeautyfacts",
    "openpetfoodfacts",
  ]);

  const safe = allowed.has(dataset) ? dataset : "openproductsfacts";
  return `https://world.${safe}.org`;
}

async function testOpenFacts() {
  const dataset = getConfigValue("OPEN_FACTS_DATASET", "openproductsfacts");
  const appName = getConfigValue("OPEN_FACTS_APP_NAME", "OfferGrid");
  const email = getConfigValue("OPEN_FACTS_CONTACT_EMAIL", "");
  const userAgent = `${appName}/2.3${email ? ` (${email})` : ""}`;

  const response = await fetch(`${openFactsHost(dataset)}/api/v2/product/3017620422003`, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) await responseError("Open Facts API", response);

  return {
    ok: true,
    message: `${dataset} read API is reachable. No API key is required for read operations.`,
  };
}

async function testAwin() {
  const token = required("AWIN_ACCESS_TOKEN");
  required("AWIN_PUBLISHER_ID");

  const response = await fetch("https://api.awin.com/publishers", {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) await responseError("Awin API", response);

  return {
    ok: true,
    message: "Awin access token accepted.",
  };
}

async function testRakuten() {
  const messages = [];
  const errors = [];
  let configured = 0;

  if (getConfigValue("RAKUTEN_ACCESS_TOKEN", "")) {
    configured++;
    try {
      const candidates = await searchRakutenProducts("phone", 1, { pageNumber: 1 });
      messages.push(
        `Product Search succeeded${candidates.length ? ` and returned ${candidates.length} product` : ""}.`
      );
    } catch (error) {
      errors.push(`Product Search failed: ${String(error?.message || error).slice(0, 400)}`);
    }
  }

  if (isRakutenCatalogConfigured()) {
    configured++;
    try {
      const catalog = await testRakutenCatalogConnection();
      messages.push(
        `Product Catalog SFTP succeeded: ${catalog.productFeedFiles} feed file(s) across ${catalog.advertisers} advertiser(s) currently visible.`
      );
    } catch (error) {
      errors.push(`Product Catalog SFTP failed: ${String(error?.message || error).slice(0, 400)}`);
    }
  }

  if (!configured) {
    throw new Error(
      "Configure a Rakuten API access token and/or Product Catalog SFTP username/password first."
    );
  }

  if (errors.length) {
    throw new Error([...messages, ...errors].join(" "));
  }

  return {
    ok: true,
    message:
      messages.join(" ") +
      " Automatic Product Search token refresh remains enabled when refresh credentials are configured.",
  };
}

function amazonTokenEndpoint(region) {
  if (region === "EU") return "https://api.amazon.co.uk/auth/o2/token";
  if (region === "FE") return "https://api.amazon.co.jp/auth/o2/token";
  return "https://api.amazon.com/auth/o2/token";
}

async function testAmazon() {
  const clientId = required("AMAZON_CREATORS_CLIENT_ID");
  const clientSecret = required("AMAZON_CREATORS_CLIENT_SECRET");
  required("AMAZON_PARTNER_TAG");
  const region = getConfigValue("AMAZON_TOKEN_REGION", "NA");

  const response = await fetch(amazonTokenEndpoint(region), {
    method: "POST",
    signal: AbortSignal.timeout(12_000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "creatorsapi::default",
    }),
  });

  if (!response.ok) await responseError("Amazon Creators OAuth", response);

  const data = await response.json();
  return {
    ok: true,
    message: `Amazon Creators OAuth succeeded. Token expires in ${Number(data.expires_in || 0)} seconds.`,
  };
}

export async function testIntegration(id) {
  if (id === "squirrel") return testSquirrel();
  if (id === "ebay") return testEbay();
  if (id === "bestbuy") return testBestBuy();
  if (id === "upcitemdb") return testUpcItemDb();
  if (id === "openfacts") return testOpenFacts();
  if (id === "awin") return testAwin();
  if (id === "rakuten") return testRakuten();
  if (id === "amazon") return testAmazon();
  throw new Error("Unknown integration.");
}
