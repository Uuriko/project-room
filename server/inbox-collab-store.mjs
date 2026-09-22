// Lane C inbox collaboration: durable, room-scoped HTTP backing store.
//
// Task RC-2026-09-18-011. The six pure Lane C modules
// (server/inbox-assign.mjs, server/inbox-internal-notes.mjs,
// server/inbox-collision.mjs, server/inbox-approval.mjs,
// server/inbox-agent-routing.mjs, server/inbox-handoff.mjs) are read and
// reused but never modified here. Each owns an in-memory journal; this
// wrapper keeps one lazy journal set per room, persists every mutation to
// SQLite (write-through), and replays the persisted rows onto fresh journals
// after a restart.
//
// Replay model: the persisted rows are the *operation log*, not just the
// final records — some transitions are lossy in the record alone (e.g. a
// forced assignment takeover drops the intermediate assignee from history),
// so replay re-runs the exact op sequence. Exactness of time and ids: every
// journal is built with an injected clock and id source; while live, this
// wrapper records each clock/id value the journals consume and persists the
// log beside the ops. On replay the log is fed back as a scripted sequence,
// so the rebuilt objects are identical to the pre-restart ones. A drained
// sequence is asserted after every replayed row and the rebuilt record is
// compared to the persisted one; any drift throws loudly at first room
// access rather than corrupting state.
//
// Two exceptions: draft locks replay from the lock fields (a same-holder
// refresh consumes its clock reads in a different order than a cold replay
// can reproduce, so the sequence is synthesized from acquiredAt/expiresAt),
// and the handoff journal (server/inbox-handoff.mjs) already persists itself
// through store.handoffs and is reused directly here.
import { randomUUID } from "node:crypto";
import { createAssignmentJournal } from "./inbox-assign.mjs";
import { createInternalNotes } from "./inbox-internal-notes.mjs";
import { createCollisionTracker } from "./inbox-collision.mjs";
import { createApprovalQueue } from "./inbox-approval.mjs";
import { createAgentRouter } from "./inbox-agent-routing.mjs";

export const inboxCollabSchema = `
CREATE TABLE IF NOT EXISTS collab_assignments (
  room_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  id_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, thread_id)
);
CREATE INDEX IF NOT EXISTS collab_assignments_by_id ON collab_assignments(room_id, assignment_id);
CREATE TABLE IF NOT EXISTS collab_notes (
  room_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  note_json TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  id_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, note_id)
);
CREATE INDEX IF NOT EXISTS collab_notes_by_thread ON collab_notes(room_id, thread_id, created_at);
CREATE TABLE IF NOT EXISTS collab_draft_locks (
  room_id TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  lock_json TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  id_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, lock_id)
);
CREATE INDEX IF NOT EXISTS collab_draft_locks_by_thread ON collab_draft_locks(room_id, thread_id);
CREATE TABLE IF NOT EXISTS collab_approvals (
  room_id TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  ops_json TEXT NOT NULL,
  record_json TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  id_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, proposal_id)
);
CREATE INDEX IF NOT EXISTS collab_approvals_by_thread ON collab_approvals(room_id, thread_id, created_at);
CREATE TABLE IF NOT EXISTS collab_routing_events (
  room_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  record_id TEXT,
  thread_id TEXT,
  agent_id TEXT,
  data_json TEXT NOT NULL,
  clock_json TEXT NOT NULL,
  id_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, seq)
);
`.trim();

// A mutation runs its journal calls while the room entry's cell logs every
// clock/id value the journals consume; the returned logs are persisted
// beside the op so replay can feed them back verbatim.
const loggedMutation = (entry, fn) => {
  entry.cell.clocks = [];
  entry.cell.ids = [];
  try {
    const result = fn();
    return { result, clocks: entry.cell.clocks, ids: entry.cell.ids };
  } finally {
    entry.cell.clocks = [];
    entry.cell.ids = [];
  }
};

const notFound = code => {
  const error = new Error("Not found");
  error.code = code;
  return error;
};

