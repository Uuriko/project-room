// Resident invariant patrol (ClueBot phase 1).
//
// The batch integrity suite (verifyRoomIntegrity + runDeferredIntegrityBatch)
// checks the store room-by-room on a rotating cursor: when it fails, it names
// a record class and nothing else — during the 2026-10 messages_backfill
// incident it failed 98 times in a row without naming the room. This patrol
// is the per-event complement the read-only patrol test validated
// (idea-forge/cluebot-readonly-report.md: 0 false positives over a live
// room's whole log, 3/3 injected faults attributed to the introducing event):
// it tails each room's event appends and re-checks the codebase's own
// invariants at the event that introduces a divergence.
//
// Phase 1 is READ-ONLY / WOULD-FREEZE. The patrol writes only its own tables
// (patrol_cursor, patrol_claims, patrol_messages, patrol_findings). It never
// mutates room state, never blocks or alters a write, and never throws into a
// caller: a room whose log it cannot process costs that room one error count
// and cannot stall another room's checks (no shared cursor). Freeze rights
// are a later decision, taken on this phase's measured false-positive rate.
//
// Checks (each is the per-event form of a batch check, no invented rules):
// - sequence: the log is contiguous and reaches the room head. A gap is
//   named at the first missing sequence; a log that ends before
//   rooms.sequence (the production truncation shape) files head_gap and
//   parks the room until its head moves. Idempotency keys stay unique
//   (batch window + one bounded look-back), and the event id recorded at
//   the cursor must still match — a replaced log (importEvents) resets the
//   room's patrol state and replays, the messages-backfill cursor rule.
// - messages_parity: a shadow record per message is folded from the
//   message.posted/edited/deleted/redacted events using the reducer's own
//   derivation (body hash, author, createdAt). When a room's tail reaches
//   its head, the shadow is compared against the hydrated projection — the
//   same served record checkMessagesParity certifies — archive-aware, in
//   both directions (a served message with no posting event is named too).
// - claim_legality: work_claim.updated events are validated against
//   CLAIM_LIFECYCLE (server/work-claims.mjs) plus the lease sweep's release
//   (releaseExpired: an active claim may return to unclaimed). Held states
//   (and done) must carry an owner, unclaimed must not; a claim taken while
//   held, or changing owner while held outside a reassign, is a
//   double-claim. At the head, the shadow is compared with the work_claims
//   registry, the source of truth the events merely receipt.
// - receipt_linkage: receipts are a pure projection of done claims
//   (rc_<claimId>, receiptOf in server/work-claim-routes.mjs), so the
//   per-event form checks the done item itself: a claim the patrol watched
//   reach done must sit in the registry with an owner (the receipt's
//   creator) and exactly one "state:done" history stamp — the receipts
//   surface's own stated invariant ("Done is immutable, so there is
//   exactly one").
//
// Findings are a journal, not an alarm that re-fires: patrol_findings is
// unique on (room, invariant, kind, subject, sequence), so a divergence is
// filed once, with the room, the event sequence and id, and the hashes the
// batch system could not name. A tick that files fresh findings reports
// them through the job heartbeat's failure channel (scanError +
// failureDetail tokens, the #3334 shapes); steady-state ticks carry the
// journal's size in the numeric summary. The full journal is read through
// patrolFindings() — record ids deliberately stay off the public health
// surface, per the #3334 rule.
import { createHash } from "node:crypto";
import { ACTIVE_CLAIM_STATES, CLAIM_LIFECYCLE, STATES as CLAIM_STATES } from "./work-claims.mjs";
import { hydrateProjection } from "./projection-at-rest.mjs";
import { affectedMessageIds, archiveMarker } from "./messages-store.mjs";

// Events tailed per room per tick — the messages backfill's batch size, so a
// long room catches up over ticks instead of holding one tick open.
export const PATROL_BATCH = 200;

export const PATROL_INVARIANTS = Object.freeze(["sequence", "messages_parity", "claim_legality", "receipt_linkage"]);

