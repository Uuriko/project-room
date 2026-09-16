// F018 — RFC 6238 TOTP two-factor for owner accounts.
//
// New-file-only: pure logic, no store/schema/network/timer changes. All
// functions are synchronous and take explicit inputs (secret as base32,
// timestamp as an injectable `time` option) so tests and wiring can drive
// them deterministically. The only host primitive is node:crypto
// (randomBytes, HMAC-SHA1, timingSafeEqual). Base32 is hand-rolled per
// RFC 4648 — no external npm dependencies. Suggested wiring (follow-up
// slice): enrollment stores the secret, verification gates owner logins.

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// RFC 6238 defaults: 30-second time step, 6-digit codes, HMAC-SHA1.
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS_6 = 6;
export const TOTP_DIGITS_8 = 8;
export const TOTP_DEFAULT_WINDOW = 1; // ±1 time step of clock skew

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = (() => {
  const table = new Map();
  for (let i = 0; i < BASE32_ALPHABET.length; i += 1) {
    table.set(BASE32_ALPHABET[i], i);
    table.set(BASE32_ALPHABET[i].toLowerCase(), i);
  }
  return table;
})();

const isNonNegativeInteger = value => Number.isInteger(value) && value >= 0;

function assertSecretString(secret) {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new TypeError("secret must be a non-empty base32 string");
  }
}

function assertDigits(digits) {
  if (digits !== TOTP_DIGITS_6 && digits !== TOTP_DIGITS_8) {
    throw new RangeError("digits must be 6 or 8");
  }
}

// Encode raw bytes as RFC 4648 base32 (uppercase, "=" padding).
export function base32Encode(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of input) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  while (output.length % 8 !== 0) output += "=";
  return output;
}

// Decode RFC 4648 base32 (case-insensitive, padding optional). Throws on
// any character outside the alphabet.
export function base32Decode(encoded) {
  assertSecretString(encoded);
  const clean = encoded.replace(/=+$/, "");
  if (clean.length === 0) throw new TypeError("secret must contain base32 data");
  let buffer = 0;
  let bits = 0;
  const out = [];
  for (const char of clean) {
    const value = BASE32_LOOKUP.get(char);
    if (value === undefined) {
      throw new TypeError(`invalid base32 character: ${JSON.stringify(char)}`);
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// Generate a fresh random enrollment secret (20 bytes = 160 bits, the
// RFC 4226 minimum) and return it base32-encoded. Uses node's CSPRNG.
export function generateSecret(secretBytes = 20) {
  if (!isNonNegativeInteger(secretBytes) || secretBytes === 0) {
    throw new RangeError("secretBytes must be a positive integer");
  }
  return base32Encode(randomBytes(secretBytes));
}

const counterForTime = (timeMs, stepSeconds) => {
  const step = Number(stepSeconds);
  if (!Number.isFinite(step) || step <= 0) throw new RangeError("stepSeconds must be a positive number");
  return BigInt(Math.floor(Number(timeMs) / 1000 / step));
};

// HOTP core (RFC 4226 §5.3): 8-byte big-endian counter → HMAC-SHA1 →
// dynamic truncation → code mod 10^digits.
function hotpCode(keyBytes, counter, digits) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", keyBytes).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(truncated % 10 ** digits).padStart(digits, "0");
}

// Generate the current TOTP code for a base32 secret.
// Options: { digits = 6, time = Date.now(), stepSeconds = 30 }.
export function generateCode(secret, { digits = TOTP_DIGITS_6, time = Date.now(), stepSeconds = TOTP_STEP_SECONDS } = {}) {
  assertSecretString(secret);
  assertDigits(digits);
  const key = base32Decode(secret);
  if (key.length === 0) throw new TypeError("secret must decode to non-empty bytes");
  return hotpCode(key, counterForTime(time, stepSeconds), digits);
}

// Constant-time string comparison (digit codes only). Returns false for
// differing lengths instead of throwing.
function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// Verify a code against a base32 secret, accepting `window` time steps of
// clock skew on either side (default ±1 step = ±30s). Options:
// { digits = 6, window = 1, time = Date.now(), stepSeconds = 30 }.
// Never throws for malformed input — returns false.
export function verifyCode(code, secret, { digits = TOTP_DIGITS_6, window = TOTP_DEFAULT_WINDOW, time = Date.now(), stepSeconds = TOTP_STEP_SECONDS } = {}) {
  const normalized = typeof code === "string" ? code.trim() : String(code);
  try {
    assertSecretString(secret);
    assertDigits(digits);
  } catch {
    return false;
  }
  if (!isNonNegativeInteger(window)) return false;
  if (!/^\d+$/.test(normalized)) return false;
  let key;
  try {
    key = base32Decode(secret);
    if (key.length === 0) return false;
  } catch {
    return false;
  }
  const center = counterForTime(time, stepSeconds);
  for (let step = -window; step <= window; step += 1) {
    if (constantTimeEqual(hotpCode(key, center + BigInt(step), digits), normalized)) return true;
  }
  return false;
}

// Build the otpauth:// provisioning URI shown as a QR code during
// enrollment, per the Google Authenticator Key URI format. The `issuer`
// and `account` are percent-encoded; never log or persist this URI beyond
// the enrollment screen.
export function provisioningUri({ issuer = "project-room", account, secret }) {
  if (typeof account !== "string" || account.length === 0) {
    throw new TypeError("account must be a non-empty string");
  }
  assertSecretString(secret);
  // base32Decode doubles as secret validation (throws on invalid alphabet).
  base32Decode(secret);
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secret.replace(/=+$/, "").toUpperCase(),
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS_6),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
