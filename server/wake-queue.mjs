// W4-45 H3: durable wake queue. A wake is a recorded intent to re-check
// something later (for example, re-evaluate an H1 recipe trigger). The queue
// is durable (SQLite, survives restart), coalescing (one row per queue key),
// retrying (bounded attempts with backoff), and dead-lettering (exhausted
// intents park in 'dead' until the member requeues them). Queue records are
// the member's own intent - draft class: nothing here sends, posts, launches
// or spends.
//
// Done-when: a restart preserves intent without duplicate action. Leases make
// in-flight work crash-safe: a process that dies mid-attempt leaves an
// expired lease, and recover() hands the intent back to pending exactly once.
// Completion is receipt-idempotent, so a retried completion never applies a
// second effect. tests/wake-queue.test.js proves the restart path.

import { createHash } from "node:crypto";
import { validId } from "../src/events.js";
import { ServiceError } from "./store.mjs";
import { wakeQueueLimits as limits } from "./wake-queue-limits.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Re-exported from the leaf module so existing importers keep working; the
// object identity is shared with the enforcing WakeQueue code below.
export const wakeQueueLimits = limits;
export const wakeQueueSchema = `
  CREATE TABLE IF NOT EXISTS wake_queue (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, queue_key TEXT NOT NULL,
    intent TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','leased','done','dead')),
    due_at INTEGER NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
    lease_owner TEXT, lease_expires_at INTEGER, last_error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,member_id,queue_key)
  );
  CREATE INDEX IF NOT EXISTS wake_queue_due ON wake_queue(state,due_at);
  CREATE TABLE IF NOT EXISTS wake_queue_commands (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL, request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, response TEXT NOT NULL,
    PRIMARY KEY(room_id,member_id,request_id)
  );
  CREATE TRIGGER IF NOT EXISTS wake_queue_commands_no_update BEFORE UPDATE ON wake_queue_commands BEGIN SELECT RAISE(ABORT,'wake queue receipts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS wake_queue_commands_no_delete BEFORE DELETE ON wake_queue_commands BEGIN SELECT RAISE(ABORT,'wake queue receipts are retained'); END;
`;
// W4-48 H7: member-scoped pause over the queue. Pausing stops NEW attempts
// from starting (due() skips the member's pending wakes); an already-leased
// attempt is already running and is left to finish - the pause surface keeps
// the two visibly distinct (the done-when). Purely additive at v27, same
// pattern as the queue itself.
export const wakeQueuePauseSchema = `
  CREATE TABLE IF NOT EXISTS wake_queue_pause (
    room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    paused_at INTEGER NOT NULL, reason TEXT,
    PRIMARY KEY(room_id,member_id)
  );
`;

const view = row => ({ queueKey: row.queue_key, intent: JSON.parse(row.intent), state: row.state, dueAt: row.due_at,
  attempts: row.attempts, maxAttempts: row.max_attempts, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
  lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at });