const RECORD_CLASS = Object.freeze({
  sequence: "room",
  messages_parity: "message",
  claim_legality: "claim",
  receipt_linkage: "receipt"
});

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const bodyHashOf = message => (typeof message?.body === "string" ? sha256(message.body) : null);

const HELD_STATES = new Set(["claimed", "in_progress", "blocked", "delivered"]);
const OWNER_REQUIRED_STATES = new Set([...HELD_STATES, "done"]);
// CLAIM_LIFECYCLE governs the /update verbs. The lease sweep is the one
// other designed path: releaseExpired returns an active claim to
// unclaimed, so that move is legal from every active state.
const LEGAL_NEXT = new Map(Object.entries(CLAIM_LIFECYCLE).map(([state, row]) => [state, new Set(Object.values(row))]));
for (const state of ACTIVE_CLAIM_STATES) LEGAL_NEXT.get(state)?.add("unclaimed");

export const PATROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS patrol_cursor (
  room_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_head INTEGER
);
CREATE TABLE IF NOT EXISTS patrol_claims (
  room_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  state TEXT NOT NULL,
  owner_id TEXT,
  last_sequence INTEGER NOT NULL,
  done_sequence INTEGER,
  PRIMARY KEY (room_id, claim_id)
);
CREATE TABLE IF NOT EXISTS patrol_messages (
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  author_id TEXT,
  body_sha256 TEXT,
  created_at TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 0,
  last_sequence INTEGER NOT NULL,
  PRIMARY KEY (room_id, message_id)
);
CREATE TABLE IF NOT EXISTS patrol_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_id TEXT,
  invariant TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  detail TEXT,
  at TEXT NOT NULL,
  UNIQUE (room_id, invariant, kind, subject_id, sequence)
);`;

export function ensurePatrolSchema(store) {
  store.db.exec(PATROL_SCHEMA);
}

function tableExists(db, name) {
  try { return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)); }
  catch { return false; }
}

// True when some room has events the patrol has not tailed (or the patrol
// has never run on a store that has rooms). A parked room counts only once
// its head moves. This is the job gate: an idle store never wakes for the
// patrol.
export function patrolPending(store) {
  const db = store?.db;
  if (!db?.prepare) return false;
  if (!tableExists(db, "rooms")) return false;
  if (!tableExists(db, "patrol_cursor")) {
    // The patrol has never run against this store. That is work waiting
    // only when some room actually has events to tail — a store with no
    // rooms (or only empty ones) has nothing to patrol, and treating it
    // as pending would arm the job in rooms that should stay asleep.
    try {
      const row = db.prepare("SELECT 1 AS hit FROM rooms WHERE sequence > 0 LIMIT 1").get();
      return Boolean(row?.hit);
    } catch { return true; }
  }
  try {
    const row = db.prepare(`SELECT 1 AS hit FROM rooms r
      LEFT JOIN patrol_cursor c ON c.room_id = r.id
      WHERE r.sequence > COALESCE(c.sequence, 0)
        AND (COALESCE(c.blocked, 0) = 0 OR r.sequence != c.blocked_head)
      LIMIT 1`).get();
    return Boolean(row?.hit);
  } catch { return true; }
}

export function patrolFindings(store, { roomId = null, limit = 100 } = {}) {
  if (!store?.db?.prepare || !tableExists(store.db, "patrol_findings")) return [];
  const rows = roomId
    ? store.db.prepare("SELECT * FROM patrol_findings WHERE room_id=? ORDER BY id DESC LIMIT ?").all(roomId, limit)
    : store.db.prepare("SELECT * FROM patrol_findings ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map(row => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
}

export function patrolStatus(store) {
  if (!store?.db?.prepare || !tableExists(store.db, "patrol_cursor")) return { rooms: [], findings: 0 };
  const rooms = store.db.prepare(`SELECT c.room_id AS roomId, c.sequence, c.blocked,
      (SELECT COUNT(*) FROM patrol_findings f WHERE f.room_id = c.room_id) AS findings
    FROM patrol_cursor c ORDER BY c.room_id`).all();
  const total = store.db.prepare("SELECT COUNT(*) AS n FROM patrol_findings").get().n;
  return { rooms, findings: total };
}

export function runPatrolTick(store, { deadline = Infinity, limit = PATROL_BATCH, roomId = null } = {}) {
  if (!store?.db?.prepare) return { skipped: 1 };
  if (store.readOnly) return { skipped: 1, readOnly: 1 };
  ensurePatrolSchema(store);
  const rooms = roomId
    ? store.db.prepare("SELECT id, sequence FROM rooms WHERE id=?").all(roomId)
    : store.db.prepare("SELECT id, sequence FROM rooms ORDER BY id").all();
  let checked = 0;
  let patrolled = 0;
  let errors = 0;
  let firstErrorRoom = null;
  let budgetExceeded = 0;
  const fresh = [];
  for (const room of rooms) {
    if (Date.now() > deadline) { budgetExceeded = 1; break; }
    const cursor = store.db.prepare("SELECT sequence, blocked, blocked_head FROM patrol_cursor WHERE room_id=?").get(room.id);
    const caughtUp = (cursor?.sequence ?? 0) >= room.sequence && !roomId;
    const parked = cursor?.blocked === 1 && cursor.blocked_head === room.sequence;
    if (caughtUp || parked) continue;
    patrolled += 1;
    try {
      const outcome = patrolRoom(store, room, { deadline, limit, forced: Boolean(roomId) });
      checked += outcome.checked;
      fresh.push(...outcome.fresh);
      if (outcome.budgetExceeded) budgetExceeded = 1;
    } catch (error) {
      // One room's unprocessable log is that room's error, never a reason to
      // stall the others. The cursor was not advanced (patrolRoom writes in
      // one transaction), so the next tick retries from the same sequence.
      errors += 1;
      firstErrorRoom ??= room.id;
      console.error(`[patrol] room ${room.id} failed: ${error?.message ?? error}`);
    }
  }
  const findings = store.db.prepare("SELECT COUNT(*) AS n FROM patrol_findings").get().n;
  const result = { checked, rooms: patrolled, fresh: fresh.length, findings };
  if (budgetExceeded) result.budgetExceeded = 1;
  if (fresh.length) {
    const first = fresh[0];
    // The health surface is public-shaped (#3334): record ids never reach
    // it, so the error names the invariant, the event sequence and the
    // kind. The room, the event id and the hashes live in the findings
    // journal (patrolFindings) — the patrol's evidence record.
    result.scanError = `patrol ${first.invariant} invariant failed at sequence ${first.sequence} (${first.kind})`;
    result.failureDetail = {
      code: "patrol_finding",
      subcheck: first.invariant,
      errorClass: "integrity_mismatch",
      recordClass: RECORD_CLASS[first.invariant] ?? "unknown"
    };
  }
  if (errors) {
    result.errors = errors;
    if (!fresh.length) {
      result.scanError = `patrol could not process room ${firstErrorRoom}`;
      result.failureDetail = { code: "patrol_error", subcheck: "patrol", errorClass: "unknown", recordClass: "room" };
    }
  }
  return result;
}

// Tail one room from its cursor. The log, the room head, and — when the
// tail reaches the head — the projection and the claim registry are all
// read inside one read transaction, so every comparison is made as of the
// same head. Findings, shadow updates and the cursor advance then commit
// in a single write transaction: a failure anywhere leaves the room
// exactly where the tick found it.
function patrolRoom(store, roomRow, { deadline, limit, forced }) {
  const db = store.db;
  const roomId = roomRow.id;
  const selectClaim = db.prepare("SELECT claim_id, state, owner_id, last_sequence, done_sequence FROM patrol_claims WHERE room_id=? AND claim_id=?");
  const selectMessage = db.prepare("SELECT message_id, author_id, body_sha256, created_at, deleted, redacted, last_sequence FROM patrol_messages WHERE room_id=? AND message_id=?");
  const claimRowOf = row => (row ? { claimId: row.claim_id, state: row.state, ownerId: row.owner_id, lastSequence: row.last_sequence, doneSequence: row.done_sequence } : null);
  const messageRowOf = row => (row ? { messageId: row.message_id, authorId: row.author_id, bodySha256: row.body_sha256, createdAt: row.created_at, deleted: row.deleted === 1, redacted: row.redacted === 1, lastSequence: row.last_sequence } : null);

  const snapshot = store.readTransaction(() => {
    const headRow = db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
    if (!headRow) return null;
    let cursor = db.prepare("SELECT sequence, event_id, blocked, blocked_head FROM patrol_cursor WHERE room_id=?").get(roomId)
      ?? { sequence: 0, event_id: "", blocked: 0, blocked_head: null };
    // Log replacement (importEvents) or a tail the cursor has already
    // passed invalidates every shadow: the recorded event id at the cursor
    // must still be the log's event there (the backfill cursor rule).
    let reset = false;
    if (cursor.sequence > 0) {
      const atCursor = db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, cursor.sequence);
      if (cursor.sequence > headRow.sequence || !atCursor || atCursor.id !== cursor.event_id) reset = true;
    }
    if (reset) cursor = { sequence: 0, event_id: "", blocked: 0, blocked_head: null };
    const rows = db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?")
      .all(roomId, cursor.sequence, limit);
    const lastSeq = rows.length ? rows[rows.length - 1].sequence : cursor.sequence;
    const probeSeq = rows.length ? lastSeq : cursor.sequence;
    const moreBeyond = Boolean(db.prepare("SELECT 1 AS hit FROM events WHERE room_id=? AND sequence>? LIMIT 1").get(roomId, probeSeq)?.hit);
    const reachedHead = !moreBeyond && lastSeq <= headRow.sequence;
    const snap = { roomId, head: headRow.sequence, cursor, reset, rows, reachedHead, lastSeq };
    if (reachedHead) {
      snap.projection = headRow.projection;
      snap.headEventId = headRow.sequence > 0
        ? db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, headRow.sequence)?.id ?? null
        : null;
      snap.marker = archiveMarker(db, roomId);
      snap.claimShadow = new Map(db.prepare("SELECT claim_id, state, owner_id, last_sequence, done_sequence FROM patrol_claims WHERE room_id=?")
        .all(roomId).map(row => [row.claim_id, claimRowOf(row)]));
      snap.messageShadow = new Map(db.prepare("SELECT message_id, author_id, body_sha256, created_at, deleted, redacted, last_sequence FROM patrol_messages WHERE room_id=?")
        .all(roomId).map(row => [row.message_id, messageRowOf(row)]));
    }
    return snap;
  });
  if (!snapshot) return { checked: 0, fresh: [], budgetExceeded: 0 };
  const { head, rows } = snapshot;
  const cursor = snapshot.cursor;
  const findings = [];
  const file = (sequence, eventId, invariant, kind, subjectId, detail) => {
    findings.push({ roomId, sequence, eventId, invariant, kind, subjectId, detail });
  };

  // Shadow access: this batch's updates overlay the stored shadow. Stored
  // rows come from the snapshot when the tail reaches the head, else from a
  // point read (the patrol is the only writer of its own tables, and ticks
  // are serialized by the job runner, so a point read cannot race).
  const claimWork = new Map();
  const messageWork = new Map();
  const touchedClaims = new Set();
  const deletedClaims = new Set();
  const touchedMessages = new Set();
  const claimPrior = claimId => {
    if (claimWork.has(claimId)) return claimWork.get(claimId);
    const prior = snapshot.claimShadow?.get(claimId) ?? claimRowOf(selectClaim.get(roomId, claimId));
    claimWork.set(claimId, prior);
    return prior;
  };
  const messagePrior = messageId => {
    if (messageWork.has(messageId)) return messageWork.get(messageId);
    const prior = snapshot.messageShadow?.get(messageId) ?? messageRowOf(selectMessage.get(roomId, messageId));
    messageWork.set(messageId, prior);
    return prior;
  };

  let expected = cursor.sequence + 1;
  let processedEnd = cursor.sequence;
  let processedCount = 0;
  let lastEventId = cursor.event_id;
  let budgetExceeded = 0;
  const batchStart = cursor.sequence;
  const batchKeys = new Map();
  const batchIds = new Set();
  const keyUses = [];

  for (let index = 0; index < rows.length; index++) {
    if (index > 0 && index % 50 === 0 && Date.now() > deadline) { budgetExceeded = 1; break; }
    const row = rows[index];
    if (row.sequence > expected) {
      file(expected, null, "sequence", "gap", null, { expectedSequence: expected, foundSequence: row.sequence });
    }
    expected = row.sequence + 1;
    processedEnd = row.sequence;
    processedCount += 1;
    lastEventId = row.id;
    if (batchIds.has(row.id)) file(row.sequence, row.id, "sequence", "event_id_duplicate", row.id, {});
    batchIds.add(row.id);
    let event;
    try { event = JSON.parse(row.body); }
    catch {
      file(row.sequence, row.id, "sequence", "unparseable_event", null, {});
      continue;
    }
    if (typeof event?.idempotencyKey === "string" && event.idempotencyKey) {
      if (batchKeys.has(event.idempotencyKey)) {
        file(row.sequence, row.id, "sequence", "idempotency_duplicate", null,
          { firstSequence: batchKeys.get(event.idempotencyKey), sequence: row.sequence });
      } else {
        batchKeys.set(event.idempotencyKey, row.sequence);
        keyUses.push({ key: event.idempotencyKey, sequence: row.sequence, eventId: row.id });
      }
    }
    if (event?.type === "work_claim.updated") {
      patrolClaimEvent({ file, claimPrior, claimWork, touchedClaims, deletedClaims, event, sequence: row.sequence, eventId: row.id });
    } else if (typeof event?.type === "string" && event.type.startsWith("message.")) {
      for (const id of patrolMessageEvent({ messagePrior, messageWork, event, sequence: row.sequence })) {
        touchedMessages.add(id);
      }
    }
  }

  // Idempotency look-back: a key first used before this batch must not be
  // re-used inside it. One bounded query over the batch's keys.
  if (!budgetExceeded && keyUses.length && batchStart > 0) {
    const keys = [...new Set(keyUses.map(use => use.key))];
    const placeholders = keys.map(() => "?").join(",");
    const prior = db.prepare(`SELECT sequence, json_extract(body, '$.idempotencyKey') AS k
      FROM events WHERE room_id=? AND sequence<=? AND json_extract(body, '$.idempotencyKey') IN (${placeholders})`)
      .all(roomId, batchStart, ...keys);
    if (prior.length) {
      const firstByKey = new Map(prior.map(row => [row.k, row.sequence]));
      for (const use of keyUses) {
        if (firstByKey.has(use.key)) {
          file(use.sequence, use.eventId, "sequence", "idempotency_duplicate", null,
            { firstSequence: firstByKey.get(use.key), sequence: use.sequence });
        }
      }
    }
  }

  let blocked = 0;
  let blockedHead = null;
  if (snapshot.reachedHead && !budgetExceeded) {
    if (processedEnd < head) {
      // The log ends before the room head: the truncation shape. File it at
      // the first missing sequence and park the room until the head moves.
      file(processedEnd + 1, null, "sequence", "head_gap", null, { roomSequence: head, loggedThrough: processedEnd });
      blocked = 1;
      blockedHead = head;
    } else {
      patrolAgreements({ store, file, snapshot, claimWork, claimPrior, messageWork, touchedClaims, deletedClaims, touchedMessages, forced });
    }
  }

  const fresh = store.transaction(() => {
    if (snapshot.reset) {
      db.prepare("DELETE FROM patrol_claims WHERE room_id=?").run(roomId);
      db.prepare("DELETE FROM patrol_messages WHERE room_id=?").run(roomId);
    }
    const insert = db.prepare(`INSERT OR IGNORE INTO patrol_findings
      (room_id, sequence, event_id, invariant, kind, subject_id, detail, at) VALUES (?,?,?,?,?,?,?,?)`);
    const at = store.now();
    const freshRows = [];
    for (const finding of findings) {
      const outcome = insert.run(finding.roomId, finding.sequence, finding.eventId, finding.invariant,
        finding.kind, finding.subjectId, finding.detail ? JSON.stringify(finding.detail) : null, at);
      if (outcome.changes > 0) freshRows.push(finding);
    }
    const upsertClaim = db.prepare(`INSERT INTO patrol_claims (room_id, claim_id, state, owner_id, last_sequence, done_sequence)
      VALUES (?,?,?,?,?,?) ON CONFLICT(room_id, claim_id) DO UPDATE SET
      state=excluded.state, owner_id=excluded.owner_id, last_sequence=excluded.last_sequence, done_sequence=excluded.done_sequence`);
    for (const claimId of touchedClaims) {
      const shadow = claimWork.get(claimId);
      if (shadow) upsertClaim.run(roomId, claimId, shadow.state, shadow.ownerId, shadow.lastSequence, shadow.doneSequence);
    }
    for (const claimId of deletedClaims) {
      db.prepare("DELETE FROM patrol_claims WHERE room_id=? AND claim_id=?").run(roomId, claimId);
    }
    const upsertMessage = db.prepare(`INSERT INTO patrol_messages (room_id, message_id, author_id, body_sha256, created_at, deleted, redacted, last_sequence)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(room_id, message_id) DO UPDATE SET
      author_id=excluded.author_id, body_sha256=excluded.body_sha256, created_at=excluded.created_at,
      deleted=excluded.deleted, redacted=excluded.redacted, last_sequence=excluded.last_sequence`);
    for (const messageId of touchedMessages) {
      const shadow = messageWork.get(messageId);
      if (shadow) upsertMessage.run(roomId, messageId, shadow.authorId, shadow.bodySha256, shadow.createdAt,
        shadow.deleted ? 1 : 0, shadow.redacted ? 1 : 0, shadow.lastSequence);
    }
    db.prepare(`INSERT INTO patrol_cursor (room_id, sequence, event_id, blocked, blocked_head) VALUES (?,?,?,?,?)
      ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, event_id=excluded.event_id,
      blocked=excluded.blocked, blocked_head=excluded.blocked_head`)
      .run(roomId, processedEnd, lastEventId, blocked, blockedHead);
    return freshRows;
  });
  return { checked: processedCount, fresh, budgetExceeded };
}

// One work_claim.updated event against the claim shadow. The event is a
// thin receipt (work-claim-events.mjs): { workClaim, action, claimState,
// ownerId }. The registry row is the truth; the shadow is what the log
// claims happened, in order.
function patrolClaimEvent({ file, claimPrior, claimWork, touchedClaims, deletedClaims, event, sequence, eventId }) {
  const data = event.data ?? {};
  const claimId = typeof data.workClaim === "string" && data.workClaim ? data.workClaim : null;
  if (!claimId || typeof data.claimState !== "string") return;
  const nextState = data.claimState;
  const nextOwner = typeof data.ownerId === "string" && data.ownerId ? data.ownerId : null;
  const action = typeof data.action === "string" ? data.action : null;
  const prior = claimPrior(claimId);
  if (action === "deleted") {
    // The registry row is gone by design (workClaims.delete). Forget the
    // shadow so the agreement leg does not report the deletion as loss.
    claimWork.set(claimId, null);
    touchedClaims.delete(claimId);
    deletedClaims.add(claimId);
    return;
  }
  if (!CLAIM_STATES.includes(nextState)) {
    file(sequence, eventId, "claim_legality", "unknown_state", claimId, { state: nextState, action });
  } else if (prior) {
    if (nextState !== prior.state && !(LEGAL_NEXT.get(prior.state)?.has(nextState) ?? false)) {
      file(sequence, eventId, "claim_legality", "illegal_transition", claimId,
        { from: prior.state, to: nextState, action });
    }
    if (HELD_STATES.has(prior.state) && HELD_STATES.has(nextState) && prior.ownerId && nextOwner
      && prior.ownerId !== nextOwner && action !== "reassigned") {
      file(sequence, eventId, "claim_legality", "double_claim", claimId,
        { fromOwner: prior.ownerId, toOwner: nextOwner, action });
    }
    if (action === "claimed" && HELD_STATES.has(prior.state)) {
      file(sequence, eventId, "claim_legality", "double_claim", claimId,
        { fromOwner: prior.ownerId, toOwner: nextOwner, action });
    }
  }
  if (OWNER_REQUIRED_STATES.has(nextState) && !nextOwner) {
    file(sequence, eventId, "claim_legality", "owner_missing", claimId, { state: nextState, action });
  }
  if (nextState === "unclaimed" && nextOwner) {
    file(sequence, eventId, "claim_legality", "owner_on_unclaimed", claimId, { ownerId: nextOwner, action });
  }
  const doneSequence = nextState !== "done" ? null
    : prior?.state === "done" ? prior.doneSequence : sequence;
  claimWork.set(claimId, { claimId, state: nextState, ownerId: nextOwner, lastSequence: sequence, doneSequence });
  touchedClaims.add(claimId);
}

// One message event against the message shadow. The fold mirrors the
// reducer (src/events.js postMessage / editMessage / deleteMessage /
// redactMessage): a post records body hash + author + createdAt; an edit
// replaces the body; a delete or redaction empties it.
function patrolMessageEvent({ messagePrior, messageWork, event, sequence }) {
  const type = event.type;
  if (type !== "message.posted" && type !== "message.edited" && type !== "message.deleted" && type !== "message.redacted") {
    return [];
  }
  const data = event.data ?? {};
  const ids = affectedMessageIds(event);
  const touched = [];
  for (const id of ids) {
    const prior = messagePrior(id);
    if (type === "message.posted") {
      const redactedPost = data.redacted === true && data.body == null;
      messageWork.set(id, {
        messageId: id,
        authorId: typeof event.actorId === "string" ? event.actorId : prior?.authorId ?? null,
        bodySha256: typeof data.body === "string" ? sha256(data.body) : null,
        createdAt: typeof event.at === "string" ? event.at : prior?.createdAt ?? null,
        deleted: false,
        redacted: redactedPost,
        lastSequence: sequence
      });
      touched.push(id);
    } else if (prior) {
      if (type === "message.edited") {
        messageWork.set(id, { ...prior, bodySha256: typeof data.body === "string" ? sha256(data.body) : null, lastSequence: sequence });
      } else if (type === "message.deleted") {
        messageWork.set(id, { ...prior, bodySha256: null, deleted: true, lastSequence: sequence });
      } else {
        messageWork.set(id, { ...prior, bodySha256: null, deleted: true, redacted: true, lastSequence: sequence });
      }
      touched.push(id);
    }
  }
  return touched;
}

// The agreement legs, run when a room's tail has reached its head in this
// tick (or on an operator-forced recheck): the shadow the log implies is
// compared with what the room actually serves and stores.
function patrolAgreements({ store, file, snapshot, claimWork, claimPrior, messageWork, touchedClaims, deletedClaims, touchedMessages, forced }) {
  const db = store.db;
  const roomId = snapshot.roomId;
  const head = snapshot.head;
  const headEventId = snapshot.headEventId;

  // Messages: full shadow vs the hydrated projection, both directions.
  // Runs when this tick touched messages, and on a forced recheck.
  if (touchedMessages.size || forced) {
    const merged = new Map(snapshot.messageShadow ?? []);
    for (const [id, shadow] of messageWork) if (shadow) merged.set(id, shadow);
    const hydration = hydrateProjection(db, roomId, JSON.parse(snapshot.projection));
    const served = new Map((hydration.state.messages ?? []).map(message => [message.id, message]));
    const missingBodies = new Set(hydration.missing ?? []);
    const retained = retainedIdSet(snapshot.marker);
    const archivedSeq = messageId => {
      if (!snapshot.marker?.throughSeq || retained.has(messageId)) return false;
      const row = db.prepare("SELECT seq FROM messages WHERE room_id=? AND message_id=?").get(roomId, messageId);
      return Boolean(row) && row.seq <= snapshot.marker.throughSeq;
    };
    for (const [id, shadow] of merged) {
      const record = served.get(id);
      if (!record) {
        if (!archivedSeq(id)) {
          file(shadow.lastSequence, null, "messages_parity", "projection_missing", id,
            { authorId: shadow.authorId, bodySha256: shadow.bodySha256 });
        }
        continue;
      }
      if (missingBodies.has(id)) {
        file(shadow.lastSequence, null, "messages_parity", "body_missing", id, { bodySha256: shadow.bodySha256 });
        continue;
      }
      const actualHash = bodyHashOf(record);
      if (actualHash !== shadow.bodySha256 || record.authorId !== shadow.authorId || record.createdAt !== shadow.createdAt) {
        file(shadow.lastSequence, null, "messages_parity", "record_differs", id, {
          expectedBodySha256: shadow.bodySha256, actualBodySha256: actualHash,
          expectedAuthorId: shadow.authorId, actualAuthorId: record.authorId ?? null,
          expectedCreatedAt: shadow.createdAt, actualCreatedAt: record.createdAt ?? null
        });
      }
    }
    for (const id of served.keys()) {
      if (!merged.has(id) && !archivedSeq(id)) {
        file(head, headEventId, "messages_parity", "projection_unposted", id, {});
      }
    }
  }

  // Claims: touched claims agree with the registry; watched completions
  // satisfy the receipt invariant.
  const mergedClaims = new Map(snapshot.claimShadow ?? []);
  for (const [id, shadow] of claimWork) if (shadow) mergedClaims.set(id, shadow);
  for (const claimId of touchedClaims) {
    if (deletedClaims.has(claimId)) continue;
    const shadow = mergedClaims.get(claimId) ?? claimPrior(claimId);
    if (!shadow) continue;
    const item = store.workClaims?.get(roomId, claimId) ?? null;
    if (!item) {
      file(shadow.lastSequence, null, "claim_legality", "registry_missing", claimId,
        { state: shadow.state, ownerId: shadow.ownerId });
      continue;
    }
    if (item.state !== shadow.state || (item.owner ?? null) !== shadow.ownerId) {
      file(shadow.lastSequence, null, "claim_legality", "surface_differs", claimId, {
        shadowState: shadow.state, registryState: item.state ?? null,
        shadowOwnerId: shadow.ownerId, registryOwnerId: item.owner ?? null
      });
      continue;
    }
    if (shadow.state === "done" && shadow.doneSequence != null) {
      const doneEvent = db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, shadow.doneSequence);
      if (!item.owner) {
        file(shadow.doneSequence, doneEvent?.id ?? null, "receipt_linkage", "done_without_owner", claimId, {});
      }
      const stamps = (Array.isArray(item.history) ? item.history : []).filter(entry => entry?.action === "state:done").length;
      if (stamps !== 1) {
        file(shadow.doneSequence, doneEvent?.id ?? null, "receipt_linkage", "done_stamp_count", claimId, { stamps });
      }
    }
  }
}

function retainedIdSet(marker) {
  if (!marker?.retainedJson) return new Set();
  try {
    const parsed = JSON.parse(marker.retainedJson);
    return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === "string") : []);
  } catch { return new Set(); }
}
