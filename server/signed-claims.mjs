// Signed agent claims (B024). Pure HMAC-based claim signing and
// verification for cross-room agent actions. A claim binds an agent id,
// an action, a payload, and an expiry. sign() produces a claim token;
// verify() checks the signature and expiry. Uses Node's built-in crypto
// (no external deps). The module is pure and dependency-free (time is
// injected). Frozen outputs; malformed inputs throw ClaimError. Key
// distribution is a later slice.
import { createHmac, timingSafeEqual } from "node:crypto";
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
