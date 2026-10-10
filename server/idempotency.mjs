// Idempotency-key + replay-protection utilities (200-hard-tasks #3).
// Two-level keys: INTENT keys (business: one payout per job) and EVENT keys
// (chain: one processing per chain event). A payout executes only when its
// intent key is new; a reorged-then-reincluded chain event replays with the
// same event key and is deduped. Pure in-memory store (production: SQLite);
// no I/O, no network.
import { createHash } from "node:crypto";

export const IDEM_VERSION = "v1";
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

const KEY_RE = /^idem_v1_[a-z0-9-]{1,32}_[0-9a-f]{32}$/;

// Canonical JSON for key derivation: sorted keys, no whitespace.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

// Deterministic key: the same operation params always produce the same key,
// so clients can retry safely and reorged events dedupe naturally.
export function deriveKey({ scope, params }) {
  if (!scope || !/^[a-z0-9-]{1,32}$/.test(scope)) {
    throw new Error("deriveKey: scope must be 1-32 lowercase alphanumerics/dashes");
  }
  if (!params || typeof params !== "object") throw new Error("deriveKey: params object required");
  const hash = createHash("sha256").update(canonical(params)).digest("hex").slice(0, 32);
  return `idem_${IDEM_VERSION}_${scope}_${hash}`;
}

// Chain-event key: the same chain event (even after a reorg + reinclusion)
// maps to the same key.
export function deriveEventKey({ chainId, txHash, logIndex }) {
  if (!chainId || !txHash || !Number.isInteger(logIndex) || logIndex < 0) {
    throw new Error("deriveEventKey: chainId, txHash, integer logIndex required");
  }
  return deriveKey({ scope: "chain-event", params: { chainId, txHash, logIndex } });
}

export function validateKey(key) {
  return typeof key === "string" && KEY_RE.test(key);
}

export class IdempotencyError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Dedup store record: { key, status, result, error, createdAt, updatedAt, expiresAt }.
// status: in_progress | completed | failed
export function createDedupStore({ ttlMs = DEFAULT_TTL_MS, clock = () => Date.now() } = {}) {
  const records = new Map();

  function get(key) {
    const rec = records.get(key);
    if (!rec) return null;
    if (rec.expiresAt <= clock()) {
      records.delete(key);
      return null;
    }
    return { ...rec };
  }

  // Begin an operation: throws IDEM_CONFLICT if already in_progress,
  // returns { replayed: true, result } if already completed.
  function begin(key) {
    if (!validateKey(key)) throw new IdempotencyError("IDEM_BAD_KEY", `malformed idempotency key: ${key}`);
    const existing = get(key);
    if (existing) {
      if (existing.status === "in_progress") {
        throw new IdempotencyError("IDEM_CONFLICT", `operation ${key} already in progress`, { key });
      }
      if (existing.status === "completed") {
        return { replayed: true, result: existing.result };
      }
      // failed: fall through and retry (record is replaced below)
    }
    const now = clock();
    records.set(key, { key, status: "in_progress", result: null, error: null, createdAt: now, updatedAt: now, expiresAt: now + ttlMs });
    return { replayed: false };
  }

  function complete(key, result) {
    const rec = records.get(key);
    if (!rec || rec.status !== "in_progress") {
      throw new IdempotencyError("IDEM_STATE", `cannot complete ${key}: not in progress`);
    }
    const now = clock();
    records.set(key, { ...rec, status: "completed", result: result ?? null, updatedAt: now, expiresAt: now + ttlMs });
  }

  function fail(key, error) {
    const rec = records.get(key);
    if (!rec || rec.status !== "in_progress") {
      throw new IdempotencyError("IDEM_STATE", `cannot fail ${key}: not in progress`);
    }
    const now = clock();
    records.set(key, { ...rec, status: "failed", error: String(error && error.message || error), updatedAt: now, expiresAt: now + ttlMs });
  }

  function stats() {
    let inProgress = 0, completed = 0, failed = 0;
    for (const rec of records.values()) {
      if (rec.expiresAt <= clock()) continue;
      if (rec.status === "in_progress") inProgress++;
      else if (rec.status === "completed") completed++;
      else failed++;
    }
    return { inProgress, completed, failed, tracked: records.size };
  }

  return { get, begin, complete, fail, stats };
}

// Exactly-once executor: runs fn() once per key; replays return the cached
// result; concurrent duplicates get IDEM_CONFLICT (HTTP 409); failures are
// retryable (the next begin() for the key starts a fresh attempt).
export async function executeOnce(store, key, fn) {
  const begun = store.begin(key);
  if (begun.replayed) return { result: begun.result, replayed: true };
  try {
    const result = await fn();
    store.complete(key, result);
    return { result, replayed: false };
  } catch (e) {
    store.fail(key, e);
    throw e;
  }
}