export class InboxCollabStore {
  #rooms;

  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.#rooms = new Map();
  }

  execSchema() {
    this.db.exec(inboxCollabSchema);
  }

  // A read-only open of a file written before this store finds none of these
  // tables and must not migrate, so allowAbsent accepts a wholly missing
  // schema; a partially present one still fails.
  verifySchema({ allowAbsent = false } = {}) {
    const normalize = sql => sql?.trim().replace(/;$/, "").replace(/IF NOT EXISTS /g, "").replace(/\s+/g, " ");
    const expected = inboxCollabSchema.split(/;\s*(?=CREATE|$)/).filter(Boolean)
      .map(sql => ({ sql, actual: this.db.prepare("SELECT sql FROM sqlite_master WHERE name=?")
        .get(/^CREATE (?:TABLE|INDEX) (?:IF NOT EXISTS )?([a-z_]+)/.exec(sql.trim())[1])?.sql }));
    if (allowAbsent && expected.every(({ actual }) => actual === undefined)) return false;
    for (const { sql, actual } of expected) {
      if (normalize(actual) !== normalize(sql)) throw new Error("Inbox collab store schema requires operator reconciliation");
    }
    return true;
  }

  // One lazy journal set per room. The first access replays persisted rows.
  #entry(roomId) {
    let entry = this.#rooms.get(roomId);
    if (entry) return entry;
    const cell = { mode: "live", clocks: [], ids: [] };
    const clock = () => {
      if (cell.mode === "replay") {
        if (cell.clocks.length === 0) throw new Error("collab replay: clock sequence exhausted");
        return cell.clocks.shift();
      }
      const value = this.store.now();
      cell.clocks.push(value);
      return value;
    };
    const id = () => {
      if (cell.mode === "replay") {
        if (cell.ids.length === 0) throw new Error("collab replay: id sequence exhausted");
        return cell.ids.shift();
      }
      const value = randomUUID();
      cell.ids.push(value);
      return value;
    };
    entry = {
      cell,
      assign: createAssignmentJournal({ clock }),
      notes: createInternalNotes({ clock, id }),
      locks: createCollisionTracker({ clock, id }),
      approvals: createApprovalQueue({ clock, id }),
      router: createAgentRouter({ clock, id }),
      policies: new Map(),
    };
    this.#rooms.set(roomId, entry);
    this.#replayRoom(roomId, entry);
    return entry;
  }

  // Feed a persisted log back as the scripted clock/id sequence, then assert
  // the journals consumed exactly it.
  #script(entry, row) {
    entry.cell.clocks = JSON.parse(row.clock_json);
    entry.cell.ids = JSON.parse(row.id_json);
  }

  #drained(entry, what) {
    if (entry.cell.clocks.length !== 0 || entry.cell.ids.length !== 0) {
      throw new Error(`collab replay: ${what} did not consume its logged sequence`);
    }
  }

  #replayRoom(roomId, entry) {
    entry.cell.mode = "replay";
    try {
      this.store.transaction(() => {
        this.#replayAssignments(roomId, entry);
        this.#replayNotes(roomId, entry);
        this.#replayLocks(roomId, entry);
        this.#replayApprovals(roomId, entry);
        this.#replayRouting(roomId, entry);
      });
    } finally {
      entry.cell.mode = "live";
      entry.cell.clocks = [];
      entry.cell.ids = [];
    }
  }

  #runAssignmentOp(entry, op) {
    if (op.op === "assign") {
      return entry.assign.assign(op.threadId, op.assignee, { by: op.by, force: op.force }).record;
    }
    if (op.op === "release") {
      return entry.assign.release(op.threadId, { by: op.by, reason: op.reason });
    }
    throw new Error(`collab replay: unknown assignment op ${op.op}`);
  }

  #replayAssignments(roomId, entry) {
    const rows = this.db.prepare(
      "SELECT ops_json, record_json, clock_json, id_json FROM collab_assignments WHERE room_id=?").all(roomId);
    for (const row of rows) {
      this.#script(entry, row);
      let current = null;
      for (const op of JSON.parse(row.ops_json)) current = this.#runAssignmentOp(entry, op);
      this.#drained(entry, "assignment");
      if (JSON.stringify(current) !== row.record_json) throw new Error("collab replay: assignment record mismatch");
    }
  }

  #replayNotes(roomId, entry) {
    const rows = this.db.prepare(
      "SELECT note_json, clock_json, id_json FROM collab_notes WHERE room_id=? ORDER BY created_at, note_id").all(roomId);
    for (const row of rows) {
      const note = JSON.parse(row.note_json);
      this.#script(entry, row);
      const replayed = entry.notes.addNote(note.threadId, { author: note.author, body: note.body, tag: note.tag });
      this.#drained(entry, "note");
      if (JSON.stringify(replayed) !== row.note_json) throw new Error("collab replay: note mismatch");
    }
  }

  #replayLocks(roomId, entry) {
    const now = this.store.now();
    // Expired locks do not survive a restart: drop them so a stale row can
    // never block a fresh acquire.
    this.db.prepare("DELETE FROM collab_draft_locks WHERE room_id=? AND expires_at <= ?").run(roomId, now);
    const rows = this.db.prepare(
      "SELECT lock_json, id_json FROM collab_draft_locks WHERE room_id=?").all(roomId);
    for (const row of rows) {
      const lock = JSON.parse(row.lock_json);
      const acquiredMs = Date.parse(lock.acquiredAt);
      const fresh = lock.expiresAt === acquiredMs + lock.ttlMs;
      // A same-holder refresh rewrote expiresAt after the cold-acquire clock
      // pattern, so its sequence is synthesized from the lock fields: the
      // acquire consumes the acquired instant, the heartbeat's expiry check
      // consumes it again (it cannot be expired: the refresh happened while
      // live), and the heartbeat's write consumes expiresAt - ttlMs.
      entry.cell.clocks = fresh ? [acquiredMs] : [acquiredMs, acquiredMs, lock.expiresAt - lock.ttlMs];
      entry.cell.ids = JSON.parse(row.id_json);
      entry.locks.acquireLock(lock.threadId, lock.holder, { ttlMs: lock.ttlMs });
      if (!fresh) entry.locks.heartbeat(lock.lockId);
      this.#drained(entry, "draft lock");
      // The tracker keeps locks private; verify the replayed lock by
      // attempting a stranger acquire (live clock, discarded): it must fail
      // with collision_lock_held naming the same holder and expiry.
      entry.cell.mode = "live";
      entry.cell.clocks = [];
      entry.cell.ids = [];
      let detail = null;
      try {
        entry.locks.acquireLock(lock.threadId, { kind: "agent", id: `replay-verify-${lock.lockId}`, label: null });
      } catch (error) {
        if (error.code !== "collision_lock_held") throw error;
        detail = error.detail;
      } finally {
        entry.cell.mode = "replay";
        entry.cell.clocks = [];
        entry.cell.ids = [];
      }
      if (!detail || detail.expiresAt !== lock.expiresAt
        || JSON.stringify(detail.holder) !== JSON.stringify(lock.holder)) {
        throw new Error("collab replay: draft lock mismatch");
      }
    }
  }

  #runApprovalOp(entry, proposalId, op) {
    if (op.op === "propose") {
      return entry.approvals.propose(op.threadId, { draft: op.draft, byAgent: op.byAgent, channel: op.channel });
    }
    if (op.op === "approve") return entry.approvals.approve(proposalId, { by: op.by, note: op.note });
    if (op.op === "requestEdits") {
      return entry.approvals.requestEdits(proposalId, { by: op.by, edits: op.edits, note: op.note });
    }
    if (op.op === "resubmit") {
      return entry.approvals.resubmit(proposalId, { draft: op.draft, byAgent: op.byAgent });
    }
    if (op.op === "reject") return entry.approvals.reject(proposalId, { by: op.by, reason: op.reason });
    throw new Error(`collab replay: unknown approval op ${op.op}`);
  }

  #replayApprovals(roomId, entry) {
    const rows = this.db.prepare(
      "SELECT proposal_id, ops_json, record_json, clock_json, id_json FROM collab_approvals WHERE room_id=? ORDER BY created_at, proposal_id").all(roomId);
    for (const row of rows) {
      this.#script(entry, row);
      let current = null;
      for (const op of JSON.parse(row.ops_json)) current = this.#runApprovalOp(entry, row.proposal_id, op);
      this.#drained(entry, "approval");
      if (JSON.stringify(current) !== row.record_json) throw new Error("collab replay: approval record mismatch");
    }
  }

  #replayRouting(roomId, entry) {
    const rows = this.db.prepare(
      "SELECT kind, record_id, data_json, clock_json, id_json FROM collab_routing_events WHERE room_id=? ORDER BY seq").all(roomId);
    for (const row of rows) {
      const data = JSON.parse(row.data_json);
      if (row.kind === "policy") {
        entry.policies.set(data.agent, entry.router.setPolicy(data.agent, data.policy));
        continue;
      }
      if (row.kind === "route") {
        this.#script(entry, row);
        const out = entry.router.route(data.threadId,
          { text: `@${data.mentionedAgentId}`, from: data.from, context: data.context });
        this.#drained(entry, "routing");
        if (!out.records.some(record => record.routingId === row.record_id)) {
          throw new Error("collab replay: routing record mismatch");
        }
        continue;
      }
      if (row.kind === "resolve") {
        this.#script(entry, row);
        entry.router.resolve(data.routingId, { by: data.by, outcome: data.outcome });
        this.#drained(entry, "routing resolve");
        continue;
      }
      throw new Error(`collab replay: unknown routing event ${row.kind}`);
    }
  }

  #nextRoutingSeq(roomId) {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM collab_routing_events WHERE room_id=?").get(roomId);
    return row.seq + 1;
  }

  #insertRoutingEvent(roomId, kind, { recordId = null, threadId = null, agentId = null, data, clocks, ids }) {
    this.db.prepare(`INSERT INTO collab_routing_events
      (room_id, seq, kind, record_id, thread_id, agent_id, data_json, clock_json, id_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(roomId, this.#nextRoutingSeq(roomId), kind, recordId, threadId, agentId,
        JSON.stringify(data), JSON.stringify(clocks), JSON.stringify(ids), this.store.now());
  }

  // ---- assignments: the wrapper mints a stable assignmentId per thread
  // because the pure journal keys by threadId while the HTTP release route
  // addresses assignments by id. ----
  assignThread(roomId, threadId, assignee, { by, force = false } = {}) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const op = { op: "assign", threadId, assignee, by, force };
      const { result, clocks, ids } = loggedMutation(entry, () => this.#runAssignmentOp(entry, op));
      const row = this.db.prepare(
        "SELECT assignment_id, ops_json, clock_json, id_json FROM collab_assignments WHERE room_id=? AND thread_id=?")
        .get(roomId, threadId);
      const assignmentId = row?.assignment_id ?? randomUUID();
      const ops = row ? [...JSON.parse(row.ops_json), op] : [op];
      const allClocks = row ? [...JSON.parse(row.clock_json), ...clocks] : clocks;
      const allIds = row ? [...JSON.parse(row.id_json), ...ids] : ids;
      this.db.prepare(`INSERT INTO collab_assignments
        (room_id, thread_id, assignment_id, ops_json, record_json, clock_json, id_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (room_id, thread_id) DO UPDATE SET
          ops_json=excluded.ops_json, record_json=excluded.record_json,
          clock_json=excluded.clock_json, id_json=excluded.id_json, updated_at=excluded.updated_at`)
        .run(roomId, threadId, assignmentId, JSON.stringify(ops), JSON.stringify(result),
          JSON.stringify(allClocks), JSON.stringify(allIds), this.store.now());
      return { assignmentId, record: result };
    });
  }

  listAssignments(roomId) {
    const entry = this.#entry(roomId);
    return this.store.readTransaction(() => {
      const ids = new Map(this.db.prepare(
        "SELECT thread_id, assignment_id FROM collab_assignments WHERE room_id=?").all(roomId)
        .map(row => [row.thread_id, row.assignment_id]));
      return entry.assign.list().map(record => ({ assignmentId: ids.get(record.threadId) ?? null, ...record }));
    });
  }

  releaseAssignment(roomId, assignmentId, { by, reason = null } = {}) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const row = this.db.prepare(
        "SELECT thread_id, ops_json, clock_json, id_json FROM collab_assignments WHERE room_id=? AND assignment_id=?")
        .get(roomId, assignmentId);
      if (!row) throw notFound("assignment_not_found");
      const op = { op: "release", threadId: row.thread_id, by, reason };
      const { result, clocks, ids } = loggedMutation(entry, () => this.#runAssignmentOp(entry, op));
      this.db.prepare(`UPDATE collab_assignments
        SET ops_json=?, record_json=?, clock_json=?, id_json=?, updated_at=? WHERE room_id=? AND thread_id=?`)
        .run(JSON.stringify([...JSON.parse(row.ops_json), op]), JSON.stringify(result),
          JSON.stringify([...JSON.parse(row.clock_json), ...clocks]),
          JSON.stringify([...JSON.parse(row.id_json), ...ids]),
          this.store.now(), roomId, row.thread_id);
      return { assignmentId, record: result };
    });
  }

  // ---- internal notes: append-only over HTTP (add + list). Notes carry
  // internal: true and must never be included in channel payloads; the only
  // reader is the collab notes endpoint. ----
  addThreadNote(roomId, threadId, { author, body, tag = null } = {}) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const { result: note, clocks, ids } = loggedMutation(entry,
        () => entry.notes.addNote(threadId, { author, body, tag }));
      this.db.prepare(`INSERT INTO collab_notes
        (room_id, note_id, thread_id, note_json, clock_json, id_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(roomId, note.noteId, threadId, JSON.stringify(note),
          JSON.stringify(clocks), JSON.stringify(ids), this.store.now());
      return note;
    });
  }

  listThreadNotes(roomId, threadId) {
    const entry = this.#entry(roomId);
    return entry.notes.listNotes(threadId);
  }

  // ---- draft locks: acquire + release + detect. Expired locks are swept on
  // replay so a restart never resurrects a stale hold. ----
  acquireDraftLock(roomId, threadId, holder, { ttlMs = null } = {}) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const { result, clocks, ids } = loggedMutation(entry,
        () => entry.locks.acquireLock(threadId, holder, ttlMs === null ? {} : { ttlMs }));
      const { lock, duplicate } = result;
      this.db.prepare(`INSERT INTO collab_draft_locks
        (room_id, lock_id, thread_id, lock_json, clock_json, id_json, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (room_id, lock_id) DO UPDATE SET
          lock_json=excluded.lock_json, clock_json=excluded.clock_json, id_json=excluded.id_json,
          expires_at=excluded.expires_at, updated_at=excluded.updated_at`)
        .run(roomId, lock.lockId, threadId, JSON.stringify(lock),
          JSON.stringify(clocks), JSON.stringify(ids), lock.expiresAt, this.store.now());
      return { lock, duplicate };
    });
  }

  releaseDraftLock(roomId, lockId, { by } = {}) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const row = this.db.prepare(
        "SELECT 1 FROM collab_draft_locks WHERE room_id=? AND lock_id=?").get(roomId, lockId);
      if (!row) throw notFound("lock_not_found");
      const released = entry.locks.releaseLock(lockId, { by });
      this.db.prepare("DELETE FROM collab_draft_locks WHERE room_id=? AND lock_id=?").run(roomId, lockId);
      return released;
    });
  }

  detectDraftLock(roomId, threadId, actor) {
    const entry = this.#entry(roomId);
    return entry.locks.detectCollision(threadId, actor);
  }

  // ---- approvals: propose, list, human decide, agent resubmit. ----
  proposeDraft(roomId, threadId, { draft, byAgent, channel }) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const op = { op: "propose", threadId, draft, byAgent, channel };
      const { result: record, clocks, ids } = loggedMutation(entry,
        () => this.#runApprovalOp(entry, null, op));
      this.db.prepare(`INSERT INTO collab_approvals
        (room_id, proposal_id, thread_id, ops_json, record_json, clock_json, id_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(roomId, record.proposalId, threadId, JSON.stringify([op]), JSON.stringify(record),
          JSON.stringify(clocks), JSON.stringify(ids), record.status, this.store.now(), this.store.now());
      return record;
    });
  }

  listApprovals(roomId, { status = null } = {}) {
    const entry = this.#entry(roomId);
    return entry.approvals.list({ status });
  }

  decideApproval(roomId, proposalId, { decision, by, note = null, editedBody = null, reason = null }) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const row = this.db.prepare(
        "SELECT ops_json, clock_json, id_json FROM collab_approvals WHERE room_id=? AND proposal_id=?")
        .get(roomId, proposalId);
      if (!row) throw notFound("approval_not_found");
      const op = decision === "approve" ? { op: "approve", by, note }
        : decision === "edit" ? { op: "requestEdits", by, edits: editedBody, note }
        : { op: "reject", by, reason };
      const { result: record, clocks, ids } = loggedMutation(entry,
        () => this.#runApprovalOp(entry, proposalId, op));
      this.db.prepare(`UPDATE collab_approvals
        SET ops_json=?, record_json=?, clock_json=?, id_json=?, status=?, updated_at=?
        WHERE room_id=? AND proposal_id=?`)
        .run(JSON.stringify([...JSON.parse(row.ops_json), op]), JSON.stringify(record),
          JSON.stringify([...JSON.parse(row.clock_json), ...clocks]),
          JSON.stringify([...JSON.parse(row.id_json), ...ids]),
          record.status, this.store.now(), roomId, proposalId);
      return record;
    });
  }

  resubmitApproval(roomId, proposalId, { draft, byAgent }) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const row = this.db.prepare(
        "SELECT ops_json, clock_json, id_json FROM collab_approvals WHERE room_id=? AND proposal_id=?")
        .get(roomId, proposalId);
      if (!row) throw notFound("approval_not_found");
      const op = { op: "resubmit", draft, byAgent };
      const { result: record, clocks, ids } = loggedMutation(entry,
        () => this.#runApprovalOp(entry, proposalId, op));
      this.db.prepare(`UPDATE collab_approvals
        SET ops_json=?, record_json=?, clock_json=?, id_json=?, status=?, updated_at=?
        WHERE room_id=? AND proposal_id=?`)
        .run(JSON.stringify([...JSON.parse(row.ops_json), op]), JSON.stringify(record),
          JSON.stringify([...JSON.parse(row.clock_json), ...clocks]),
          JSON.stringify([...JSON.parse(row.id_json), ...ids]),
          record.status, this.store.now(), roomId, proposalId);
      return record;
    });
  }

  // ---- agent routing: mention routing with policy overrides. ----
  routeMention(roomId, { threadId, mentionedAgentId, from, context = null }) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const { result: out, clocks, ids } = loggedMutation(entry,
        () => entry.router.route(threadId, { text: `@${mentionedAgentId}`, from, context }));
      // route() consumes two clock reads and one id per emitted record, in
      // mention order; slice the logged sequences back apart per record.
      let clockOffset = 0, idOffset = 0;
      for (const record of out.records) {
        const recordClocks = clocks.slice(clockOffset, clockOffset + 2);
        const recordIds = ids.slice(idOffset, idOffset + 1);
        clockOffset += 2; idOffset += 1;
        this.#insertRoutingEvent(roomId, "route", {
          recordId: record.routingId, threadId: record.threadId, agentId: record.agent,
          data: { threadId, mentionedAgentId, from, context },
          clocks: recordClocks, ids: recordIds,
        });
      }
      return out;
    });
  }

  listRouting(roomId) {
    const entry = this.#entry(roomId);
    const records = [...entry.router.list({ status: "routed" }), ...entry.router.list({ status: "escalated" })]
      .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);
    return { records: records.map(record => this.#routingView(record)), policies: Object.fromEntries(entry.policies) };
  }

  // Routing records keep the resolution outcome only in the history entry;
  // the HTTP view hoists it so clients don't have to dig through history.
  #routingView(record) {
    const resolved = [...record.history].reverse().find(entry => entry.status === "resolved");
    return {
      routingId: record.routingId,
      threadId: record.threadId,
      agent: record.agent,
      mode: record.mode,
      policy: record.policy,
      status: record.status,
      escalatedTo: record.escalatedTo,
      context: record.context,
      from: record.from,
      createdAt: record.createdAt,
      history: record.history,
      ...(resolved ? { outcome: resolved.outcome, resolvedBy: resolved.by, resolvedAt: resolved.at } : {}),
    };
  }

  resolveRouting(roomId, routingId, { by, outcome }) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const row = this.db.prepare(
        "SELECT 1 FROM collab_routing_events WHERE room_id=? AND kind='route' AND record_id=?").get(roomId, routingId);
      if (!row) throw notFound("routing_not_found");
      const { result: record, clocks, ids } = loggedMutation(entry,
        () => entry.router.resolve(routingId, { by, outcome }));
      this.#insertRoutingEvent(roomId, "resolve", {
        recordId: routingId, agentId: record.agent,
        data: { routingId, by, outcome }, clocks, ids,
      });
      return this.#routingView(record);
    });
  }

  setRoutingPolicy(roomId, agent, policy) {
    const entry = this.#entry(roomId);
    return this.store.transaction(() => {
      const result = entry.router.setPolicy(agent, policy);
      entry.policies.set(agent, result);
      this.#insertRoutingEvent(roomId, "policy", {
        agentId: agent, data: { agent, policy: result }, clocks: [], ids: [],
      });
      return result;
    });
  }

  // ---- handoffs: the existing durable journal (store.handoffs) is reused
  // directly. store.inbox.handoff cannot serve agent credentials (it requires
  // an account-session binding), so this path synthesizes the packet from
  // explicit caller-supplied fields instead of the inbox thread view. ----
  // Returns { accountId, roomId }. roomId is null for a caller who holds the
  // account (their own journal, across their rooms), and set for a caller who
  // does not, who may then act only on handoffs recorded in this room.
  resolveHandoffAccount(roomId, callerId, authAccountId = null) {
    if (typeof authAccountId === "string" && authAccountId) return { accountId: authAccountId, roomId: null };
    const direct = this.store.accountForMember(roomId, callerId);
    if (direct) return { accountId: direct.id, roomId: null };
    // A caller with no account of their own (an agent identity) works under
    // the room owner's account, as this feature always intended, but only
    // inside this room. inbox_handoffs is keyed on account alone, so without
    // the room scope the owner's account opened every handoff in every room
    // that account owns: an agent in one room could read the full packets of
    // the owner's handoffs elsewhere and move them through their lifecycle.
    const ownerId = this.store.roomAuthority(roomId).ownerId;
    const ownerAccount = ownerId === callerId ? null : this.store.accountForMember(roomId, ownerId);
    if (ownerAccount) return { accountId: ownerAccount.id, roomId };
    const error = new Error("No account scope is bound for this handoff; bind a human account to the room first.");
    error.code = "handoff_no_account_scope";
    throw error;
  }

  createHandoff(roomId, scope, { threadId, to, summary = null, openQuestions = null,
    pendingActions = null, excerpt = null, subject = null }, { from }) {
    // The journal's packet names the recipient as a plain agent id string;
    // the HTTP route validates {kind, id} and the id rides through here.
    const toId = typeof to === "object" && to !== null ? to.id : to;
    return this.store.handoffs.create(scope.accountId, {
      threadId,
      channel: "room",
      sourceIds: [threadId],
      sender: { id: from, label: from },
      subject: typeof subject === "string" && subject ? subject : `Room thread ${threadId}`,
      occurredAt: new Date(this.store.now()).toISOString(),
      sla: null,
      triage: { action: "needs_human", reasons: ["Handed off for a person or agent to pick up."] },
      summary, openQuestions, pendingActions, excerpt,
    }, { from, to: toId, roomId: scope.roomId, recordRoom: roomId });
  }

  listHandoffs(scope, { status = null } = {}) {
    return this.store.handoffs.list(scope.accountId, { status, roomId: scope.roomId });
  }

  transitionHandoff(scope, handoffId, status, { note = null } = {}) {
    return this.store.handoffs.transition(scope.accountId, handoffId, status, { note, roomId: scope.roomId });
  }
}
