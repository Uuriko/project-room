// Identity secrets are 32 random bytes (`pri_` + base64url). That space is
// 2^256, so a database leak cannot be brute-forced and the secret is not
// recoverable from the stored verifier. Per-request scrypt (N=16384) was
// holding the single Durable Object's input gate closed on every bearer
// call. New and upgraded rows store HMAC-SHA256 instead. Legacy sha256 and
// v2 scrypt rows still verify; the slow hash runs once per secret per
// isolate, then the fast verifier is what the next request looks up.
import { createHash, createHmac, scryptSync } from "node:crypto";

export const IDENTITY_HASH_SALT = "project-room-agent-identity-v2";
export const IDENTITY_HASH_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
export const IDENTITY_V2_PREFIX = "v2:";
export const IDENTITY_FAST_PREFIX = "v3:";
const HMAC_KEY = "project-room-agent-identity-v3";
const SCRYPT_CACHE_MAX = 256;

const scryptCache = new Map();
let scryptComputations = 0;

export function identityScryptComputations() {
  return scryptComputations;
}

export function legacyIdentityHash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

// Keyed hash. The key is domain-separated from the v2 scrypt salt so a v2
// digest can never be mistaken for a v3 verifier. The stored value is not
// the secret and not a bare sha256 of it.
export function fastIdentityHash(secret) {
  return IDENTITY_FAST_PREFIX + createHmac("sha256", HMAC_KEY).update(secret).digest("hex");
}

export function isFastIdentityHash(stored) {
  return typeof stored === "string" && stored.startsWith(IDENTITY_FAST_PREFIX) && /^v3:[a-f0-9]{64}$/.test(stored);
}

export function isV2IdentityHash(stored) {
  return typeof stored === "string" && stored.startsWith(IDENTITY_V2_PREFIX);
}

export function scryptIdentityHash(secret) {
  const key = createHash("sha256").update(String(secret)).digest("base64url");
  const hit = scryptCache.get(key);
  if (hit) {
    scryptCache.delete(key);
    scryptCache.set(key, hit);
    return hit;
  }
  const started = Date.now();
  const digest = scryptSync(secret, IDENTITY_HASH_SALT, 32, IDENTITY_HASH_PARAMS).toString("hex");
  scryptComputations += 1;
  console.info(JSON.stringify({ event: "room.identity_scrypt", ms: Date.now() - started }));
  const stored = `${IDENTITY_V2_PREFIX}${digest}`;
  scryptCache.set(key, stored);
  while (scryptCache.size > SCRYPT_CACHE_MAX) scryptCache.delete(scryptCache.keys().next().value);
  return stored;
}

export function hashIdentitySecret(secret) {
  return fastIdentityHash(secret);
}
