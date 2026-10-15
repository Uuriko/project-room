// runOnce — THE idempotency primitive for mutating endpoints (decision #19b).
//
// The pattern this replaces was hand-rolled in 70+ files: look up a prior
// journal row by (scope…, requestId); if found, verify a fingerprint and
// replay the stored outcome; if the fingerprint differs, fail 409; otherwise
// execute and journal the outcome. Each copy was an audit surface of its own
// (the repo root carries six B-series audit docs for this one concern).
//
// Two shapes, one flow:
//
//   executeOnce({ find, fingerprint, execute, record, conflictCode, conflictMessage })
//     The pure control flow over a caller-owned journal. Existing journals
//     (buyer_signoff_requests, private_attention_commands, …) are retained
//     business records — immutability triggers, purge-registry and
//     writer-fence entries reference them — so their storage stays with the
//     owner; only the find → conflict → execute → record flow is shared.
//
//   runOnce(db, scope, requestId, execute, opts)
//     The table-backed form for NEW endpoints (and migrations whose journal
//     is a pure replay cache): one shared `request_replays` table, scope is a
//     caller-chosen partition string (e.g. `attention:<roomId>:<memberId>`).
//
// Contract (identical for both shapes):
//   - Returns { result, replayed }. replayed=false: execute() ran and its
//     result was journaled. replayed=true: execute() did NOT run; result is
//     the journaled outcome of the first call.
//   - A supplied fingerprint that differs from the journaled one fails 409
//     (default code "idempotency_conflict"; callers with a pinned legacy
//     code pass conflictCode/conflictMessage).
//   - If execute() throws, nothing is journaled — a later retry executes.
//   - Callers whose execute() has side effects MUST call inside the same
//     store.transaction as those effects, exactly as the hand-rolled code
//     did, so effect and journal commit or roll back together.
//   - execute() must return a JSON-serializable value (the journaled
//     outcome). Returning undefined is a programmer error.

import { ServiceError } from "./service-error.mjs";
import { validId } from "../src/events.js";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Adopters whose module predates ServiceError (e.g. buyer-signoff throws
// plain Errors carrying {status, code}) pass their own throwError so the
// exact error class their callers already handle is preserved.

export const runOnceSchema = `
  CREATE TABLE IF NOT EXISTS request_replays (
    scope TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT, result_json TEXT NOT NULL CHECK(json_valid(result_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(scope, request_id)
  );
  CREATE TRIGGER IF NOT EXISTS request_replays_no_update BEFORE UPDATE ON request_replays BEGIN SELECT RAISE(ABORT,'request replays are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS request_replays_no_delete BEFORE DELETE ON request_replays BEGIN SELECT RAISE(ABORT,'request replays are retained'); END;
`;

export function ensureRunOnceSchema(db) {
  db.exec(runOnceSchema);
}

// The shared control flow. `find()` returns { fingerprint, result } | null
// (result already parsed). `record(result)` journals a fresh outcome.
export function executeOnce({ find, fingerprint = null, execute, record, conflictCode = "idempotency_conflict", conflictMessage = "Request ID already used for different content.", throwError = fail }) {
  if (typeof find !== "function" || typeof execute !== "function" || typeof record !== "function")
    throw new TypeError("executeOnce requires find, execute and record functions");
  const prior = find();
  if (prior) {
    if (fingerprint !== null && prior.fingerprint !== null && prior.fingerprint !== undefined && prior.fingerprint !== fingerprint)
      throwError(409, conflictCode, conflictMessage);
    return { result: prior.result, replayed: true };
  }
  const result = execute();
  if (result === undefined) throw new TypeError("runOnce execute() must return a JSON-serializable outcome, not undefined");
  record(result);
  return { result, replayed: false };
}

// Table-backed form over the shared request_replays journal.
export function runOnce(db, scope, requestId, execute, { fingerprint = null, conflictCode, conflictMessage, throwError, now = null } = {}) {
  if (typeof scope !== "string" || !scope || scope.length > 300) fail(422, "invalid_request_id", "runOnce scope must be a non-empty string of at most 300 characters.");
  if (!validId(requestId)) fail(422, "invalid_request_id", "Supply a stable request ID.");
  ensureRunOnceSchema(db);
  return executeOnce({
    fingerprint, conflictCode, conflictMessage, throwError,
    find: () => {
      const row = db.prepare("SELECT fingerprint, result_json FROM request_replays WHERE scope=? AND request_id=?").get(scope, requestId);
      return row ? { fingerprint: row.fingerprint, result: JSON.parse(row.result_json) } : null;
    },
    execute,
    record: result => {
      db.prepare("INSERT INTO request_replays(scope, request_id, fingerprint, result_json, created_at) VALUES(?,?,?,?,?)")
        .run(scope, requestId, fingerprint, JSON.stringify(result), now ?? Date.now());
    },
  });
}
