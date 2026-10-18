// Stage 0 (per-room architecture, CALL 3): the transactional outbox that
// will feed the D1 directory (room registry + seat index) and the public
// read model once D1 exists.
//
// D1 does NOT exist yet — its creation is gated on the operator's wrangler
// session. This module is everything provable before that day:
//
// - Writers append an outbox entry INSIDE the same local transaction as the
//   room write it describes (design §3.7.1). An entry exists iff its write
//   committed; a rollback leaves no entry. No cross-store I/O ever happens
//   inside a transaction — the drain below is the only publisher.
// - The drain publishes through an ADAPTER interface. The production
//   adapter is a clearly-marked not-yet-wired stub (no D1 binding exists):
//   it fails safe — entries accumulate, attempts are not burned, and the
//   drain reports `wired: false` instead of erroring, so the alarm/job
//   never spins on a missing binding. Tests use an in-memory fake D1.
// - Delivery is at-least-once; application at the target is idempotent,
//   deduped by (room_id, sequence, kind) — the design's §3.7.2 key.
// - A drain tick is deadline-bounded and resumable, following the jobs
//   registry pattern: the due-scan (pending rows in id order) IS the
//   cursor, so a budget-exceeded tick simply continues next tick.
// - Retention: an entry is trimmable only after the target acknowledges
//   it. At most OUTBOX_KEEP_ACKED acked entries are retained (an
//   audit/replay window); unacked entries are never trimmed, so the
//   outbox's growth is bounded by (undrained backlog + OUTBOX_KEEP_ACKED).
//   That bound is an assumption of this slice, stated as such — it does
//   not rely on any separate retention floor.
//
// The flag: appends happen only when ROOM_DIRECTORY_OUTBOX=1 (or the store
// is constructed with { directoryOutbox: true }). Default off means the
// monolith pays exactly zero tax and takes zero risk until an operator
// wires a real D1 adapter and turns the feed on.
import { ownMember, publicPage, publicReceipts } from "../src/events.js";

