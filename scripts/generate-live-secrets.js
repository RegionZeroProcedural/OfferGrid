import crypto from "crypto";

function token(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

console.log("");
console.log("Copy these into your .env file:");
console.log("");
console.log(`SESSION_SECRET=${token(48)}`);
console.log(`CONFIG_ENCRYPTION_KEY=${token(32)}`);
console.log("");
console.log("Use a separate strong ADMIN_PASSWORD that you can remember.");
console.log("");
