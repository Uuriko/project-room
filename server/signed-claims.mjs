// Signed agent claims (B024). Two signing modes:
//
// - HMAC shared-secret claims (signClaim/verifyClaim): the original mode.
//   Key distribution is a later slice — which this module's public-key mode
//   now answers.
// - Ed25519 public-key claims (signPubkeyClaim/verifyPubkeyClaim): the
//   agent signs with its Ed25519 identity key and the verifier checks the
//   signature against the keys registered for the agent id in the
//   agent-key registry (server/agent-key-registry.mjs) — no shared secret.
//   The token is prefixed "ed1" so the two modes never confuse each other.
//
// The module is pure and dependency-free (time is injected; the key
// directory is supplied as entries or a resolver function). Frozen outputs;
// malformed inputs throw ClaimError.
import { createHmac, createPrivateKey, createPublicKey, sign as edSign, timingSafeEqual, verify as edVerify } from "node:crypto";
class ClaimError extends Error { constructor(code, message) { super(message); this.name = "ClaimError"; this.code = code; } }
const fail = (code, message) => { throw new ClaimError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_claim", message); };
// Canonical encoding: base64url of JSON with sorted keys.
const encode = obj => {
  const sorted = Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));
  return Buffer.from(JSON.stringify(sorted)).toString("base64url");
};
const decode = str => {
  try {
    return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
  } catch {
    fail("invalid_claim", "malformed claim token");
  }
};
// Sign a claim. secret is the shared HMAC key. ttlMs is claim lifetime.
export function signClaim({ agentId, action, payload, secret, ttlMs = 300000, now }) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  check(typeof action === "string" && action.length > 0, "action must be a non-empty string");
  check(payload !== null && typeof payload === "object", "payload must be an object");
  check(typeof secret === "string" && secret.length >= 32, "secret must be ≥32 chars");
  check(Number.isInteger(ttlMs) && ttlMs > 0, "ttlMs must be a positive integer");
  const clock = now ?? (() => Date.now());
  check(typeof clock === "function", "now must be a function if given");
  const issuedAt = clock();
  const body = { agentId, action, payload, issuedAt, expiresAt: issuedAt + ttlMs };
  const bodyB64 = encode(body);
  const sig = createHmac("sha256", secret).update(bodyB64).digest("base64url");
  return `${bodyB64}.${sig}`;
}
// Verify a claim token. Returns the decoded claim on success.
export function verifyClaim({ token, secret, now }) {
  check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
  check(typeof secret === "string" && secret.length >= 32, "secret must be ≥32 chars");
  const clock = now ?? (() => Date.now());
  check(typeof clock === "function", "now must be a function if given");
  const parts = token.split(".");
  check(parts.length === 2, "malformed claim token");
  const [bodyB64, sig] = parts;
  const expected = createHmac("sha256", secret).update(bodyB64).digest("base64url");
  const sigBuf = Buffer.from(sig, "base64url");
  const expBuf = Buffer.from(expected, "base64url");
  check(sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf),
    "invalid claim signature");
  const claim = decode(bodyB64);
  check(typeof claim.agentId === "string" && typeof claim.action === "string",
    "malformed claim body");
  check(Number.isInteger(claim.expiresAt), "malformed claim expiry");
  check(clock() <= claim.expiresAt, "claim has expired");
  return Object.freeze({ ...claim, payload: Object.freeze({ ...claim.payload }) });
}
export { ClaimError };

// Ed25519 claim tokens. Key wire format matches agent-card-signing.mjs:
// canonical base64 of the 32-byte public key / 32-byte private seed.
export const PUBKEY_TOKEN_PREFIX = "ed1";

// Fixed PKCS#8 DER prefix for an Ed25519 private key (RFC 8410): lets us
// import a raw 32-byte seed without keeping the full DER around.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

const decodeKeyBytes = (value, expectedLength, label) => {
  check(typeof value === "string" && value.length > 0, `${label} must be a base64 string`);
  const bytes = Buffer.from(value, "base64");
  // Canonical base64 spelling (no stray whitespace, correct padding) so
  // keys compare byte-identically everywhere.
  check(bytes.length === expectedLength && bytes.toString("base64") === value,
    `${label} must be canonical base64 of ${expectedLength} bytes`);
  return bytes;
};

