// Identity secrets are 32 random bytes (`pri_` + base64url). That space is
// 2^256, so a database leak cannot be brute-forced and the secret is not
// recoverable from the stored verifier. Per-request scrypt (N=16384) was
// holding the single Durable Object's input gate closed on every bearer
// call. New and upgraded rows store HMAC-SHA256. Legacy sha256 and v2
// scrypt rows still verify. Scrypt runs only when a candidate row is still
// v2, at most once per secret per request, then the row stores the HMAC.
import { createHash, createHmac, scryptSync } from "node:crypto";

export const IDENTITY_HASH_SALT = "project-room-agent-identity-v2";
export const IDENTITY_HASH_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
export const IDENTITY_V2_PREFIX = "v2:";
export const IDENTITY_FAST_PREFIX = "v3:";
// Worker secret / Node env. Unset uses the fallback below so a deploy that
// has not been given the secret still verifies and issues verifiers.
export const IDENTITY_HASH_KEY_ENV = "ROOM_IDENTITY_HASH_KEY";
// Built-in key for local Node, self-hosted installs, and a Worker deploy
// that has not set ROOM_IDENTITY_HASH_KEY. Not a substitute for the Worker
// secret once an operator sets one: verification accepts this key as well,
// so adding or omitting the secret cannot strand a verifier written with it.
export const IDENTITY_HASH_KEY_FALLBACK = "project-room-agent-identity-v3";
const SCRYPT_CACHE_MAX = 256;

const scryptCache = new Map();
let scryptComputations = 0;

export function identityScryptComputations() {
  return scryptComputations;
}

export function legacyIdentityHash(secret) {
  return createHash("sha256").update(secret).digest("hex");
}

// `source` is a key string, null/undefined (fallback only), or an env object
// such as process.env. A string shorter than 16 characters is ignored.
export function configuredIdentityHashKey(source) {
  const value = typeof source === "string" ? source : source?.[IDENTITY_HASH_KEY_ENV];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length < 16) return null;
  return trimmed;
}

// Active key first (what new rows store). The fallback is always accepted
// so rows written before the secret was set, or by a local process, still
// verify after the secret is added — and rows written with the fallback
// still verify when the secret is absent.
export function identityHashKeys(source) {
  const configured = configuredIdentityHashKey(source);
  if (!configured || configured === IDENTITY_HASH_KEY_FALLBACK) return [IDENTITY_HASH_KEY_FALLBACK];
  return [configured, IDENTITY_HASH_KEY_FALLBACK];
}

function hmacVerifier(secret, key) {
  return IDENTITY_FAST_PREFIX + createHmac("sha256", key).update(String(secret)).digest("hex");
}

export function fastIdentityHash(secret, source) {
  return hmacVerifier(secret, identityHashKeys(source)[0]);
}

export function fastIdentityHashCandidates(secret, source) {
  return identityHashKeys(source).map(key => hmacVerifier(secret, key));
}

export function isFastIdentityHash(stored) {
  return typeof stored === "string" && stored.startsWith(IDENTITY_FAST_PREFIX) && /^v3:[a-f0-9]{64}$/.test(stored);
}

export function isV2IdentityHash(stored) {
  return typeof stored === "string" && stored.startsWith(IDENTITY_V2_PREFIX) && /^v2:[a-f0-9]{64}$/.test(stored);
}

function scryptCacheKey(secret) {
  return createHash("sha256").update(String(secret)).digest("base64url");
}

// Drops a cached scrypt verifier. Rotate and revoke call this so the
// previous secret's KDF output does not stay in memory.
export function forgetIdentityVerifier(secret) {
  if (typeof secret !== "string" || secret.length === 0) return;
  scryptCache.delete(scryptCacheKey(secret));
}

export function scryptIdentityHash(secret) {
  const key = scryptCacheKey(secret);
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

export function hashIdentitySecret(secret, source) {
  return fastIdentityHash(secret, source);
}
