import {
  getConfigSource,
  getConfigValue,
  saveConfigValues,
  clearConfigKeys,
  vaultSecurityStatus,
} from "./privateConfig.js";

export const INTEGRATIONS = [
  {
    id: "squirrel",
    name: "Squirrel",
    type: "Automatic affiliate-link monetization",
    description: "Loads your Squirrel publisher script on public OfferGrid pages so eligible merchant links can be monetized automatically.",
    docsUrl: "https://getsquirrel.co/",
    testLabel: "Test script",
    fields: [
      {
        key: "SQUIRREL_ENABLED",
        label: "Enabled",
        secret: false,
        default: "true",
        options: [
          ["true", "Enabled"],
          ["false", "Disabled"],
        ],
      },
      {
        key: "SQUIRREL_SCRIPT_URL",
        label: "Squirrel script URL",
        secret: false,
        required: true,
        default: "",
      },
    ],
  },
  {
    id: "ebay",
    name: "eBay",
    type: "Marketplace + affiliate",
    description: "Browse marketplace products and generate eBay Partner Network affiliate URLs.",
    docsUrl: "https://developer.ebay.com/",
    testLabel: "Test OAuth",
    fields: [
      {
        key: "EBAY_ENVIRONMENT",
        label: "eBay environment",
        secret: false,
        default: "sandbox",
        inputMode: "radio",
        options: [
          ["sandbox", "Sandbox"],
          ["production", "Production"],
        ],
      },
      { key: "EBAY_CLIENT_ID", label: "Client ID / App ID", secret: true, required: true },
      { key: "EBAY_CLIENT_SECRET", label: "Client Secret / Cert ID", secret: true, required: true },
      {
        key: "EBAY_MARKETPLACE_ID",
        label: "Marketplace",
        secret: false,
        default: "EBAY_US",
        options: [
          ["EBAY_US", "United States"],
          ["EBAY_CA", "Canada"],
          ["EBAY_GB", "United Kingdom"],
          ["EBAY_AU", "Australia"],
        ],
      },
      { key: "EBAY_AFFILIATE_CAMPAIGN_ID", label: "ePN Campaign ID", secret: true },
      {
        key: "EBAY_AFFILIATE_REFERENCE_ID",
        label: "Affiliate reference ID",
        secret: false,
        default: "offergrid",
      },
      {
        key: "EBAY_DEFAULT_COMMISSION_RATE",
        label: "Estimated commission rate",
        secret: false,
        default: "0.03",
        inputMode: "decimal",
      },
      {
        key: "EBAY_ACCOUNT_DELETION_ENDPOINT",
        label: "Marketplace account deletion endpoint",
        secret: false,
        default: "https://www.offergrid.tech/api/ebay/account-deletion",
      },
      {
        key: "EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN",
        label: "Account deletion verification token",
        secret: true,
      },
      {
        key: "EBAY_DEV_ID",
        label: "Developer ID (optional for notification verification)",
        secret: true,
      },
      {
        key: "EBAY_REDIRECT_URI",
        label: "RuName / redirect URI (optional for notification verification)",
        secret: true,
      },
      {
        key: "EBAY_DELETION_VERIFY_SIGNATURES",
        label: "Verify eBay notification signatures",
        secret: false,
        default: "true",
        options: [
          ["true", "Enabled"],
          ["false", "Disabled"],
        ],
      },
    ],
  },
  {
    id: "bestbuy",
    name: "Best Buy",
    type: "Retail product API",
    description: "Near-real-time catalog, price, availability, specs, categories, and images.",
    docsUrl: "https://developers.bestbuy.com/",
    testLabel: "Test API key",
    fields: [
      { key: "BESTBUY_API_KEY", label: "Developer API key", secret: true, required: true },
      {
        key: "BESTBUY_DEFAULT_COMMISSION_RATE",
        label: "Estimated commission rate",
        secret: false,
        default: "0",
        inputMode: "decimal",
      },
    ],
  },
  {
    id: "upcitemdb",
    name: "UPCitemdb",
    type: "Barcode identification",
    description: "UPC/EAN/GTIN lookup. The free plan works without a key; paid plans use user_key.",
    docsUrl: "https://www.upcitemdb.com/wp/docs/main/development/",
    testLabel: "Test barcode lookup",
    optionalWithoutCredentials: true,
    fields: [
      { key: "UPCITEMDB_USER_KEY", label: "Paid-plan user_key (optional)", secret: true },
      {
        key: "UPCITEMDB_KEY_TYPE",
        label: "key_type",
        secret: false,
        default: "3scale",
      },
    ],
  },
  {
    id: "openfacts",
    name: "Open Facts",
    type: "Open barcode data",
    description: "Open Products Facts / Open Food Facts read APIs. Read access does not require an API key.",
    docsUrl: "https://openfoodfacts.github.io/documentation/docs/",
    testLabel: "Test public API",
    optionalWithoutCredentials: true,
    fields: [
      {
        key: "OPEN_FACTS_DATASET",
        label: "Dataset",
        secret: false,
        default: "openproductsfacts",
        options: [
          ["openproductsfacts", "Open Products Facts"],
          ["openfoodfacts", "Open Food Facts"],
          ["openbeautyfacts", "Open Beauty Facts"],
          ["openpetfoodfacts", "Open Pet Food Facts"],
        ],
      },
      {
        key: "OPEN_FACTS_APP_NAME",
        label: "App name",
        secret: false,
        default: "OfferGrid",
      },
      {
        key: "OPEN_FACTS_CONTACT_EMAIL",
        label: "Contact email for User-Agent",
        secret: false,
        inputMode: "email",
      },
    ],
  },
  {
    id: "awin",
    name: "Awin",
    type: "Affiliate network",
    description: "Affiliate product feeds, tracked links, advertisers, and publisher data.",
    docsUrl: "https://help.awin.com/apidocs/api-authentication",
    testLabel: "Test access token",
    fields: [
      { key: "AWIN_ACCESS_TOKEN", label: "API access token", secret: true, required: true },
      { key: "AWIN_PUBLISHER_ID", label: "Publisher ID", secret: true, required: true },
      {
        key: "AWIN_DEFAULT_COMMISSION_RATE",
        label: "Estimated commission rate",
        secret: false,
        default: "0.05",
        inputMode: "decimal",
      },
    ],
  },
  {
    id: "rakuten",
    name: "Rakuten Advertising",
    type: "Affiliate network + marketplace search + Product Catalog",
    description: "Mirrors OfferGrid marketplace discovery into Rakuten Product Search and can bulk-sync approved advertiser Product Catalog feeds over SFTP. OAuth refresh and SFTP credentials are stored in the encrypted Admin vault.",
    docsUrl: "https://developers.rakutenadvertising.com/guides/product_search",
    testLabel: "Test Rakuten connections",
    fields: [
      {
        key: "RAKUTEN_SEARCH_ENABLED",
        label: "Mirror eBay discovery searches",
        secret: false,
        default: "true",
        options: [
          ["true", "Enabled"],
          ["false", "Disabled"],
        ],
      },
      { key: "RAKUTEN_ACCESS_TOKEN", label: "API access token", secret: true, required: true },
      { key: "RAKUTEN_REFRESH_TOKEN", label: "Refresh token (recommended)", secret: true },
      { key: "RAKUTEN_CLIENT_ID", label: "Developer application Client ID (recommended)", secret: true },
      { key: "RAKUTEN_CLIENT_SECRET", label: "Developer application Client Secret (recommended)", secret: true },
      { key: "RAKUTEN_ACCOUNT_ID", label: "Publisher Account ID / SID (recommended)", secret: true },
      {
        key: "RAKUTEN_LANGUAGE",
        label: "Product Search language",
        secret: false,
        default: "en_US",
        options: [
          ["en_US", "English (US)"],
          ["fr_FR", "French"],
          ["de_DE", "German"],
          ["pt_BR", "Portuguese (Brazil)"],
        ],
      },
      {
        key: "RAKUTEN_DEFAULT_COMMISSION_RATE",
        label: "Estimated commission rate",
        secret: false,
        default: "0.05",
        inputMode: "decimal",
      },
      {
        key: "RAKUTEN_CATALOG_SYNC_ENABLED",
        label: "Product Catalog SFTP synchronization",
        secret: false,
        default: "true",
        options: [
          ["true", "Enabled"],
          ["false", "Disabled"],
        ],
      },
      {
        key: "RAKUTEN_SFTP_HOST",
        label: "Product Catalog SFTP host",
        secret: false,
        default: "aftp.linksynergy.com",
      },
      {
        key: "RAKUTEN_SFTP_PORT",
        label: "Product Catalog SFTP port",
        secret: false,
        default: "22",
        inputMode: "decimal",
      },
      { key: "RAKUTEN_SFTP_USERNAME", label: "Product Catalog SFTP username", secret: true },
      { key: "RAKUTEN_SFTP_PASSWORD", label: "Product Catalog SFTP password", secret: true },
      {
        key: "RAKUTEN_CATALOG_AUTO_APPROVE",
        label: "Auto-publish valid Product Catalog products",
        secret: false,
        default: "true",
        options: [
          ["true", "Enabled"],
          ["false", "Disabled"],
        ],
      },
      {
        key: "RAKUTEN_CATALOG_SYNC_MINUTES",
        label: "Delta sync interval (minutes)",
        secret: false,
        default: "30",
        inputMode: "decimal",
      },
      {
        key: "RAKUTEN_CATALOG_FULL_REFRESH_HOURS",
        label: "Full catalog refresh interval (hours)",
        secret: false,
        default: "24",
        inputMode: "decimal",
      },
      {
        key: "RAKUTEN_CATALOG_BATCH_SIZE",
        label: "Catalog ingest batch size",
        secret: false,
        default: "250",
        inputMode: "decimal",
      },
    ],
  },
  {
    id: "amazon",
    name: "Amazon Creators API",
    type: "Affiliate product API",
    description: "Amazon Associates product access after your account is eligible and approved for Creators API.",
    docsUrl: "https://affiliate-program.amazon.com/creatorsapi/docs/",
    testLabel: "Test OAuth credentials",
    fields: [
      { key: "AMAZON_CREATORS_CLIENT_ID", label: "Creators API Client ID", secret: true, required: true },
      { key: "AMAZON_CREATORS_CLIENT_SECRET", label: "Creators API Client Secret", secret: true, required: true },
      { key: "AMAZON_PARTNER_TAG", label: "Associate / Partner Tag", secret: true, required: true },
      {
        key: "AMAZON_MARKETPLACE",
        label: "Marketplace",
        secret: false,
        default: "www.amazon.com",
      },
      {
        key: "AMAZON_TOKEN_REGION",
        label: "Token region",
        secret: false,
        default: "NA",
        options: [
          ["NA", "North America"],
          ["EU", "Europe"],
          ["FE", "Far East"],
        ],
      },
    ],
  },
];