export class WakeQueue {
  constructor(store) { this.store = store; this.db = store.db; }
  // The wake queue is purely additive at v27, so a v27 store written before
  // W4-45 has none of these objects. A read-only open (backup verification,
  // invitation audit) must not migrate, so allowAbsent accepts a file where the
  // whole schema is missing; a partially present schema still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = wakeQueueSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Wake queue schema requires operator reconciliation");
    }
    return true;
  }
  verifyPauseSchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = wakeQueuePauseSchema.trim().split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(/^CREATE (?:TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Wake queue pause schema requires operator reconciliation");
    }
    return true;
  }
  pauseStatus(roomId, memberId) {
    const row = this.db.prepare("SELECT * FROM wake_queue_pause WHERE room_id=? AND member_id=?").get(roomId, memberId);
    return row ? { pausedAt: row.paused_at, reason: row.reason } : null;
  }
  // C6: owner-facing pause. A member always acts on its own pause row; the
  // signed-in room owner may also inspect, pause and resume another member's.
  // A removed member's row stays inspectable but inert: changing it is
  // refused, so a resume can never restart a removed member's queued wakes.
  isOwner(auth, roomId, authority = this.store.roomAuthority(roomId)) {
    return Boolean(auth.account) && auth.kind === "session" && auth.member.kind === "human"
      && auth.member.id === authority.ownerId && auth.member.permissions.includes("manage_members");
  }
  subject(auth, roomId, memberId, { change = false } = {}) {
    if (memberId === null || memberId === undefined || memberId === auth.member.id) return auth.member.id;
    if (!validId(memberId)) fail(422, "invalid_member", "Choose one member");
    const authority = this.store.roomAuthority(roomId);
    if (!this.isOwner(auth, roomId, authority)) fail(403, "owner_required", "Only the signed-in room owner can inspect, pause or resume another member");
    if (!Object.hasOwn(authority.members, memberId)) fail(404, "member_not_found", "Unknown member");
    if (change && authority.members[memberId].active === false) fail(409, "member_inactive", "This member's access has ended; its pause row is inert");
    return memberId;
  }
  pausedMembers(roomId) {
    return this.db.prepare("SELECT member_id,paused_at,reason FROM wake_queue_pause WHERE room_id=? ORDER BY member_id").all(roomId)
      .map(row => ({ memberId: row.member_id, pausedAt: row.paused_at, reason: row.reason }));
  }
  // The one stop surface: pause state, pending wakes (won't start while
  // paused), already-running attempts (left to finish), and readable recent
  // outcomes (done/dead with attempts and the last error).
  current(auth, roomId, memberId = auth.member.id) {
    const wakes = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? ORDER BY queue_key").all(roomId, memberId).map(view);
    return {
      roomId, viewerId: auth.member.id, memberId, evaluatedAt: this.store.now(),
      pause: this.pauseStatus(roomId, memberId),
      wakes,
      pending: wakes.filter(w => w.state === "pending"),
      running: wakes.filter(w => w.state === "leased"),
      recentOutcomes: wakes.filter(w => w.state === "done" || w.state === "dead")
        .sort((a, b) => b.updatedAt - a.updatedAt || (a.queueKey < b.queueKey ? -1 : 1)).slice(0, 10)
        .map(w => ({ queueKey: w.queueKey, state: w.state, attempts: w.attempts, lastError: w.lastError, at: w.updatedAt }))
    };
  }
  list(token, roomId, binding = null) {
    return this.store.readTransaction(() => this.current(this.store.authenticate(token, roomId, binding), roomId));
  }
  // C6: the caller's own view, or (owner) one named member's view plus the
  // room's paused roster. Reads only; no credential material is included.
  inspect(token, roomId, { memberId = null } = {}, binding = null) {
    return this.store.readTransaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      return this.outcome(auth, roomId, this.subject(auth, roomId, memberId));
    });
  }
  outcome(auth, roomId, subject, extra = {}) {
    const current = this.current(auth, roomId, subject);
    return { ...(this.isOwner(auth, roomId) ? { ...current, paused: this.pausedMembers(roomId) } : current), ...extra };
  }
  receipt(requestId, fields, request) {
    return createHash("sha256").update(JSON.stringify(Object.fromEntries(fields.sort().map(field => [field, request[field]])))).digest("hex");
  }
  priorReceipt(roomId, memberId, request, fingerprint) {
    const prior = this.db.prepare("SELECT fingerprint,response FROM wake_queue_commands WHERE room_id=? AND member_id=? AND request_id=?").get(roomId, memberId, request.requestId);
    if (!prior) return null;
    if (prior.fingerprint !== fingerprint) fail(409, "idempotency_conflict", "Request ID already used for a different wake command");
    return JSON.parse(prior.response);
  }
  // Every command that lands writes one immutable, never-deleted receipt, so
  // the receipts cap must bound every writer - enqueue, pause, resume and
  // requeue alike - or the table grows without bound through whichever
  // command skips the check. Called after the prior-receipt lookup so an
  // exact retry at the cap still answers with its historical receipt.
  receiptCapacity(roomId, memberId) {
    const receipts = this.db.prepare("SELECT count(*) n FROM wake_queue_commands WHERE room_id=? AND member_id=?").get(roomId, memberId).n;
    if (receipts >= wakeQueueLimits.receipts) fail(409, "wake_limit", "Wake capacity reached.");
  }
  // enqueue coalesces: one row per queue key. A still-pending wake absorbs the
  // new intent and keeps the earliest due time; a leased one is left alone; a
  // done one starts a fresh cycle; a dead one stays parked until requeue.
  enqueue(token, roomId, request, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const fields = ["requestId", "queueKey", "intent", "dueAt", "maxAttempts"];
      if (!request || Array.isArray(request) || Object.keys(request).length !== fields.length || !fields.every(field => Object.hasOwn(request, field))
        || !validId(request.requestId) || !validId(request.queueKey) || !Number.isSafeInteger(request.dueAt)
        || !Number.isSafeInteger(request.maxAttempts) || request.maxAttempts < 1 || request.maxAttempts > wakeQueueLimits.maxAttempts
        || typeof request.intent !== "object" || request.intent === null || Array.isArray(request.intent)) fail(422, "invalid_wake", "Supply a queue key, intent, due time, max attempts and request ID.");
      const intentJson = JSON.stringify(request.intent);
      if (intentJson.length > wakeQueueLimits.intentBytes) fail(422, "invalid_wake", "Wake intent is too large.");
      const fingerprint = this.receipt(request.requestId, fields, request);
      const prior = this.priorReceipt(roomId, auth.member.id, request, fingerprint);
      if (prior) return { ...this.current(auth, roomId), receipt: prior, duplicate: true };
      const now = this.store.now();
      if (request.dueAt > now + wakeQueueLimits.horizon) fail(422, "invalid_wake_time", "Choose a due time within one year.");
      const row = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, auth.member.id, request.queueKey);
      if (row?.state === "dead") fail(409, "wake_dead", "This wake is parked as dead letters; requeue it explicitly.");
      this.receiptCapacity(roomId, auth.member.id);
      const active = this.db.prepare("SELECT count(*) n FROM wake_queue WHERE room_id=? AND member_id=? AND state IN ('pending','leased')").get(roomId, auth.member.id).n;
      if (!row && active >= wakeQueueLimits.active) fail(409, "wake_limit", "Wake capacity reached.");
      let receipt;
      if (row && (row.state === "pending" || row.state === "leased")) {
        if (row.state === "pending") {
          const dueAt = Math.min(row.due_at, request.dueAt);
          this.db.prepare("UPDATE wake_queue SET intent=?,due_at=?,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=?")
            .run(intentJson, dueAt, now, roomId, auth.member.id, request.queueKey);
        }
        receipt = { requestId: request.requestId, queueKey: request.queueKey, state: row.state, coalesced: true, dueAt: row.state === "pending" ? Math.min(row.due_at, request.dueAt) : row.due_at };
      } else {
        if (row?.state === "done") this.db.prepare("DELETE FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").run(roomId, auth.member.id, request.queueKey);
        this.db.prepare("INSERT INTO wake_queue (room_id,member_id,queue_key,intent,state,due_at,attempts,max_attempts,lease_owner,lease_expires_at,last_error,created_at,updated_at) VALUES(?,?,?,?,'pending',?,0,?,NULL,NULL,NULL,?,?)")
          .run(roomId, auth.member.id, request.queueKey, intentJson, request.dueAt, request.maxAttempts, now, now);
        receipt = { requestId: request.requestId, queueKey: request.queueKey, state: "pending", coalesced: false, dueAt: request.dueAt };
      }
      this.db.prepare("INSERT INTO wake_queue_commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, request.requestId, fingerprint, JSON.stringify(receipt));
      return { ...this.current(auth, roomId), receipt, duplicate: false };
    });
  }
  // pause/resume are the member's own stop control - draft class: they only
  // govern when this member's own queued intents may start. Idempotent via the
  // same commands receipt table as enqueue/requeue, and bounded by the same
  // receipts cap (receiptCapacity) since every landed command retains a row -
  // except that a state-changing pause is always admitted, so the stop
  // control works at the cap.
  pause(token, roomId, request, binding = null, { memberId = null } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const subject = this.subject(auth, roomId, memberId, { change: true });
      const fields = ["requestId", "reason"];
      if (!request || Array.isArray(request) || Object.keys(request).length !== fields.length || !fields.every(field => Object.hasOwn(request, field))
        || !validId(request.requestId) || (request.reason !== null && (typeof request.reason !== "string" || request.reason.length > 200))) fail(422, "invalid_wake_pause", "Supply a request ID and an optional short reason.");
      const fingerprint = this.receipt(request.requestId, fields, request);
      const prior = this.priorReceipt(roomId, subject, request, fingerprint);
      if (prior) return this.outcome(auth, roomId, subject, { receipt: prior, duplicate: true });
      const now = this.store.now();
      const existing = this.pauseStatus(roomId, subject);
      // Stop always works (the reminders precedent for cancel): a pause that
      // changes state is admitted even at the receipt cap. That adds at most
      // one receipt per breach, because the matching resume stays capped and
      // a no-op re-pause of an already-paused member is refused.
      if (existing) this.receiptCapacity(roomId, subject);
      if (!existing) this.db.prepare("INSERT INTO wake_queue_pause VALUES(?,?,?,?)").run(roomId, subject, now, request.reason);
      const receipt = { requestId: request.requestId, state: "paused", pausedAt: existing ? existing.pausedAt : now, alreadyPaused: Boolean(existing) };
      this.db.prepare("INSERT INTO wake_queue_commands VALUES(?,?,?,?,?)").run(roomId, subject, request.requestId, fingerprint, JSON.stringify(receipt));
      return this.outcome(auth, roomId, subject, { receipt, duplicate: false });
    });
  }
  resume(token, roomId, request, binding = null, { memberId = null } = {}) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const subject = this.subject(auth, roomId, memberId, { change: true });
      const keys = request && !Array.isArray(request) ? Object.keys(request) : null;
      const reasonOk = !keys?.includes("reason") || request.reason === null || typeof request.reason === "string" && request.reason.length <= 200;
      if (!keys || !keys.includes("requestId") || keys.some(key => key !== "requestId" && key !== "reason") || !validId(request.requestId) || !reasonOk) {
        fail(422, "invalid_wake_resume", "Supply a request ID. reason is optional.");
      }
      const fields = keys.includes("reason") ? ["requestId", "reason"] : ["requestId"];
      const fingerprint = this.receipt(request.requestId, fields, request);
      const prior = this.priorReceipt(roomId, subject, request, fingerprint);
      if (prior) return this.outcome(auth, roomId, subject, { receipt: prior, duplicate: true });
      this.receiptCapacity(roomId, subject);
      const existing = this.pauseStatus(roomId, subject);
      this.db.prepare("DELETE FROM wake_queue_pause WHERE room_id=? AND member_id=?").run(roomId, subject);
      const receipt = { requestId: request.requestId, state: "active", wasPaused: Boolean(existing) };
      this.db.prepare("INSERT INTO wake_queue_commands VALUES(?,?,?,?,?)").run(roomId, subject, request.requestId, fingerprint, JSON.stringify(receipt));
      return this.outcome(auth, roomId, subject, { receipt, duplicate: false });
    });
  }
  requeue(token, roomId, request, binding = null) {
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, binding);
      const fields = ["requestId", "queueKey", "dueAt"];
      if (!request || Array.isArray(request) || Object.keys(request).length !== fields.length || !fields.every(field => Object.hasOwn(request, field))
        || !validId(request.requestId) || !validId(request.queueKey) || !Number.isSafeInteger(request.dueAt)) fail(422, "invalid_wake", "Supply a queue key, due time and request ID.");
      const fingerprint = this.receipt(request.requestId, fields, request);
      const prior = this.priorReceipt(roomId, auth.member.id, request, fingerprint);
      if (prior) return { ...this.current(auth, roomId), receipt: prior, duplicate: true };
      const now = this.store.now();
      if (request.dueAt > now + wakeQueueLimits.horizon) fail(422, "invalid_wake_time", "Choose a due time within one year.");
      const row = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, auth.member.id, request.queueKey);
      if (row?.state !== "dead") fail(409, "wake_not_dead", "Only a dead-lettered wake can be requeued.");
      this.receiptCapacity(roomId, auth.member.id);
      this.db.prepare("UPDATE wake_queue SET state='pending',due_at=?,attempts=0,lease_owner=NULL,lease_expires_at=NULL,last_error=NULL,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=?")
        .run(request.dueAt, now, roomId, auth.member.id, request.queueKey);
      const receipt = { requestId: request.requestId, queueKey: request.queueKey, state: "pending", coalesced: false, dueAt: request.dueAt };
      this.db.prepare("INSERT INTO wake_queue_commands VALUES(?,?,?,?,?)").run(roomId, auth.member.id, request.requestId, fingerprint, JSON.stringify(receipt));
      return { ...this.current(auth, roomId), receipt, duplicate: false };
    });
  }
  due(now, limit = 32) {
    return this.db.prepare("SELECT * FROM wake_queue WHERE state='pending' AND due_at<=? AND NOT EXISTS (SELECT 1 FROM wake_queue_pause p WHERE p.room_id=wake_queue.room_id AND p.member_id=wake_queue.member_id) ORDER BY due_at,queue_key LIMIT ?").all(now, limit).map(view);
  }
  // lease moves one due wake to leased, consuming one attempt. Returns null
  // when the wake is no longer leasable (already leased, completed, dead).
  lease(roomId, memberId, queueKey, owner, now = this.store.now()) {
    // Paused members start no new attempts, even by direct lease.
    const changed = this.db.prepare("UPDATE wake_queue SET state='leased',attempts=attempts+1,lease_owner=?,lease_expires_at=?,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=? AND state='pending' AND due_at<=? AND NOT EXISTS (SELECT 1 FROM wake_queue_pause p WHERE p.room_id=wake_queue.room_id AND p.member_id=wake_queue.member_id)")
      .run(owner, now + wakeQueueLimits.leaseMs, now, roomId, memberId, queueKey, now).changes;
    return changed ? this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, memberId, queueKey) : null;
  }
  // complete is receipt-idempotent: the requestId receipt is written in the
  // same transaction as the state change, so a retried completion is a
  // duplicate no-op and never applies a second effect.
  complete(roomId, memberId, queueKey, { requestId, leaseOwner, effect = null }) {
    return this.store.transaction(() => {
      if (!validId(requestId)) fail(422, "invalid_wake", "Supply a request ID.");
      const prior = this.db.prepare("SELECT response FROM wake_queue_commands WHERE room_id=? AND member_id=? AND request_id=?").get(roomId, memberId, requestId);
      const row = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, memberId, queueKey);
      if (prior) return { receipt: JSON.parse(prior.response), duplicate: true, wake: row ? view(row) : null };
      if (!row || row.state !== "leased" || row.lease_owner !== leaseOwner) fail(409, "wake_not_leased", "Only the lease holder can complete a wake.");
      const now = this.store.now();
      this.db.prepare("UPDATE wake_queue SET state='done',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=?").run(now, roomId, memberId, queueKey);
      const receipt = { requestId, queueKey, state: "done", effect, completedAt: now };
      const fingerprint = createHash("sha256").update(JSON.stringify({ complete: queueKey, requestId })).digest("hex");
      this.db.prepare("INSERT INTO wake_queue_commands VALUES(?,?,?,?,?)").run(roomId, memberId, requestId, fingerprint, JSON.stringify(receipt));
      return { receipt, duplicate: false, wake: view(this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, memberId, queueKey)) };
    });
  }
  // fail returns a leased wake to pending with backoff, or dead-letters it
  // once attempts are exhausted. Backoff is bounded and deterministic.
  fail(roomId, memberId, queueKey, { leaseOwner, error, now = this.store.now() }) {
    return this.store.transaction(() => {
      const row = this.db.prepare("SELECT * FROM wake_queue WHERE room_id=? AND member_id=? AND queue_key=?").get(roomId, memberId, queueKey);
      if (!row || row.state !== "leased" || row.lease_owner !== leaseOwner) fail(409, "wake_not_leased", "Only the lease holder can fail a wake.");
      const message = String(error ?? "unknown").slice(0, 200);
      if (row.attempts >= row.max_attempts) {
        this.db.prepare("UPDATE wake_queue SET state='dead',lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=?").run(message, now, roomId, memberId, queueKey);
        return { state: "dead", attempts: row.attempts };
      }
      const backoff = Math.min(wakeQueueLimits.baseBackoffMs * 2 ** (row.attempts - 1), wakeQueueLimits.maxBackoffMs);
      this.db.prepare("UPDATE wake_queue SET state='pending',due_at=?,lease_owner=NULL,lease_expires_at=NULL,last_error=?,updated_at=? WHERE room_id=? AND member_id=? AND queue_key=?").run(now + backoff, message, now, roomId, memberId, queueKey);
      return { state: "pending", attempts: row.attempts, dueAt: now + backoff };
    });
  }
  // recover runs at store open: leases whose holder vanished (process died)
  // expire back to pending. The attempt was already counted at lease time, so
  // crash-retry consumes budget exactly like an observed failure. Returns the
  // number of recovered wakes.
  recover(now = this.store.now()) {
    return this.db.prepare("UPDATE wake_queue SET state='pending',lease_owner=NULL,lease_expires_at=NULL,updated_at=? WHERE state='leased' AND lease_expires_at<=?").run(now, now).changes;
  }
}