export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS directory_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  UNIQUE (room_id, sequence, kind)
);
CREATE INDEX IF NOT EXISTS directory_outbox_pending ON directory_outbox (acked_at, id);
`;

export const OUTBOX_KINDS = Object.freeze(["room_event", "room_snapshot"]);
// Acked entries retained for audit/replay after the target acks them.
export const OUTBOX_KEEP_ACKED = 1000;
export const OUTBOX_BATCH = 50;

export function outboxEnabledFromEnv(env = globalThis.process?.env ?? {}) {
  return env?.ROOM_DIRECTORY_OUTBOX === "1";
}

const ensuredDbs = new WeakSet();
export function ensureOutboxSchema(db) {
  if (ensuredDbs.has(db)) return;
  db.exec(OUTBOX_SCHEMA);
  ensuredDbs.add(db);
}

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

// ---------------------------------------------------------------- payloads
// Minimal sufficient payload for Stage 0's directory, derived from the
// design's §3.2 dispositions:
// - registry facts: id (the key), title, owner, archived, head sequence,
//   projection bytes (the registry summary ACCOUNT_ROOM_SELECT already
//   serves, plus the store-growth gauge).
// - seat delta: for member events, the affected member's post-commit
//   presence (id, kind, active). Account/identity bindings are NOT in the
//   room event; they are account-side facts whose outbox feed is the
//   Stage 3 account-DO work — including them here would require reading
//   account tables inside room transactions for data the room does not own.
// - public flags: whether the room's public page / receipts are on, so the
//   directory read path can fail closed on an unpublish that has not yet
//   been fully replicated (design §8.4). Full public-row replication rides
//   the same entry kind when D1 wiring lands; the flags are the part whose
//   absence would be unsafe, so they ship now.
export function directoryPayloadForEvent({ roomId, sequence, event, state, projectionBytes = null }) {
  const room = state?.room ?? {};
  const payload = {
    v: 1,
    eventId: typeof event?.id === "string" ? event.id : null,
    eventType: typeof event?.type === "string" ? event.type : null,
    actorId: typeof event?.actorId === "string" ? event.actorId : null,
    at: typeof event?.at === "string" ? event.at : null,
    registry: {
      roomId,
      title: typeof room.title === "string" ? room.title : null,
      ownerId: typeof room.ownerId === "string" ? room.ownerId : null,
      archived: Boolean(state?.archivedAt ?? room.archivedAt ?? state?.room?.archived_at),
      sequence,
      projectionBytes: Number.isSafeInteger(projectionBytes) ? projectionBytes : null
    },
    public: {
      pageEnabled: safeFlag(() => publicPage(state).enabled === true),
      receiptsEnabled: safeFlag(() => publicReceipts(state).enabled === true)
    }
  };
  const memberId = typeof event?.data?.memberId === "string" ? event.data.memberId : null;
  const member = memberId && state?.members ? ownMember(state.members, memberId) : null;
  if (memberId && member) {
    payload.seat = {
      memberId,
      kind: member?.kind === "human" ? "human" : "agent",
      active: member?.active !== false
    };
  } else if (memberId) {
    // The member is gone from the post-commit state (a removal): the seat
    // delta is a tombstone, which the directory applies as a delete.
    payload.seat = { memberId, kind: null, active: false };
  }
  return payload;
}

function safeFlag(fn) {
  try { return fn(); } catch { return false; }
}

// Full-registry snapshot payload (room creation / import): every active
// seat, so a directory that starts empty converges from one entry.
export function directorySnapshotPayload({ roomId, sequence, state, projectionBytes = null }) {
  const base = directoryPayloadForEvent({
    roomId, sequence, projectionBytes,
    event: { id: null, type: "room.snapshot", actorId: null, at: null }, state
  });
  const seats = [];
  for (const member of Object.values(state?.members ?? {})) {
    if (!member || typeof member.id !== "string" || member.active === false) continue;
    seats.push({ memberId: member.id, kind: member.kind === "human" ? "human" : "agent", active: true });
  }
  return { ...base, seats };
}

// ------------------------------------------------------------------ append
// Append one entry. MUST be called inside the writer's transaction — that
// is the atomicity contract. INSERT OR IGNORE on the (room, sequence,
// kind) key makes a retried append inside a replayed transaction a no-op
// rather than a constraint failure.
export function appendOutboxEntry(db, { roomId, sequence, kind, payload, now }) {
  if (typeof roomId !== "string" || !roomId) throw new TypeError("outbox entry needs a roomId");
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new TypeError("outbox entry needs a sequence");
  if (!OUTBOX_KINDS.includes(kind)) throw new TypeError(`unknown outbox kind ${kind}`);
  ensureOutboxSchema(db);
  const result = db.prepare(`INSERT OR IGNORE INTO directory_outbox
    (room_id, sequence, kind, payload, created_at) VALUES (?,?,?,?,?)`)
    .run(roomId, sequence, kind, JSON.stringify(payload), Number.isSafeInteger(now) ? now : Date.now());
  return result.changes > 0;
}

// The store-facing hook: appends the room_event entry for a committed
// room event, or does nothing when the feed is off. Callers invoke this
// after the rooms-row update, still inside the same transaction.
export function maybeAppendRoomEventOutbox(store, { roomId, sequence, event, state, projectionBytes = null }) {
  if (!store?.directoryOutboxEnabled) return false;
  const payload = directoryPayloadForEvent({ roomId, sequence, event, state, projectionBytes });
  return appendOutboxEntry(store.db, { roomId, sequence, kind: "room_event", payload, now: store.now() });
}

export function maybeAppendRoomSnapshotOutbox(store, { roomId, sequence, state, projectionBytes = null }) {
  if (!store?.directoryOutboxEnabled) return false;
  const payload = directorySnapshotPayload({ roomId, sequence, state, projectionBytes });
  return appendOutboxEntry(store.db, { roomId, sequence, kind: "room_snapshot", payload, now: store.now() });
}

// ------------------------------------------------------------------- stats
export function outboxPending(store) {
  const db = store?.db;
  if (!db?.prepare || !tableExists(db, "directory_outbox")) return false;
  try { return Boolean(db.prepare("SELECT 1 AS hit FROM directory_outbox WHERE acked_at IS NULL LIMIT 1").get()?.hit); }
  catch { return false; }
}

export function outboxStats(store) {
  const db = store?.db;
  if (!db?.prepare || !tableExists(db, "directory_outbox")) return { total: 0, pending: 0, acked: 0 };
  const row = db.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(acked_at IS NULL), 0) AS pending,
    COALESCE(SUM(acked_at IS NOT NULL), 0) AS acked FROM directory_outbox`).get();
  return { total: Number(row?.total) || 0, pending: Number(row?.pending) || 0, acked: Number(row?.acked) || 0 };
}

export function outboxEntries(store, { limit = 100 } = {}) {
  const db = store?.db;
  if (!db?.prepare || !tableExists(db, "directory_outbox")) return [];
  return db.prepare("SELECT id, room_id AS roomId, sequence, kind, payload, created_at AS createdAt, acked_at AS ackedAt, attempts FROM directory_outbox ORDER BY id LIMIT ?")
    .all(limit)
    .map(row => ({ ...row, payload: JSON.parse(row.payload) }));
}

