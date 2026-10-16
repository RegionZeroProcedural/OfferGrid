import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "private-config.json");
const TMP_PATH = CONFIG_PATH + ".tmp";

function encryptionKey() {
  const source =
    process.env.CONFIG_ENCRYPTION_KEY ||
    process.env.SESSION_SECRET ||
    "dev-secret";

  return crypto.createHash("sha256").update(String(source)).digest();
}

function encryptObject(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptObject(payload) {
  if (!payload || payload.version !== 1 || payload.algorithm !== "aes-256-gcm") {
    throw new Error("Unsupported private-config format.");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(payload.iv, "base64")
  );

  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8"));
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export function readPrivateConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) return { values: {} };

  try {
    const payload = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const decoded = decryptObject(payload);
    return {
      values:
        decoded && typeof decoded.values === "object" && decoded.values
          ? decoded.values
          : {},
    };
  } catch (error) {
    throw new Error(
      "Could not decrypt data/private-config.json. " +
      "If CONFIG_ENCRYPTION_KEY or SESSION_SECRET changed after credentials were saved, " +
      "restore the old key or delete the private-config file and re-enter the credentials. " +
      `(${error.message})`
    );
  }
}

export function writePrivateConfig(data) {
  ensureDataDir();
  const payload = encryptObject({
    values: data?.values && typeof data.values === "object" ? data.values : {},
  });

  fs.writeFileSync(TMP_PATH, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });

  try {
    fs.chmodSync(TMP_PATH, 0o600);
  } catch {}

  fs.renameSync(TMP_PATH, CONFIG_PATH);

  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {}
}

export function getConfigValue(name, fallback = "") {
  const saved = readPrivateConfig().values[name];
  if (saved !== undefined && saved !== null && String(saved) !== "") {
    return saved;
  }

  const env = process.env[name];
  if (env !== undefined && env !== null && String(env) !== "") {
    return env;
  }

  return fallback;
}

export function getConfigSource(name, fallback = undefined) {
  const saved = readPrivateConfig().values[name];
  if (saved !== undefined && saved !== null && String(saved) !== "") return "admin";

  const env = process.env[name];
  if (env !== undefined && env !== null && String(env) !== "") return "env";

  if (fallback !== undefined && fallback !== null && String(fallback) !== "") {
    return "default";
  }

  return "none";
}

export function saveConfigValues(updates = {}, clear = []) {
  const data = readPrivateConfig();
  const values = { ...data.values };

  for (const key of clear || []) {
    delete values[String(key)];
  }

  for (const [key, rawValue] of Object.entries(updates || {})) {
    if (rawValue === undefined || rawValue === null) continue;
    const value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (value === "") continue;
    values[key] = value;
  }

  writePrivateConfig({ values });
  return { values };
}

export function clearConfigKeys(keys = []) {
  return saveConfigValues({}, keys);
}

export function vaultSecurityStatus() {
  const hasDedicatedKey = Boolean(process.env.CONFIG_ENCRYPTION_KEY);
  const hasCustomSessionSecret =
    Boolean(process.env.SESSION_SECRET) &&
    process.env.SESSION_SECRET !== "dev-secret";

  return {
    encrypted: true,
    algorithm: "AES-256-GCM",
    keySource: hasDedicatedKey
      ? "CONFIG_ENCRYPTION_KEY"
      : hasCustomSessionSecret
        ? "SESSION_SECRET"
        : "default development secret",
    productionReadyKey: hasDedicatedKey || hasCustomSessionSecret,
    file: "data/private-config.json",
  };
}
