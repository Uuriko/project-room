// Scoped API-key issuance for agents (lane D).
//
// server/token-scopes.mjs checks scopes on caller-supplied opaque tokens but
// never generates secrets, binds nothing to an agent identity, and has no
// expiry or rotation. This module is the agent-facing issuance flow: the
// server generates the secret, stores only its SHA-256 hash, and binds the
// key to an agent identity with scoped permissions and an optional expiry.
// The secret is shown exactly once at issue (and once per rotation); list/
// verify outputs never include it.
//
// Pure module: all state is caller-owned (a Map), crypto is node:crypto,
// no network I/O. Frozen outputs; malformed inputs throw ApiKeyError
// (coded errors, ContractError-style validation).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

class ApiKeyError extends Error {
  constructor(code, message) { super(message); this.name = "ApiKeyError"; this.code = code; }
}
const fail = (code, message) => { throw new ApiKeyError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_api_key", message); };

export const API_KEY_PREFIX = "rak_";
const IDENTITY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE_PATTERN = /^[a-z0-9:_*-]+$/;
const MIN_SECRET_ENTROPY_BYTES = 24;

// The documented API-key scope vocabulary (RC-2026-09-18-019). These are
// the scopes the agent plug-in surface actually enforces — the single
// source of truth: the HTTP routes (server/agent-plugin-routes.mjs) and
// the agent manifest (server/agent-plugin-manifest.mjs) both read from
// here, so the documented vocabulary can never drift from enforcement.
// Issuance stays permissive on unknown scope strings (a key with an
// unknown scope simply grants nothing); the 403 insufficient_scope error
// names the required scope so a mis-scoped key is self-diagnosing.
export const API_KEY_SCOPES = Object.freeze([
  Object.freeze({
    scope: "directory:publish",
    description: "Publish and withdraw this identity's agent directory cards (signed cards).",
    routes: ["POST /api/agent-directory/cards", "DELETE /api/agent-directory/cards/:agentId"],
  }),
  Object.freeze({
    scope: "webhooks:manage",
    description: "Subscribe to, list, and delete this identity's webhook subscriptions.",
    routes: ["GET /api/agent-webhooks", "POST /api/agent-webhooks", "DELETE /api/agent-webhooks/:id"],
  }),
]);
// A scope ending in ":*" (e.g. "agent:*") grants every scope sharing its
// prefix, including scopes added in the future.
export const API_KEY_SCOPE_WILDCARD_NOTE = "prefix:* wildcard grants every scope with that prefix";

const sha256 = text => createHash("sha256").update(text).digest("hex");

// Create an agent API-key manager. store is a caller-owned Map (keyId -> record).
export function createAgentApiKeys({ store, clock, random } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  check(random === undefined || typeof random === "function", "random must be a function if given");
  const keys = store ?? new Map();
  const now = clock ?? Date.now;
  const newSecret = random ?? (() => base64url(randomBytes(MIN_SECRET_ENTROPY_BYTES)));

  const validateIssue = ({ identityId, scopes, expiresAt, label }) => {
    check(typeof identityId === "string" && IDENTITY_PATTERN.test(identityId),
      "identityId must match [A-Za-z0-9_-]{1,64}");
    check(Array.isArray(scopes) && scopes.length > 0, "scopes must be a non-empty array");
    check(scopes.every(s => typeof s === "string" && s.length > 0 && SCOPE_PATTERN.test(s)),
      "every scope must be a lowercase scope string ([a-z0-9:_*-]+)");
    check(expiresAt === undefined || (Number.isInteger(expiresAt) && expiresAt > 0),
      "expiresAt must be a positive integer ms epoch if given");
    check(label === undefined || (typeof label === "string" && label.length <= 80),
      "label must be at most 80 chars if given");
  };

  const publicRecord = record => Object.freeze({
    keyId: record.keyId,
    identityId: record.identityId,
    scopes: Object.freeze([...record.scopes]),
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revoked: record.revoked,
    lastUsedAt: record.lastUsedAt,
  });

  // Issue a key for an agent identity. Returns the secret ONCE — the
  // caller must show it to the agent now; it is never returned again.
  const issue = ({ identityId, scopes, expiresAt = null, label = null }) => {
    validateIssue({ identityId, scopes, expiresAt: expiresAt ?? undefined, label: label ?? undefined });
    const keyId = `${API_KEY_PREFIX}${base64url(randomBytes(12))}`;
    check(!keys.has(keyId), `key "${keyId}" already exists`);
    const secret = newSecret();
    check(typeof secret === "string" && secret.length >= 16, "random must return a secret string");
    const record = {
      keyId,
      keyHash: sha256(secret),
      identityId,
      scopes: Object.freeze([...new Set(scopes)]),
      label,
      createdAt: now(),
      expiresAt,
      revoked: false,
      lastUsedAt: null,
    };
    keys.set(keyId, record);
    return Object.freeze({ ...publicRecord(record), secret });
  };

  // Authenticate with a raw secret. Returns the public record; null when
  // unknown, revoked, or expired. Updates lastUsedAt on success.
  const verify = secret => {
    check(typeof secret === "string" && secret.length > 0, "secret must be a non-empty string");
    const digest = sha256(secret);
    for (const record of keys.values()) {
      const stored = Buffer.from(record.keyHash, "hex");
      const presented = Buffer.from(digest, "hex");
      if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
        if (record.revoked) return null;
        if (record.expiresAt !== null && now() >= record.expiresAt) return null;
        record.lastUsedAt = now();
        return publicRecord(record);
      }
    }
    return null;
  };

  // Rotate a key: the old secret stops working, a new secret is issued
  // (shown once). Scopes/identity/expiry carry over.
  const rotate = keyId => {
    check(typeof keyId === "string" && keyId.length > 0, "keyId must be a non-empty string");
    const record = keys.get(keyId);
    check(record, `unknown key "${keyId}"`);
    check(!record.revoked, `key "${keyId}" is revoked and cannot rotate`);
    const secret = newSecret();
    record.keyHash = sha256(secret);
    record.lastUsedAt = null;
    return Object.freeze({ ...publicRecord(record), secret });
  };

  const revoke = keyId => {
    check(typeof keyId === "string" && keyId.length > 0, "keyId must be a non-empty string");
    const record = keys.get(keyId);
    check(record, `unknown key "${keyId}"`);
    check(!record.revoked, `key "${keyId}" is already revoked`);
    record.revoked = true;
    return publicRecord(record);
  };

  // List public key records for an identity — never secrets.
  const keysForIdentity = identityId => {
    check(typeof identityId === "string" && identityId.length > 0, "identityId must be a non-empty string");
    return Object.freeze([...keys.values()]
      .filter(r => r.identityId === identityId)
      .map(publicRecord));
  };

  // Scope check with prefix wildcards ("rooms:*"), mirroring token-scopes.
  const grants = (keyId, requiredScope) => {
    check(typeof keyId === "string" && keyId.length > 0, "keyId must be a non-empty string");
    check(typeof requiredScope === "string" && requiredScope.length > 0,
      "requiredScope must be a non-empty string");
    const record = keys.get(keyId);
    if (!record || record.revoked) return false;
    if (record.expiresAt !== null && now() >= record.expiresAt) return false;
    return record.scopes.some(scope => {
      if (scope === requiredScope) return true;
      if (scope.endsWith(":*")) return requiredScope.startsWith(scope.slice(0, -1));
      return false;
    });
  };

  return Object.freeze({ issue, verify, rotate, revoke, keysForIdentity, grants });
}
export { ApiKeyError };

function base64url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