// ---------------------------------------------------------------- adapters
// Adapter interface: { name, wired, apply(entries) } where apply resolves
// to { acked: [entryId...] } — the entries the target durably applied.
// Entries not acked stay pending and are retried by a later tick
// (at-least-once); the target dedupes by (roomId, sequence, kind).

// NOT YET WIRED — production stub. There is no D1 binding to write to.
// The drain checks `wired` before calling apply, so this adapter's apply
// is never on a hot path; if it is ever called directly it refuses loudly
// rather than pretending to publish. Failing safe means: entries
// accumulate in the outbox, nothing is acked, nothing is trimmed, and the
// job heartbeat stays healthy (a missing binding is a configuration
// state, not a per-tick error).
export function createUnwiredDirectoryAdapter() {
  return Object.freeze({
    name: "d1-directory-unwired",
    wired: false,
    async apply() { throw new Error("directory adapter is not wired: no D1 binding exists yet"); }
  });
}

// The production selection today: the unwired stub, whatever the env
// says — there is no D1 binding to select. The day D1 exists, this is the
// one function that learns to build the real adapter from the binding.
export function directoryAdapterForEnv(_env = {}) {
  return createUnwiredDirectoryAdapter();
}

// In-memory fake D1 for tests and rehearsals: the directory writes the
// real D1 adapter will perform (registry upsert, seat upsert/tombstone,
// public flags), keyed and deduped exactly as the D1 schema will be.
// Re-applying the same entries converges to the same state.
export class FakeD1Directory {
  constructor() {
    this.name = "fake-d1-directory";
    this.wired = true;
    this.registry = new Map(); // roomId -> registry row
    this.seats = new Map(); // `${roomId}\0${memberId}` -> seat row
    this.applied = new Set(); // `${roomId}\0${sequence}\0${kind}` dedupe keys
    this.applyCalls = 0;
    this.duplicatesSkipped = 0;
  }

  async apply(entries) {
    this.applyCalls += 1;
    const acked = [];
    for (const entry of entries) {
      const key = `${entry.roomId}\0${entry.sequence}\0${entry.kind}`;
      acked.push(entry.id);
      if (this.applied.has(key)) { this.duplicatesSkipped += 1; continue; }
      this.applied.add(key);
      const payload = entry.payload ?? {};
      if (payload.registry) {
        this.registry.set(entry.roomId, { ...payload.registry, public: payload.public ?? null });
      }
      const seatDeltas = payload.seat ? [payload.seat] : Array.isArray(payload.seats) ? payload.seats : [];
      for (const seat of seatDeltas) {
        const seatKey = `${entry.roomId}\0${seat.memberId}`;
        if (seat.active === false) this.seats.delete(seatKey);
        else this.seats.set(seatKey, { roomId: entry.roomId, ...seat });
      }
    }
    return { acked };
  }

  snapshot() {
    return {
      registry: [...this.registry.values()].sort((a, b) => String(a.roomId).localeCompare(String(b.roomId))),
      seats: [...this.seats.values()].sort((a, b) => `${a.roomId}${a.memberId}`.localeCompare(`${b.roomId}${b.memberId}`)),
      applied: this.applied.size
    };
  }
}