const importEd25519Public = publicKey => {
  const raw = decodeKeyBytes(publicKey, 32, "publicKey");
  return createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
    format: "jwk",
  });
};

const importEd25519Private = privateKey => {
  const seed = decodeKeyBytes(privateKey, 32, "privateKey");
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
};

// Sign a claim with an Ed25519 identity key. privateKey is the canonical
// base64 32-byte seed issued (once) at identity creation.
export function signPubkeyClaim({ agentId, action, payload, privateKey, ttlMs = 300000, now }) {
  check(typeof agentId === "string" && agentId.length > 0, "agentId must be a non-empty string");
  check(typeof action === "string" && action.length > 0, "action must be a non-empty string");
  check(payload !== null && typeof payload === "object", "payload must be an object");
  const key = importEd25519Private(privateKey);
  check(Number.isInteger(ttlMs) && ttlMs > 0, "ttlMs must be a positive integer");
  const clock = now ?? (() => Date.now());
  check(typeof clock === "function", "now must be a function if given");
  const issuedAt = clock();
  const body = { agentId, action, payload, issuedAt, expiresAt: issuedAt + ttlMs };
  const bodyB64 = encode(body);
  const sig = edSign(null, Buffer.from(bodyB64, "utf8"), key).toString("base64url");
  return `${PUBKEY_TOKEN_PREFIX}.${bodyB64}.${sig}`;
}

// Verify an Ed25519 claim token. keysFor is either an array of registry key
// entries or a function (agentId) => entries, where an entry is
// { publicKey, validFrom, validUntil, revokedAt } as returned by
// AgentKeyRegistry#keysFor. The claim verifies only when a registered key
// whose validity window covers the claim's issuedAt verifies the signature:
// validFrom <= issuedAt < min(validUntil, revokedAt). Verification binds
// issuedAt — not verify-time — to the window, so a claim signed before a
// rotation or revocation still verifies afterwards.
export function verifyPubkeyClaim({ token, keysFor, now }) {
  check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
  const clock = now ?? (() => Date.now());
  check(typeof clock === "function", "now must be a function if given");
  const parts = token.split(".");
  check(parts.length === 3 && parts[0] === PUBKEY_TOKEN_PREFIX, "not an Ed25519 claim token");
  const [, bodyB64, sigB64] = parts;
  const sig = Buffer.from(sigB64, "base64url");
  // Canonical base64url spelling so a mangled signature cannot slip through
  // a lenient decode.
  check(sig.length === 64 && sig.toString("base64url") === sigB64, "malformed claim signature");
  const claim = decode(bodyB64);
  check(typeof claim.agentId === "string" && typeof claim.action === "string",
    "malformed claim body");
  check(Number.isInteger(claim.issuedAt), "malformed claim issue time");
  check(Number.isInteger(claim.expiresAt), "malformed claim expiry");
  const entries = typeof keysFor === "function" ? keysFor(claim.agentId) : keysFor;
  check(Array.isArray(entries), "keysFor must be an array of key entries or a function returning one");
  const bodyBytes = Buffer.from(bodyB64, "utf8");
  const verified = entries.some(entry => {
    if (!entry || typeof entry.publicKey !== "string") return false;
    if (!Number.isInteger(entry.validFrom) || entry.validFrom > claim.issuedAt) return false;
    const windowEnd = entry.validUntil ?? Infinity;
    const revokeEnd = entry.revokedAt ?? Infinity;
    if (claim.issuedAt >= Math.min(windowEnd, revokeEnd)) return false;
    try {
      return edVerify(null, bodyBytes, importEd25519Public(entry.publicKey), sig);
    } catch {
      return false; // A malformed registered key is a non-match, never a throw.
    }
  });
  check(verified, "no registered key verifies this claim");
  check(clock() <= claim.expiresAt, "claim has expired");
  return Object.freeze({ ...claim, payload: Object.freeze({ ...claim.payload }) });
}
