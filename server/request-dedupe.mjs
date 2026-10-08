// Request-dedupe store (crash-recovery guild, B1).
//
// Server-side half of requestId idempotency for the work-claim mutating
// routes (create/update/renew/release/review in server/work-claim-routes.mjs).
// The client persists its requestId before sending (PHOENIX: 0% duplicates);
// the server records requestId -> result here AFTER a successful mutation so
// a retried mutation replays the stored result instead of re-applying.
//
// Call order per mutation: check(requestId) first; on { duplicate:true }
// return the stored result without touching state; otherwise run the
// mutation and record(requestId, result) only after it succeeds.
//
// stdlib only. db is a node:sqlite DatabaseSync.

export const MAX_REQUEST_ID_LEN = 128;

const SCHEMA =
  "CREATE TABLE IF NOT EXISTS request_dedupe(" +
  "request_id TEXT PRIMARY KEY, " +
  "result_json TEXT NOT NULL, " +
  "created_at INTEGER NOT NULL)";

// One-shot DDL guard per database handle, matching the convention of
// server/abuse-rate-buckets.mjs.
const readyTables = new WeakSet();

export function ensureDedupeTable(db) {
  if (readyTables.has(db)) return;
  db.exec(SCHEMA);
  readyTables.add(db);
}

function isValidRequestId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_REQUEST_ID_LEN
  );
}

/**
 * Extract a valid requestId from a parsed JSON request body.
 * Returns the requestId string iff data.requestId is a string of 1..128
 * chars; otherwise null. Never throws, on any input.
 */
export function readRequestId(data) {
  try {
    if (data === null || data === undefined) return null;
    if (typeof data !== "object") return null;
    const id = data.requestId;
    return isValidRequestId(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Create the { check, record, prune } store over a prepared database.
 * Rows expire ttlMs after creation (default 24h). Expired rows behave as
 * unseen until prune() deletes them.
 */
export function createDedupeStore(db, { ttlMs = 86_400_000 } = {}) {
  ensureDedupeTable(db);
  const getStmt = db.prepare(
    "SELECT result_json, created_at FROM request_dedupe WHERE request_id = ?"
  );
  const putStmt = db.prepare(
    "INSERT OR REPLACE INTO request_dedupe(request_id, result_json, created_at) VALUES (?, ?, ?)"
  );
  const pruneStmt = db.prepare(
    "DELETE FROM request_dedupe WHERE created_at <= ?"
  );

  const isLive = (createdAt, nowMs) => nowMs - createdAt < ttlMs;

  return {
    /**
     * { duplicate:false } for null/invalid/unseen/expired ids;
     * { duplicate:true, result } (result = parsed JSON) for a live entry.
     * A corrupt row (never written by record()) is treated as unseen.
     */
    check(requestId) {
      if (!isValidRequestId(requestId)) return { duplicate: false };
      const row = getStmt.get(requestId);
      if (!row) return { duplicate: false };
      if (!isLive(row.created_at, Date.now())) return { duplicate: false };
      let result;
      try {
        result = JSON.parse(row.result_json);
      } catch {
        return { duplicate: false };
      }
      return { duplicate: true, result };
    },

    /**
     * Store requestId -> JSON(result) with created_at = now. Call ONLY after
     * a successful mutation. Invalid requestId -> silent no-op (never
     * throws). An unserializable result throws BEFORE any write so garbage
     * is never stored.
     */
    record(requestId, result) {
      if (!isValidRequestId(requestId)) return;
      let json;
      try {
        json = JSON.stringify(result);
      } catch (err) {
        throw new Error(
          `request-dedupe: result is not JSON-serializable (requestId ${JSON.stringify(
            requestId
          )}): ${err instanceof Error ? err.message : String(err)}`
        );
      }
      if (json === undefined) {
        throw new Error(
          `request-dedupe: result is not JSON-serializable (requestId ${JSON.stringify(
            requestId
          )}): JSON.stringify returned undefined`
        );
      }
      putStmt.run(requestId, json, Date.now());
    },

    /**
     * Delete rows expired as of nowMs. Returns the deleted count.
     */
    prune(nowMs = Date.now()) {
      return pruneStmt.run(nowMs - ttlMs).changes;
    },
  };
}