// -------------------------------------------------------------------- drain
// One bounded drain tick. The pending scan in id order is the cursor:
// entries acked are marked in one transaction per batch; a tick that hits
// its deadline stops between batches and the next tick resumes from the
// first unacked row. An adapter that throws fails the tick WITHOUT acking
// (the error propagates to the job heartbeat); attempts are counted so a
// poison entry is visible instead of silently spinning.
export async function drainOutbox(store, { adapter, deadline = Infinity, batchSize = OUTBOX_BATCH, now = () => Date.now() } = {}) {
  if (!adapter) throw new TypeError("drainOutbox needs an adapter");
  const stats = outboxStats(store);
  if (adapter.wired === false) {
    // Fail safe: do not call apply, do not burn attempts, do not trim.
    return { wired: false, drained: 0, pending: stats.pending, adapter: adapter.name };
  }
  if (!tableExists(store.db, "directory_outbox")) return { wired: true, drained: 0, pending: 0, adapter: adapter.name };
  const cap = Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500 ? batchSize : OUTBOX_BATCH;
  let drained = 0;
  let budgetExceeded = 0;
  for (;;) {
    if (Date.now() > deadline) { budgetExceeded = 1; break; }
    const rows = store.db.prepare(`SELECT id, room_id AS roomId, sequence, kind, payload
      FROM directory_outbox WHERE acked_at IS NULL ORDER BY id LIMIT ?`).all(cap);
    if (!rows.length) break;
    const entries = rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    let acked = [];
    try {
      const result = await adapter.apply(entries);
      acked = Array.isArray(result?.acked) ? result.acked : [];
    } catch (error) {
      store.transaction(() => {
        const bump = store.db.prepare("UPDATE directory_outbox SET attempts = attempts + 1 WHERE id = ?");
        for (const entry of entries) bump.run(entry.id);
      });
      throw error;
    }
    const ackedSet = new Set(acked);
    if (!ackedSet.size) break; // target accepted nothing: stop, do not spin
    const ackedAt = now();
    store.transaction(() => {
      const mark = store.db.prepare("UPDATE directory_outbox SET acked_at = ? WHERE id = ? AND acked_at IS NULL");
      for (const entry of entries) if (ackedSet.has(entry.id)) mark.run(ackedAt, entry.id);
      const bump = store.db.prepare("UPDATE directory_outbox SET attempts = attempts + 1 WHERE id = ? AND acked_at IS NULL");
      for (const entry of entries) if (!ackedSet.has(entry.id)) bump.run(entry.id);
    });
    drained += ackedSet.size;
    if (rows.length < cap) break;
  }
  const trimmed = trimOutbox(store);
  const result = { wired: true, drained, pending: outboxStats(store).pending, trimmed, adapter: adapter.name };
  if (budgetExceeded) result.budgetExceeded = 1;
  return result;
}

// Trim acked entries beyond the retained window. Unacked entries are
// never touched: an entry is trimmable only after the target acked it.
export function trimOutbox(store, { keepAcked = OUTBOX_KEEP_ACKED } = {}) {
  const db = store?.db;
  if (!db?.prepare || !tableExists(db, "directory_outbox")) return 0;
  const keep = Number.isSafeInteger(keepAcked) && keepAcked >= 0 ? keepAcked : OUTBOX_KEEP_ACKED;
  const boundary = db.prepare(`SELECT id FROM directory_outbox WHERE acked_at IS NOT NULL
    ORDER BY id DESC LIMIT 1 OFFSET ?`).get(keep);
  if (!boundary) return 0;
  const result = db.prepare("DELETE FROM directory_outbox WHERE acked_at IS NOT NULL AND id <= ?").run(boundary.id);
  return Number(result.changes) || 0;
}

// Reconciler seed (design §3.7.3): backfill outbox entries from the room
// journal for sequences the hooked writers did not cover (direct event
// appends outside command()). Payloads are journal-derived (no post-commit
// state survives historically), so registry summaries stay null on these
// entries — the directory treats them as sequence watermarks, and a later
// hooked write or snapshot fills the summary in. Bounded + deadline-aware
// like every other sweep in this codebase.
export function backfillOutboxFromJournal(store, { deadline = Infinity, limit = 200 } = {}) {
  const db = store?.db;
  if (!db?.prepare || !tableExists(db, "rooms")) return { appended: 0, budgetExceeded: 0 };
  ensureOutboxSchema(db);
  const cap = Number.isInteger(limit) && limit > 0 && limit <= 1000 ? limit : 200;
  let appended = 0;
  let budgetExceeded = 0;
  const rooms = db.prepare("SELECT id FROM rooms ORDER BY id").all();
  for (const room of rooms) {
    if (appended >= cap) break;
    if (Date.now() > deadline) { budgetExceeded = 1; break; }
    const covered = new Set(db.prepare("SELECT sequence FROM directory_outbox WHERE room_id = ?").all(room.id).map(row => row.sequence));
    const rows = db.prepare("SELECT sequence, body FROM events WHERE room_id = ? ORDER BY sequence").all(room.id);
    for (const row of rows) {
      if (covered.has(row.sequence) || appended >= cap) continue;
      let event = null;
      try { event = JSON.parse(row.body); } catch { event = null; }
      const payload = {
        v: 1, backfilled: true,
        eventId: typeof event?.id === "string" ? event.id : null,
        eventType: typeof event?.type === "string" ? event.type : null,
        actorId: typeof event?.actorId === "string" ? event.actorId : null,
        at: typeof event?.at === "string" ? event.at : null,
        registry: null, public: null
      };
      const inserted = appendOutboxEntry(db, {
        roomId: room.id, sequence: row.sequence, kind: "room_event", payload, now: store.now()
      });
      if (inserted) appended += 1;
    }
  }
  return { appended, budgetExceeded };
}
