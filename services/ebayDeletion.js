import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getConfigValue } from "../lib/privateConfig.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const AUDIT_PATH = path.join(ROOT, "data", "ebay-deletion-audit.jsonl");

function configuredEndpoint() {
  return String(
    getConfigValue(
      "EBAY_ACCOUNT_DELETION_ENDPOINT",
      "https://www.offergrid.tech/api/ebay/account-deletion"
    )
  ).trim();
}

function configuredToken() {
  return String(
    getConfigValue("EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN", "")
  ).trim();
}

function environment() {
  return String(getConfigValue("EBAY_ENVIRONMENT", "production")).toLowerCase() === "sandbox"
    ? "SANDBOX"
    : "PRODUCTION";
}

function verifySignaturesEnabled() {
  return String(
    getConfigValue("EBAY_DELETION_VERIFY_SIGNATURES", "true")
  ).toLowerCase() === "true";
}

function tokenIsValid(token = configuredToken()) {
  return /^[A-Za-z0-9_-]{32,80}$/.test(token);
}

function endpointIsValid(endpoint = configuredEndpoint()) {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !["localhost", "127.0.0.1"].includes(url.hostname);
  } catch {
    return false;
  }
}

export function deletionSetupStatus() {
  const endpoint = configuredEndpoint();
  const token = configuredToken();

  return {
    endpoint,
    endpointValid: endpointIsValid(endpoint),
    tokenConfigured: Boolean(token),
    tokenValid: tokenIsValid(token),
    tokenLength: token.length,
    environment: environment().toLowerCase(),
    signatureVerificationEnabled: verifySignaturesEnabled(),
  };
}

export function buildChallengeResponse(challengeCode) {
  const challenge = String(challengeCode || "");
  const endpoint = configuredEndpoint();
  const token = configuredToken();

  if (!challenge) {
    throw new Error("challenge_code is required.");
  }
  if (!endpointIsValid(endpoint)) {
    throw new Error("The configured eBay deletion endpoint must be a public HTTPS URL.");
  }
  if (!tokenIsValid(token)) {
    throw new Error(
      "The eBay verification token must be 32–80 characters using only letters, numbers, underscore, or hyphen."
    );
  }

  const hash = crypto.createHash("sha256");
  hash.update(challenge, "utf8");
  hash.update(token, "utf8");
  hash.update(endpoint, "utf8");
  return hash.digest("hex");
}

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(
      AUDIT_PATH,
      JSON.stringify({
        at: new Date().toISOString(),
        ...entry,
      }) + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
  } catch (error) {
    console.error("[ebay deletion] audit write failed:", error.message);
  }
}

function sdkConfig() {
  const clientId = String(getConfigValue("EBAY_CLIENT_ID", ""));
  const clientSecret = String(getConfigValue("EBAY_CLIENT_SECRET", ""));
  const devId = String(getConfigValue("EBAY_DEV_ID", ""));
  const redirectUri = String(getConfigValue("EBAY_REDIRECT_URI", ""));

  return {
    SANDBOX: {
      clientId,
      clientSecret,
      devId,
      redirectUri,
      baseUrl: "api.sandbox.ebay.com",
    },
    PRODUCTION: {
      clientId,
      clientSecret,
      devId,
      redirectUri,
      baseUrl: "api.ebay.com",
    },
    endpoint: configuredEndpoint(),
    verificationToken: configuredToken(),
  };
}

export function acknowledgeDeletionNotification(payload, signaturePresent) {
  // Do not persist eBay usernames, user IDs, or EIAS tokens. OfferGrid currently
  // does not maintain customer accounts keyed to eBay users.
  audit({
    type: "notification-received",
    topic: payload?.metadata?.topic || "",
    notificationId: payload?.notification?.notificationId || "",
    eventDate: payload?.notification?.eventDate || "",
    signaturePresent: Boolean(signaturePresent),
  });
}

export async function verifyDeletionNotificationAsync(payload, signature) {
  if (!verifySignaturesEnabled()) {
    audit({
      type: "signature-verification-skipped",
      notificationId: payload?.notification?.notificationId || "",
    });
    return;
  }

  if (!signature) {
    audit({
      type: "signature-verification-failed",
      notificationId: payload?.notification?.notificationId || "",
      reason: "Missing X-EBAY-SIGNATURE header",
    });
    console.error("[ebay deletion] notification had no X-EBAY-SIGNATURE header");
    return;
  }

  try {
    // Official eBay Node SDK. Dynamic import keeps startup independent from
    // webhook verification until a notification actually arrives.
    const imported = await import("event-notification-nodejs-sdk");
    const sdk = imported.default || imported;

    const code = await sdk.process(
      payload,
      signature,
      sdkConfig(),
      environment()
    );

    const verified = Number(code) === 204 || Number(code) === 200;
    audit({
      type: verified ? "signature-verified" : "signature-verification-failed",
      notificationId: payload?.notification?.notificationId || "",
      sdkResponseCode: Number(code),
    });

    if (!verified) {
      console.error(
        `[ebay deletion] signature verification returned ${code} for ${payload?.notification?.notificationId || "unknown notification"}`
      );
    }
  } catch (error) {
    audit({
      type: "signature-verification-error",
      notificationId: payload?.notification?.notificationId || "",
      reason: String(error?.message || error).slice(0, 500),
    });
    console.error("[ebay deletion] signature verification error:", error);
  }
}

export async function testPublicDeletionEndpoint() {
  const status = deletionSetupStatus();
  if (!status.endpointValid) {
    throw new Error("Configure a valid public HTTPS deletion endpoint first.");
  }
  if (!status.tokenValid) {
    throw new Error("Configure a valid verification token first.");
  }

  const challenge = crypto.randomBytes(18).toString("hex");
  const expected = buildChallengeResponse(challenge);
  const url = new URL(status.endpoint);
  url.searchParams.set("challenge_code", challenge);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "OfferGrid/2.5.3 eBay endpoint self-test",
    },
  });

  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Public endpoint returned HTTP ${response.status} but not valid JSON.`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Public endpoint returned HTTP ${response.status}: ${bodyText.slice(0, 400)}`
    );
  }

  if (body?.challengeResponse !== expected) {
    throw new Error("Public endpoint challengeResponse did not match the expected SHA-256 value.");
  }

  return {
    ok: true,
    endpoint: status.endpoint,
    message: "Public eBay deletion endpoint challenge test passed.",
  };
}