export function getIntegrationDefinition(id) {
  return INTEGRATIONS.find(item => item.id === id) || null;
}

function maskConfigured(value) {
  const text = String(value || "");
  if (!text) return "";
  const tail = text.slice(-4);
  return `••••${tail}`;
}

function fieldSummary(field) {
  const value = getConfigValue(field.key, field.default ?? "");
  const source = getConfigSource(field.key, field.default);

  return {
    key: field.key,
    label: field.label,
    secret: Boolean(field.secret),
    required: Boolean(field.required),
    inputMode: field.inputMode || "text",
    options: field.options || null,
    configured: Boolean(String(value || "")),
    source,
    value: field.secret ? "" : String(value ?? ""),
    masked: field.secret && value ? maskConfigured(value) : "",
  };
}

export function integrationSummary() {
  const items = INTEGRATIONS.map(def => {
    const fields = def.fields.map(fieldSummary);
    const required = fields.filter(field => field.required);
    const configured =
      def.optionalWithoutCredentials
        ? true
        : required.length
          ? required.every(field => field.configured)
          : fields.some(field => field.configured);

    return {
      id: def.id,
      name: def.name,
      type: def.type,
      description: def.description,
      docsUrl: def.docsUrl,
      testLabel: def.testLabel,
      optionalWithoutCredentials: Boolean(def.optionalWithoutCredentials),
      configured,
      fields,
    };
  });

  return {
    vault: vaultSecurityStatus(),
    items,
  };
}

export function saveIntegration(id, values = {}) {
  const def = getIntegrationDefinition(id);
  if (!def) throw new Error("Unknown integration.");

  const allowed = new Set(def.fields.map(field => field.key));
  const updates = {};

  for (const [key, value] of Object.entries(values || {})) {
    if (!allowed.has(key)) continue;
    if (value === undefined || value === null || String(value).trim() === "") continue;
    updates[key] = String(value).trim();
  }

  saveConfigValues(updates);
  return integrationSummary().items.find(item => item.id === id);
}

export function clearIntegration(id) {
  const def = getIntegrationDefinition(id);
  if (!def) throw new Error("Unknown integration.");
  clearConfigKeys(def.fields.map(field => field.key));
  return integrationSummary().items.find(item => item.id === id);
}
