// Matchmaking P1 — append-only match journal + idempotency records
// (matchmaking-plan-2026-09-30.md §5/§16).
//
// match_events is the audit trail and the engine's feedback loop: profile
// entered/updated, matches computed (counts + top ids, never full PII),
// invite sent/accepted/declined (P5), match converted (P5). It is
// append-only — this module exports no update and no delete. The journal is
// what lets the engine learn which matches convert without storing any
// synthetic score on the profile.
//
// match_idempotency holds replay records for the mutating matchmaking routes
// (mirrors bounty_idempotency v2 semantics): a replayed key returns the
// original status + body without re-executing; a key reused with different
// input is a 409. The replay scope is (caller, route, key) so one member can
// never replay another member's response.
//
// Storage contract: same as server/match-profiles.mjs — the module never
// creates its own tables; both must be provisioned by the wiring layer
// (registered in server/writer-fence.mjs unfencedAdditiveTables). The db
// handle, clock, and id generator are injected.

import { createHash, randomUUID } from "node:crypto";

// Local error (mirrors server/store.mjs); see server/match-profiles.mjs for
// why we don't import from store.mjs.
class MatchEventError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "MatchEventError";
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => { throw new MatchEventError(status, code, message); };
const check = (condition, status, code, message) => { if (!condition) fail(status, code, message); };

export const MATCH_EVENTS_TABLE = "match_events";
export const MATCH_IDEMPOTENCY_TABLE = "match_idempotency";

export const matchEventsSchema = `
  CREATE TABLE IF NOT EXISTS match_events (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    type TEXT NOT NULL,
    data_json TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS match_events_identity
    ON match_events(room_id, identity_id, created_at);
`;

export const matchIdempotencySchema = `
  CREATE TABLE IF NOT EXISTS match_idempotency (
    room_id TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    route TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    caller TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, scope_key)
  );
`;

// Journal event types used in P1. P5 adds invite.* and match.converted;
// the type column is intentionally not CHECK-constrained so later phases
// extend it without a migration.
export const MATCH_EVENT_TYPES = Object.freeze([
  "profile.entered",
  "profile.updated",
  "matches.viewed",
]);

// Recursive canonical JSON (mirrors src/audit-receipts.mjs): object keys
// sorted at every level, arrays in order. Used for idempotency request
// hashes so equivalent payloads hash identically.
const canonicalJson = value => {
  if (value === null || value === undefined) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (t === "object") {
    return "{" + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ":" + canonicalJson(value[k])).join(",") + "}";
  }
  throw new TypeError("canonicalJson: unsupported type " + t);
};
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");

const eventView = row => row ? Object.freeze({
  id: row.id,
  roomId: row.room_id,
  identityId: row.identity_id,
  type: row.type,
  data: row.data_json ? JSON.parse(row.data_json) : null,
  createdAt: row.created_at,
}) : null;

function requireTables(db) {
  for (const table of [MATCH_EVENTS_TABLE, MATCH_IDEMPOTENCY_TABLE]) {
    const provisioned = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!provisioned) {
      fail(500, "schema-not-provisioned",
        `${table} is not provisioned on this database — the wiring layer must exec the matchmaking schemas at store open (see server/writer-fence.mjs).`);
    }
  }
}

export function createMatchEvents({ db, clock, id } = {}) {
  check(db && typeof db.prepare === "function",
    500, "misconfigured", "db (node:sqlite DatabaseSync) is required");
  requireTables(db);
  const now = clock ?? Date.now;
  const newId = id ?? (() => "mev_" + randomUUID().replace(/-/g, "").slice(0, 12));

  // Append-only: there is deliberately no update and no delete. History is
  // the product — the engine's feedback loop reads it, nobody rewrites it.
  const append = ({ roomId, identityId, type, data = null }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof identityId === "string" && identityId.length >= 1 && identityId.length <= 256,
      422, "invalid_identity", "identityId must be 1..256 characters");
    check(typeof type === "string" && type.length >= 1 && type.length <= 64,
      422, "invalid_event_type", "type must be 1..64 characters");
    if (data !== null && data !== undefined) {
      check(typeof data === "object" && !Array.isArray(data), 422, "invalid_event_data",
        "data must be an object or null");
    }
    const eventId = newId();
    db.prepare(`INSERT INTO match_events (id, room_id, identity_id, type, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(eventId, roomId, identityId, type, data ? JSON.stringify(data) : null, now());
    return eventView(db.prepare("SELECT * FROM match_events WHERE id = ?").get(eventId));
  };

  const list = ({ roomId, identityId, limit = 50 }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    check(typeof identityId === "string" && identityId.length >= 1 && identityId.length <= 256,
      422, "invalid_identity", "identityId must be 1..256 characters");
    check(Number.isInteger(limit) && limit >= 1 && limit <= 500,
      422, "invalid_limit", "limit must be 1..500");
    const rows = db.prepare(
      `SELECT * FROM match_events WHERE room_id = ? AND identity_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`).all(roomId, identityId, limit);
    // NOTE: newest-first is the UI-friendly default. Tests asserting
    // causal order reverse it client-side; the seq column is the source
    // of truth for append order.
    return Object.freeze(rows.map(eventView));
  };

  return Object.freeze({ append, list });
}

export function createMatchIdempotency({ db, clock } = {}) {
  check(db && typeof db.prepare === "function",
    500, "misconfigured", "db (node:sqlite DatabaseSync) is required");
  requireTables(db);
  const now = clock ?? Date.now;

  // Idempotent execution for a mutating route. A null/undefined key skips
  // the journal (the caller didn't ask for replay protection). Otherwise the
  // replay scope is (caller, route, key): a replayed key returns the original
  // status + body without re-executing; the same key with different input is
  // a 409; one member can never replay another member's response. The thunk
  // returns { status, body } so the first execution decides its own status
  // (e.g. 201 on create vs 200 on update).
  const runIdempotent = ({ roomId, route, key, caller, requestHash, thunk }) => {
    check(typeof roomId === "string" && roomId.length > 0,
      422, "invalid_room", "roomId must be a non-empty string");
    if (key === null || key === undefined) return { replayed: false, ...thunk() };
    check(typeof key === "string" && key.length >= 1 && key.length <= 128,
      422, "invalid_idempotency_key", "idempotency key must be 1..128 characters");
    check(typeof route === "string" && route.length > 0,
      500, "misconfigured", "route is required");
    check(typeof caller === "string" && caller.length > 0,
      500, "misconfigured", "caller is required");
    const hash = requestHash ?? null;
    const scopeKey = "v1:" + sha256([caller, route, key].join("\u0000"));
    const existing = db.prepare(
      "SELECT status, response, request_hash FROM match_idempotency WHERE room_id = ? AND scope_key = ?")
      .get(roomId, scopeKey);
    if (existing) {
      if (existing.request_hash !== hash) {
        fail(409, "idempotency_key_reused", "Idempotency key was already used with different input");
      }
      return { replayed: true, status: existing.status, body: JSON.parse(existing.response) };
    }
    const { status, body } = thunk();
    db.prepare(`INSERT INTO match_idempotency
      (room_id, scope_key, route, status, response, request_hash, caller, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(roomId, scopeKey, route, status, JSON.stringify(body), hash, caller, now());
    return { replayed: false, status, body };
  };

  return Object.freeze({ runIdempotent, canonicalJson, sha256 });
}

export { MatchEventError };
