import { validId } from "../src/events.js";

// This reservation never expires or transfers. A lost host may still be writing.
// Status is operational metadata, not a message or an answer-basis revision.
export const requestRunSchema = `
  CREATE TABLE IF NOT EXISTS request_runs (
    room_id TEXT NOT NULL, opening_id TEXT NOT NULL, request_id TEXT NOT NULL,
    member_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('working','result_ready','needs_attention','delivered')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,opening_id)
  );
  CREATE TRIGGER IF NOT EXISTS request_run_owner_immutable BEFORE UPDATE ON request_runs
  WHEN NEW.room_id != OLD.room_id OR NEW.opening_id != OLD.opening_id
    OR NEW.request_id != OLD.request_id OR NEW.member_id != OLD.member_id OR NEW.attempt_id != OLD.attempt_id
  BEGIN SELECT RAISE(ABORT,'Request execution ownership is permanent'); END;
`;
const fail = (code, message, status = 409) => { throw Object.assign(new Error(message), { code, status }); };
export class RequestRuns {
  constructor(store) { this.store = store; }
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = requestRunSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean).map(sql => ({ sql,
      actual: this.store.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:TABLE|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(row => row.actual === undefined)) return false;
    if (expected.some(row => normalize(row.sql) !== normalize(row.actual))) throw new Error("Request execution schema requires operator reconciliation");
    return true;
  }
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding), state = this.store.room(roomId).state;
      const runs = {};
      if (this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='request_runs' AND type='table'").get()) {
        for (const row of this.store.db.prepare("SELECT * FROM request_runs WHERE room_id=?").all(roomId)) {
          const request = state.replyRequests?.[row.request_id];
          if (!request || request.openingEventId !== row.opening_id
            || ![request.requesterId, request.recipientId].includes(auth.member.id)) continue;
          runs[row.request_id] = { state: row.state === "working" && this.store.now() - row.updated_at > 120000 ? "unknown" : row.state,
            updatedAt: row.updated_at };
        }
      }
      return { contractVersion: 1, roomId, viewerId: auth.member.id, runs };
    });
  }
  apply(token, roomId, input, binding = null) {
    if (!input || Array.isArray(input) || Object.keys(input).some(k => !["requestMessageId", "attemptId", "action", "expectedRequestRevision", "contextEventId"].includes(k))
      || !validId(input.requestMessageId) || !validId(input.attemptId)
      || !["claim", "working", "result_ready", "needs_attention", "delivered"].includes(input.action))
      fail("invalid_request_run", "Choose one request, attempt and supported action", 422);
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding), state = this.store.room(roomId).state;
      const request = state.replyRequests?.[input.requestMessageId];
      if (auth.member.kind !== "agent" || !request || request.recipientId !== auth.member.id)
        fail("request_run_denied", "Only the addressed agent may report its host", 403);
      const row = this.store.db.prepare("SELECT * FROM request_runs WHERE room_id=? AND opening_id=?").get(roomId, request.openingEventId);
      if (row && row.attempt_id !== input.attemptId) fail("request_run_owned", "Another host owns this request; reconcile that host");
      if (input.action === "claim" || input.action === "working") {
        this.store.dmConsents.requireApproved(roomId, auth.member.id, request.requesterId);
        if (request.status !== "open" || state.room.archivedAt || state.members[request.requesterId]?.active !== true
          || this.store.wakeQueue.pauseStatus(roomId, auth.member.id)
          || request.revision !== input.expectedRequestRevision || request.contextEventId !== input.contextEventId)
          fail("request_run_changed", "Request changed, paused or closed; inspect the original attempt");
      }
      if (input.action === "delivered" && request.status !== "answered")
        fail("request_run_not_delivered", "The original request has no recorded answer");
      if (input.action === "claim") {
        if (row) fail("request_run_owned", "This attempt is already reserved; its execution outcome must be reconciled");
        this.store.db.prepare("INSERT INTO request_runs VALUES(?,?,?,?,?,'working',?)").run(roomId, request.openingEventId, request.id, auth.member.id, input.attemptId, this.store.now());
      } else {
        if (!row) fail("request_run_missing", "Reserve the request before reporting its host");
        if (row.state === "delivered" && input.action !== "delivered"
          || row.state === "result_ready" && input.action === "working"
          || row.state === "needs_attention" && input.action === "working") fail("request_run_terminal", "An uncertain attempt cannot silently resume execution");
        this.store.db.prepare("UPDATE request_runs SET state=?,updated_at=? WHERE room_id=? AND opening_id=?").run(input.action, this.store.now(), roomId, request.openingEventId);
      }
      return { contractVersion: 1, roomId, viewerId: auth.member.id, requestMessageId: request.id, attemptId: input.attemptId,
        state: input.action === "claim" ? "working" : input.action };
    });
  }
}
