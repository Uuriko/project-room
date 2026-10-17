import { hydrateProjection, storedProjection } from "./projection-at-rest.mjs";
import { closeKeepSet } from "./open-questions.mjs";
export { closeKeepSet };
// MSG-1: the messages table, double-written with the room event log.
// Read paths still use the projection. The command path writes rows in the
// same transaction as the event insert. MSG-2 replays events that landed
// before the table, and events from importEvents and initialize, which still
// do not double-write. The integrity cron runs that replay.
import { applyEvent, emptyRoomState } from "../src/events.js";
import { isDeepStrictEqual } from "node:util";

export const MESSAGE_ROW_TYPES = Object.freeze([
  "message.posted",
  "message.edited",
  "message.deleted",
  "poll.voted",
  "message.pinned",
  "message.unpinned",
  "message.redacted"
]);

const MESSAGE_ROW_TYPE_SET = new Set(MESSAGE_ROW_TYPES);

export const MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  message_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  channel_id TEXT,
  thread_root_id TEXT,
  reply_to_id TEXT,
  to_member_id TEXT,
  work_item_id TEXT,
  author_id TEXT NOT NULL,
  body TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  reactions_json TEXT,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  record_json TEXT,
  PRIMARY KEY (room_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_channel_seq ON messages(room_id, channel_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_thread_seq ON messages(room_id, thread_root_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_dm_seq ON messages(room_id, to_member_id, seq);
`;

// One row per room the replay has touched. applied_seq is the last event
// whose message rows are committed. state_json is the room state after that
// event, so the next batch does not replay the prefix. The empty room_id row
// is the parity sweep cursor, not a room. Written by the cron, not on open.
export const MESSAGES_BACKFILL_CURSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_backfill_cursor (
  room_id TEXT PRIMARY KEY,
  applied_seq INTEGER NOT NULL,
  applied_event_id TEXT NOT NULL DEFAULT '',
  state_seq INTEGER NOT NULL DEFAULT 0,
  state_json TEXT,
  parity_at_seq INTEGER,
  sweep_after TEXT NOT NULL DEFAULT ''
);
`;

// One row per room whose backfill is parked: replaying its stored log throws
// (an event the current reducer rejects, or a head sequence the log no
// longer reaches). The row names the exact event so the failure is an
// operator-actionable record instead of an anonymous wedge that re-throws
// every tick and blocks every other room. Written by the backfill, cleared
// when the room's log is replaced or a fresh diagnosis replays cleanly.
export const MESSAGES_BACKFILL_BLOCKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_backfill_blocks (
  room_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  event_id TEXT,
  error TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER NOT NULL DEFAULT 0
);
`;

export const MESSAGES_BACKFILL_BATCH = 200;
const BACKFILL_COMMIT = 25;
const SWEEP_ID = "";
const POSTED = "message.posted";

// Same party rule as eventsAfter for message.posted: a row with to_member_id
// is visible to its author and the addressed member. Everyone else sees only
// rows with no addressee. MSG-3 applies this on the read path.
export function messageVisibleTo(row, viewerId) {
  const to = row?.to_member_id;
  if (typeof to !== "string" || to === "") return true;
  return viewerId === row.author_id || viewerId === to;
}

export function threadRootId(messages, message) {
  if (!message?.replyToId) return null;
  const byId = messages instanceof Map ? messages : new Map((messages ?? []).map(entry => [entry.id, entry]));
  let current = message;
  const seen = new Set();
  while (current?.replyToId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.replyToId);
    if (!parent) return current.replyToId;
    current = parent;
  }
  return current?.id && current.id !== message.id ? current.id : null;
}

// Exported for the resident patrol (server/patrol.mjs), which folds the
// same affected-id set per message event into its shadow records.
export function affectedMessageIds(event) {
  const data = event?.data ?? {};
  if (event?.type === "message.redacted" && typeof data.messageId === "string") {
    return data.messageId.endsWith(":channel") ? [data.messageId] : [data.messageId, `${data.messageId}:channel`];
  }
  if (event?.type === "message.posted") {
    const id = typeof data.messageId === "string" && data.messageId ? data.messageId : event.id;
    const ids = [id];
    if (data.alsoSendToChannel && data.replyToId && !data.toMemberId && !data.workItemId) ids.push(`${id}:channel`);
    return ids;
  }
  return typeof data.messageId === "string" && data.messageId ? [data.messageId] : [];
}

const statements = new WeakMap();

function statementFor(db) {
  let hit = statements.get(db);
  if (hit) return hit;
  hit = db.prepare(`INSERT INTO messages (
      room_id, message_id, seq, channel_id, thread_root_id, reply_to_id, to_member_id, work_item_id,
      author_id, body, created_at, edited_at, deleted_at, reactions_json, pinned, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(room_id, message_id) DO UPDATE SET
      seq = MIN(messages.seq, excluded.seq),
      channel_id = excluded.channel_id,
      thread_root_id = excluded.thread_root_id,
      reply_to_id = excluded.reply_to_id,
      to_member_id = excluded.to_member_id,
      work_item_id = excluded.work_item_id,
      author_id = excluded.author_id,
      body = excluded.body,
      created_at = excluded.created_at,
      edited_at = excluded.edited_at,
      deleted_at = excluded.deleted_at,
      reactions_json = excluded.reactions_json,
      pinned = excluded.pinned,
      record_json = excluded.record_json`);
  statements.set(db, hit);
  return hit;
}

function textOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Same rule as currentBody in server/redact-read.mjs. A deleted message
// stores no text. An edit stores only the current body. PRIV-1 also rewrites
// deleted wording out of the event log; this table never kept it.
function storedBody(message) {
  if (!message || message.deletedAt || message.body == null) return null;
  return typeof message.body === "string" ? message.body : null;
}

// Complete API record, never prior edit wording. The projection remains the
// authority during migration; null legacy records wait for budgeted replay.
function currentRecord(message) {
  const { editHistory: _history, ...record } = message;
  return { ...record, body: storedBody(message) };
}

// Upsert one row per message the event touched. seq stays at the earliest
// event that wrote the row, so an edit does not reorder history. Calling
// this twice for the same event leaves one row.
export function syncMessageRows(db, { roomId, sequence, event, state }) {
  if (!MESSAGE_ROW_TYPE_SET.has(event?.type)) return 0;
  const messages = state?.messages ?? [];
  const affected = affectedMessageIds(event);
  if (affected.length === 0) return 0;
  // Index only what this write touches. The full id map cost ~90ms per
  // write on a 3.8k-message room; the ancestor walk for thread roots needs
  // it only when an affected message is itself a reply.
  const touched = new Map();
  for (const id of affected) {
    const message = messages.find(entry => entry?.id === id);
    if (message) touched.set(id, message);
  }
  const byId = [...touched.values()].some(message => message?.replyToId)
    ? new Map(messages.map(message => [message.id, message]))
    : touched;
  const pinned = new Set((state?.pins ?? []).map(pin => pin.messageId));
  const upsert = statementFor(db);
  let written = 0;
  for (const messageId of affected) {
    const message = byId.get(messageId);
    if (!message || typeof message.authorId !== "string" || typeof message.createdAt !== "string") continue;
    const reactions = message.reactions && typeof message.reactions === "object" && Object.keys(message.reactions).length
      ? JSON.stringify(message.reactions) : null;
    upsert.run(
      roomId, message.id, sequence,
      textOrNull(message.channelId),
      threadRootId(byId, message),
      textOrNull(message.replyToId),
      textOrNull(message.toMemberId),
      textOrNull(message.workItemId),
      message.authorId,
      storedBody(message),
      message.createdAt,
      textOrNull(message.editedAt),
      textOrNull(message.deletedAt),
      reactions,
      pinned.has(message.id) ? 1 : 0,
      JSON.stringify(currentRecord(message))
    );
    written += 1;
  }
  return written;
}

function compactState(state) {
  return { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
}

function readCursor(db, roomId) {
  return db.prepare(`SELECT applied_seq, applied_event_id, state_seq, state_json
    FROM messages_backfill_cursor WHERE room_id=?`).get(roomId) ?? null;
}

function cursorMatches(db, roomId, cursor, sequence) {
  if (!cursor) return true;
  if (!Number.isInteger(cursor.applied_seq) || cursor.applied_seq < 0 || cursor.applied_seq > sequence) return false;
  if (cursor.applied_seq === 0) return cursor.applied_event_id === "";
  const row = db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, cursor.applied_seq);
  return row?.id === cursor.applied_event_id;
}

function saveCursor(db, roomId, appliedSeq, eventId, state) {
  db.prepare(`INSERT INTO messages_backfill_cursor
      (room_id, applied_seq, applied_event_id, state_seq, state_json, parity_at_seq)
    VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(room_id) DO UPDATE SET
      applied_seq=excluded.applied_seq,
      applied_event_id=excluded.applied_event_id,
      state_seq=excluded.state_seq,
      state_json=excluded.state_json,
      parity_at_seq=NULL`).run(roomId, appliedSeq, eventId, appliedSeq, JSON.stringify(state));
}

// Messages at or below projection.messagesArchive.throughSeq were moved out of
// the projection and live only in this table; they are not stale rows.
export function archiveMarker(db, roomId) {
  const row = db.prepare(`SELECT json_extract(projection, '$.messagesArchive.throughSeq') AS throughSeq,
    json_extract(projection, '$.messagesArchive.count') AS count,
    json_extract(projection, '$.messagesArchive.retainedIds') AS retained FROM rooms WHERE id=?`).get(roomId);
  const throughSeq = Number.isInteger(row?.throughSeq) && row.throughSeq > 0 ? row.throughSeq : 0;
  // retainedIds: messages at or below throughSeq that stay in the projection
  // (pinned, work-linked...). They are not archived and compare normally.
  let retained = [];
  if (throughSeq && typeof row.retained === "string") {
    try { const parsed = JSON.parse(row.retained); if (Array.isArray(parsed)) retained = parsed.filter(id => typeof id === "string"); } catch { /* none */ }
  }
  return { throughSeq, count: throughSeq && Number.isInteger(row.count) && row.count > 0 ? row.count : 0, retainedIds: retained, retainedJson: JSON.stringify(retained) };
}

// One archived message row (seq at or below the marker), or null. Archived
// messages are not in the projection, so readers that need one by id use this.
export function archivedMessageRow(db, roomId, messageId, marker = archiveMarker(db, roomId)) {
  const { throughSeq, retainedJson } = marker;
  if (!throughSeq || typeof messageId !== "string") return null;
  return db.prepare("SELECT * FROM messages WHERE room_id=? AND message_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))")
    .get(roomId, messageId, throughSeq, retainedJson) ?? null;
}

// Ids of the room's archived messages (no longer in the projection), for audits
// that compare the projection with a full replay.
export function archivedMessageIds(db, roomId) {
  const { throughSeq, retainedJson } = archiveMarker(db, roomId);
  if (!throughSeq) return new Set();
  return new Set(db.prepare("SELECT message_id FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))")
    .all(roomId, throughSeq, retainedJson).map(row => row.message_id));
}

// Current records of archived messages in one thread (the root itself when it is
// archived, plus archived replies filed under it), oldest first.
export function archivedThreadRecords(db, roomId, rootId) {
  const { throughSeq, retainedJson } = archiveMarker(db, roomId);
  if (!throughSeq || typeof rootId !== "string") return [];
  // A reply's own replies hang off the thread's root, so read the whole thread
  // (the caller builds the requested message's subtree). A top-level message has
  // no thread_root_id: its thread is itself.
  const own = db.prepare("SELECT thread_root_id FROM messages WHERE room_id=? AND message_id=?").get(roomId, rootId);
  const threadId = own?.thread_root_id || rootId;
  const out = [];
  for (const row of db.prepare("SELECT record_json, body FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?)) AND (message_id=? OR thread_root_id=?) ORDER BY seq")
    .all(roomId, throughSeq, retainedJson, threadId, threadId)) {
    try { const record = JSON.parse(row.record_json); out.push(row.body === null ? record : { ...record, body: row.body }); } catch { /* unreadable rows are skipped */ }
  }
  return out;
}

// Current records of archived messages whose body contains the lowercase
// needle, oldest first, for readers that scan every message (search).
export function archivedMatchingRecords(db, roomId, needle) {
  const { throughSeq, retainedJson } = archiveMarker(db, roomId);
  if (!throughSeq) return [];
  const out = [];
  for (const row of db.prepare("SELECT body, record_json FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?)) AND body IS NOT NULL AND instr(lower(body), ?)>0 ORDER BY seq")
    .all(roomId, throughSeq, retainedJson, needle)) {
    try { out.push({ ...JSON.parse(row.record_json), body: row.body }); } catch { /* an unreadable record is not searchable */ }
  }
  return out;
}

function pruneMessages(db, roomId) {
  db.prepare(`DELETE FROM messages WHERE room_id=? AND seq>? AND message_id NOT IN (
    SELECT json_extract(value, '$.id') FROM rooms, json_each(rooms.projection, '$.messages') WHERE rooms.id=?
  )`).run(roomId, archiveMarker(db, roomId).throughSeq, roomId);
}

function resetRoom(store, roomId) {
  store.transaction(() => {
    store.db.prepare("DELETE FROM messages WHERE room_id=?").run(roomId);
    store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
    store.db.prepare("DELETE FROM messages_backfill_blocks WHERE room_id=?").run(roomId);
  });
}

// Replay the room's whole log from empty and report the first event the
// current reducer rejects, or the tail gap when the log ends before the
// room's head sequence. Returns null when the log replays cleanly and
// reaches the head: the fillRoom throw is then not attributable to a stored
// event (a cooperative interruption via yieldBetween, a storage error, a
// corrupt cursor snapshot) and the caller rethrows it unchanged — parking
// is only for failures the data itself guarantees will recur.
function diagnoseBlock(db, roomId) {
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? 0;
  const maxSeq = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE room_id=?").get(roomId).n;
  if (maxSeq < head) {
    return { sequence: maxSeq, eventId: null, error: `messages backfill stopped at ${maxSeq} before room ${roomId} reached sequence ${head}` };
  }
  let state = emptyRoomState();
  for (const row of db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? ORDER BY sequence").all(roomId)) {
    try {
      state = compactState(applyEvent(state, JSON.parse(row.body)));
    } catch (error) {
      return { sequence: row.sequence, eventId: row.id, error: error.message };
    }
  }
  return null;
}

// Record (or refresh) a room's block. Returns true when the block is new or
// changed — the caller surfaces a fresh block once, loudly, instead of
// re-throwing it every tick.
function recordBlock(store, roomId, block) {
  const db = store.db;
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? 0;
  const existing = db.prepare("SELECT sequence, event_id, error FROM messages_backfill_blocks WHERE room_id=?").get(roomId);
  const fresh = !existing || existing.sequence !== block.sequence || existing.event_id !== block.eventId || existing.error !== block.error;
  store.transaction(() => {
    db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, event_id=excluded.event_id,
        error=excluded.error, head_seq=excluded.head_seq, blocked_at=excluded.blocked_at`)
      .run(roomId, block.sequence, block.eventId, block.error, head, Date.now());
  });
  return fresh;
}

function clearBlock(store, roomId) {
  store.transaction(() => {
    store.db.prepare("DELETE FROM messages_backfill_blocks WHERE room_id=?").run(roomId);
  });
}

// Parked rooms whose head moved since the block was recorded earn one fresh
// diagnosis (the log may have been repaired or replaced underneath them);
// a room that now replays cleanly has its block cleared and rejoins the
// sweep. Runs before room selection; a still-blocked room stays parked. A
// re-diagnosis that changes the block marks the room in `freshRooms`, so
// the changed block is surfaced once like a new one.
function refreshStaleBlocks(store, freshRooms = new Map()) {
  for (const row of store.db.prepare("SELECT room_id, head_seq FROM messages_backfill_blocks").all()) {
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(row.room_id)?.sequence;
    if (head === undefined) { clearBlock(store, row.room_id); continue; }
    if (head === row.head_seq) continue;
    const block = diagnoseBlock(store.db, row.room_id);
    if (!block) clearBlock(store, row.room_id);
    else if (recordBlock(store, row.room_id, block)) freshRooms.set(row.room_id, true);
  }
}

function loadState(db, roomId, cursor) {
  if (!cursor || cursor.applied_seq === 0) return { state: emptyRoomState(), seq: 0 };
  const replayFrom = (start, state) => {
    const rows = db.prepare("SELECT body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence")
      .all(roomId, start, cursor.applied_seq);
    let current = state;
    for (const row of rows) current = compactState(applyEvent(current, JSON.parse(row.body)));
    return current;
  };
  if (typeof cursor.state_json === "string" && cursor.state_seq === cursor.applied_seq) {
    try { return { state: JSON.parse(cursor.state_json), seq: cursor.applied_seq }; }
    catch { /* a torn snapshot replays from the log */ }
  }
  if (typeof cursor.state_json === "string" && Number.isInteger(cursor.state_seq) && cursor.state_seq >= 0 && cursor.state_seq < cursor.applied_seq) {
    try { return { state: replayFrom(cursor.state_seq, JSON.parse(cursor.state_json)), seq: cursor.applied_seq }; }
    catch { /* fall through to a full replay */ }
  }
  return { state: replayFrom(0, emptyRoomState()), seq: cursor.applied_seq };
}

function nextRoom(db, exclude = []) {
  const excluded = exclude.length ? ` AND r.id NOT IN (${exclude.map(() => "?").join(",")})` : "";
  return db.prepare(`SELECT r.id AS id, r.sequence AS sequence
    FROM rooms r
    LEFT JOIN messages_backfill_cursor c ON c.room_id = r.id
    WHERE (c.room_id IS NULL
      OR c.applied_seq != r.sequence
      OR (c.applied_seq > 0 AND NOT EXISTS (
        SELECT 1 FROM events e
        WHERE e.room_id = r.id AND e.sequence = c.applied_seq AND e.id = c.applied_event_id
      )))${excluded}
      AND NOT EXISTS (SELECT 1 FROM messages_backfill_blocks b WHERE b.room_id = r.id)
    ORDER BY r.id
    LIMIT 1`).get(...exclude) ?? null;
}

// True when a room's messages table has replayed to the room's current
// sequence — the same predicate the parity sweep uses to pick its rooms.
export function messagesBackfillCaughtUp(db, roomId) {
  return Boolean(db.prepare(`SELECT 1 FROM rooms r
    JOIN messages_backfill_cursor c ON c.room_id = r.id
    WHERE r.id = ? AND c.applied_seq = r.sequence
      AND ((c.applied_seq = 0 AND r.sequence = 0)
        OR c.applied_event_id = (
          SELECT e.id FROM events e WHERE e.room_id = r.id AND e.sequence = c.applied_seq
        ))`).get(roomId));
}

function fillRoom(store, room, budget, expired, yieldBetween) {
  let cursor = readCursor(store.db, room.id);
  if (cursor && !cursorMatches(store.db, room.id, cursor, room.sequence)) {
    resetRoom(store, room.id);
    cursor = null;
  }
  let { state, seq } = loadState(store.db, room.id, cursor);
  let events = 0;
  while (events < budget) {
    if (expired()) return { events, stopped: true, budgetExceeded: true, appliedSeq: seq };
    const rows = store.db.prepare(`SELECT sequence, id, body FROM events
      WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(room.id, seq, Math.min(BACKFILL_COMMIT, budget - events));
    if (!rows.length) {
      const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(room.id).sequence;
      if (seq !== sequence) throw new Error(`messages backfill stopped at ${seq} before room ${room.id} reached sequence ${sequence}`);
      // The last chunk already stored its event id. Saving here would replace
      // that id with a blank one and the next pass would replay the room.
      store.transaction(() => {
        if (seq > 0) pruneMessages(store.db, room.id);
        else saveCursor(store.db, room.id, 0, "", state);
      });
      return { events, stopped: false, budgetExceeded: false, appliedSeq: seq };
    }
    const outcome = store.transaction(() => {
      let next = state;
      let last = null;
      for (const row of rows) {
        const incoming = JSON.parse(row.body);
        next = compactState(applyEvent(next, incoming));
        syncMessageRows(store.db, { roomId: room.id, sequence: row.sequence, event: incoming, state: next });
        last = row;
      }
      const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(room.id).sequence;
      if (last.sequence === sequence) pruneMessages(store.db, room.id);
      saveCursor(store.db, room.id, last.sequence, last.id, next);
      return { state: next, seq: last.sequence };
    });
    state = outcome.state;
    seq = outcome.seq;
    events += rows.length;
    yieldBetween();
  }
  return { events, stopped: false, budgetExceeded: false, appliedSeq: seq };
}

// Errors that indict the store itself (schema/storage), not one room's
// data: isolating them per room would re-report the same systemic failure
// once per room and bury the signal, so they still abort the call.
// Everything else thrown while filling a room is that room's data — a log
// that can no longer replay to the room's sequence, a malformed event body.
// Operational failures are recognized by type first: the store's typed
// storage_unavailable refusal (its transaction has already rolled back,
// so no partial write exists) and SQLite lock contention (SQLITE_BUSY,
// primary result code 5) are the environment failing, never the room's
// data — blaming the room would strand its backfill behind a transient.
function isRoomDataError(error) {
  if (error?.code === "storage_unavailable" || error?.code === "SQLITE_BUSY") return false;
  if (Number.isInteger(error?.errcode) && (error.errcode & 0xff) === 5) return false;
  return !/no such (table|column)|missing schema|sqlite|database disk|disk full|readonly database|database is locked/i
    .test(String(error?.message ?? error));
}

// Replay message events into the messages table, one budgeted batch. A
// commit lands every few events with the cursor, so a throw or a deadline
// keeps the prefix and the next call continues there. Running it again
// after the log is caught up writes nothing. A replaced log (importEvents)
// drops that room's rows and starts again.
//
// Per-room isolation: a room whose stored log no longer replays (an event
// the current reducer rejects, or a head sequence the log does not reach)
// must not wedge the sweep — the room is diagnosed to the exact event,
// parked in messages_backfill_blocks, and named in the result's `failed`
// list (this call's fresh failures) and its `blocked` list (the standing
// parked set) while every other room proceeds. A parked room is skipped
// on later calls until refreshStaleBlocks finds the block stale (the
// underlying event repaired), so a poisoned room neither wedges the batch
// nor re-runs forever; its failure stays recorded in the unified
// integrity surface until the room backfills clean. Parking is deliberate
// — skipping the event silently would corrupt the table the parity check
// certifies against the projection; the block names what an operator must
// repair.
export function runMessagesBackfill(store, { limit = MESSAGES_BACKFILL_BATCH, deadline = Infinity, yieldBetween = () => {} } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not backfill messages");
  if (typeof yieldBetween !== "function") throw new TypeError("yieldBetween must be a function");
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : MESSAGES_BACKFILL_BATCH;
  const failed = [];
  const failedIds = [];
  // The caller's yield hook is control flow, not room data: tag anything it
  // throws so the per-room isolation below always lets it propagate. An
  // interruption mid-batch keeps the committed prefix on the cursor and the
  // next call resumes — isolating it as a "failed room" would silently
  // swallow the caller's stop signal.
  let yieldError = null;
  const guardedYield = () => {
    try { yieldBetween(); }
    catch (error) { yieldError = error; throw error; }
  };
  // The result's `blocked` list is the full parked set (the durable table),
  // with `fresh` marking blocks recorded or changed by this call — so a
  // caller can surface a new block loudly once and keep the standing set
  // visible on every later call without re-diagnosing it. The result's
  // `failed` list carries this call's fresh failures for the unified
  // integrity_failures surface.
  const freshRooms = new Map();
  const allBlocked = () => store.db.prepare(
    "SELECT room_id, sequence, event_id, error FROM messages_backfill_blocks ORDER BY room_id"
  ).all().map(row => ({
    roomId: row.room_id, sequence: row.sequence, eventId: row.event_id, error: row.error,
    fresh: freshRooms.get(row.room_id) ?? false
  }));
  if (Date.now() > deadline) return { done: false, events: 0, rooms: 0, budgetExceeded: true, blocked: allBlocked(), failed };
  refreshStaleBlocks(store, freshRooms);
  let events = 0;
  let rooms = 0;
  let roomId = null;
  let appliedSeq = null;
  const seen = new Set();
  while (events < cap) {
    if (Date.now() > deadline) return { done: false, events, rooms, budgetExceeded: true, roomId, appliedSeq, blocked: allBlocked(), failed };
    const room = nextRoom(store.db, failedIds);
    if (!room) return { done: true, events, rooms, budgetExceeded: false, roomId, appliedSeq, blocked: allBlocked(), failed };
    if (seen.has(room.id)) return { done: false, events, rooms, budgetExceeded: false, roomId, appliedSeq, blocked: allBlocked(), failed };
    seen.add(room.id);
    rooms += 1;
    let wrote;
    try {
      wrote = fillRoom(store, room, cap - events, () => Date.now() > deadline, guardedYield);
    } catch (error) {
      if (yieldError) throw yieldError;
      if (!isRoomDataError(error)) throw error;
      const block = diagnoseBlock(store.db, room.id);
      if (!block) throw error; // not a stored-event failure: propagate as before
      // Park the room durably (later calls skip it until the block goes
      // stale) and report it as this call's fresh failure for the unified
      // integrity_failures surface.
      freshRooms.set(room.id, recordBlock(store, room.id, block));
      failed.push({ roomId: room.id, error });
      failedIds.push(room.id);
      roomId = room.id;
      appliedSeq = readCursor(store.db, room.id)?.applied_seq ?? null;
      continue;
    }
    events += wrote.events;
    roomId = room.id;
    appliedSeq = wrote.appliedSeq;
    if (wrote.stopped) return { done: false, events, rooms, budgetExceeded: true, roomId, appliedSeq, blocked: allBlocked(), failed };
  }
  return { done: nextRoom(store.db) == null, events, rooms, budgetExceeded: false, roomId, appliedSeq, blocked: allBlocked(), failed };
}

function caughtUpSql(after) {
  return {
    sql: `SELECT r.id AS id
      FROM rooms r
      JOIN messages_backfill_cursor c ON c.room_id = r.id
      WHERE c.applied_seq = r.sequence
        AND (
          (c.applied_seq = 0 AND r.sequence = 0)
          OR c.applied_event_id = (
            SELECT e.id FROM events e WHERE e.room_id = r.id AND e.sequence = c.applied_seq
          )
        )
        AND r.id > ?
      ORDER BY r.id
      LIMIT 1`,
    after
  };
}

function nextParityRoom(db, after) {
  const query = caughtUpSql(after);
  return db.prepare(query.sql).get(query.after)?.id
    ?? db.prepare(caughtUpSql("").sql).get("")?.id
    ?? null;
}

function parityNumbers(db, roomId) {
  const projectionCount = db.prepare("SELECT COALESCE(json_array_length(projection, '$.messages'), 0) AS n FROM rooms WHERE id=?").get(roomId).n;
  const table = db.prepare("SELECT COUNT(*) AS n, COALESCE(MAX(seq), 0) AS lastSeq FROM messages WHERE room_id=?").get(roomId);
  const posted = db.prepare(`SELECT COALESCE(MAX(sequence), 0) AS lastSeq FROM events
    WHERE room_id=? AND json_extract(body, '$.type')=?`).get(roomId, POSTED);
  const archived = archiveMarker(db, roomId);
  return {
    projectionCount: projectionCount + archived.count,
    tableCount: table.n,
    projectionLastSeq: posted.lastSeq,
    tableLastSeq: table.lastSeq
  };
}

function rememberSweep(store, roomId) {
  store.transaction(() => {
    store.db.prepare(`INSERT INTO messages_backfill_cursor (room_id, applied_seq, applied_event_id, sweep_after)
      VALUES (?, 0, '', ?)
      ON CONFLICT(room_id) DO UPDATE SET sweep_after=excluded.sweep_after`).run(SWEEP_ID, roomId);
  });
}

// One caught-up room per call. Compare complete current records, query-index
// fields and original posting sequences as well as aggregate count/order.
// A room still being replayed is left for a later call. Certification is
// recorded only after all comparisons pass; a mismatch clears it and throws.
export function checkMessagesParity(store) {
  if (store?.readOnly) throw new Error("Read-only stores do not check message parity");
  // Hold the writer lock across the comparison and certification. Commit a
  // detected mismatch's invalidation before reporting the failure to callers.
  const result = store.transaction(() => {
    try { return { value: certifyMessagesParity(store) }; }
    catch (error) {
      if (!error.message.startsWith("messages parity failed for ")) throw error;
      return { error };
    }
  });
  if (result.error) throw result.error;
  return result.value;
}

// The deferred integrity batch's parity step. checkMessagesParity keeps its
// throwing contract for direct callers; here, one room's "messages parity
// failed" verdict is isolated instead: the room is reported through
// `report`, the sweep advances past it, and the rooms queued behind it are
// still checked in the same visit (healthy rooms are certified until one
// passes or every caught-up room has been attempted). Anything that is not
// a per-room parity verdict — schema, storage — still throws. A failed
// room keeps its cleared certification, so the verdict is unchanged; only
// the blast radius shrinks.
export function runMessagesParityCheck(store, { report = () => {} } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not check message parity");
  const failures = [];
  const attempted = new Set();
  for (;;) {
    const sweepAfter = store.db.prepare("SELECT sweep_after FROM messages_backfill_cursor WHERE room_id=?").get(SWEEP_ID)?.sweep_after ?? "";
    const roomId = nextParityRoom(store.db, sweepAfter);
    if (!roomId || attempted.has(roomId)) break;
    attempted.add(roomId);
    try {
      const certified = checkMessagesParity(store);
      report({ roomId, error: null });
      return { ...certified, failures };
    } catch (error) {
      if (!String(error?.message ?? error).startsWith("messages parity failed for ")) throw error;
      failures.push({ roomId, error });
      report({ roomId, error });
      rememberSweep(store, roomId);
    }
  }
  return { ok: failures.length === 0, checked: 0, roomId: null, failures };
}

function certifyMessagesParity(store) {
  const sweepAfter = store.db.prepare("SELECT sweep_after FROM messages_backfill_cursor WHERE room_id=?").get(SWEEP_ID)?.sweep_after ?? "";
  const roomId = nextParityRoom(store.db, sweepAfter);
  if (!roomId) return { ok: true, checked: 0 };
  // A failed recheck must not leave an earlier certification usable.
  store.transaction(() => store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?").run(roomId));
  const numbers = parityNumbers(store.db, roomId);
  if (numbers.projectionCount !== numbers.tableCount || numbers.projectionLastSeq !== numbers.tableLastSeq) {
    throw new Error(`messages parity failed for ${roomId}: projection count ${numbers.projectionCount}, table count ${numbers.tableCount}, projection last seq ${numbers.projectionLastSeq}, table last seq ${numbers.tableLastSeq}`);
  }
  const hydration = hydrateProjection(store.db, roomId, JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection));
  if (hydration.missing.length) throw new Error(`messages parity failed for ${roomId}: stored message body missing`);
  const state = hydration.state;
  const messages = new Map((state.messages ?? []).map(message => [message.id, message]));
  const pinned = new Set((state.pins ?? []).map(pin => pin.messageId));
  const sequences = new Map();
  for (const row of store.db.prepare("SELECT sequence,body FROM events WHERE room_id=? AND json_extract(body,'$.type')=? ORDER BY sequence").all(roomId, POSTED)) {
    for (const id of affectedMessageIds(JSON.parse(row.body))) if (!sequences.has(id)) sequences.set(id, row.sequence);
  }
  const archive = archiveMarker(store.db, roomId);
  const archivedRows = archive.throughSeq
    ? store.db.prepare("SELECT message_id, reply_to_id FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))").all(roomId, archive.throughSeq, archive.retainedJson) : [];
  if (archivedRows.length !== archive.count) throw new Error(`messages parity failed for ${roomId}: archived rows ${archivedRows.length}, marker count ${archive.count}`);
  // Archived parents stay reachable for the thread-root comparison.
  const threadMessages = new Map([...archivedRows.map(row => [row.message_id, { id: row.message_id, replyToId: row.reply_to_id }]), ...messages]);
  for (const row of store.db.prepare("SELECT * FROM messages WHERE room_id=? AND (seq>? OR message_id IN (SELECT value FROM json_each(?)))").all(roomId, archive.throughSeq, archive.retainedJson)) {
    const message = messages.get(row.message_id);
    let record, reactions;
    try { record = JSON.parse(row.record_json); reactions = row.reactions_json === null ? {} : JSON.parse(row.reactions_json); }
    catch { /* invalid records fail parity */ }
    if (!message || !isDeepStrictEqual(record, currentRecord(message))
      || row.seq !== sequences.get(message.id)
      || row.author_id !== message.authorId || row.body !== storedBody(message)
      || row.channel_id !== textOrNull(message.channelId)
      || row.thread_root_id !== threadRootId(threadMessages, message)
      || row.reply_to_id !== textOrNull(message.replyToId)
      || row.to_member_id !== textOrNull(message.toMemberId)
      || row.work_item_id !== textOrNull(message.workItemId)
      || row.created_at !== message.createdAt || row.edited_at !== textOrNull(message.editedAt)
      || row.deleted_at !== textOrNull(message.deletedAt)
      || row.pinned !== (pinned.has(message.id) ? 1 : 0)
      || !isDeepStrictEqual(reactions, message.reactions ?? {})) {
      throw new Error(`messages parity failed for ${roomId}: current record ${row.message_id} differs`);
    }
  }
  store.transaction(() => store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=applied_seq WHERE room_id=?").run(roomId));
  rememberSweep(store, roomId);
  return { ok: true, checked: 1, roomId, ...numbers };
}

// Messages that must stay in the projection: pinned, the source or evidence of
// work, tied to a work item, or a reply request. Readers of those assume the
// message is in state.messages.
function retainedByState(state) {
  const keep = new Set();
  for (const pin of state.pins ?? []) if (typeof pin?.messageId === "string") keep.add(pin.messageId);
  for (const item of Object.values(state.workItems ?? {})) {
    if (typeof item?.sourceMessageId === "string") keep.add(item.sourceMessageId);
    if (typeof item?.receipt?.nativeText?.messageId === "string") keep.add(item.receipt.nativeText.messageId);
    if (typeof item?.receipt?.evidenceMessageId === "string") keep.add(item.receipt.evidenceMessageId);
  }
  for (const id of Object.keys(state.replyRequests ?? {})) keep.add(id);
  for (const message of state.messages ?? []) if (typeof message?.workItemId === "string" && message.workItemId) keep.add(message.id);
  return keep;
}

// Move old messages out of rooms.projection into the messages table only. Keeps
// the newest `keepNewest` messages and everything retainedByState. Needs a
// certified messages table (parity at the room head). dryRun reports what
// would move and changes nothing. Returns { ok, ... } and never throws for
// "not ready" conditions.
export function archiveRoomMessages(store, roomId, { keepNewest = 2000, dryRun = true } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not archive messages");
  if (!Number.isInteger(keepNewest) || keepNewest < 1) throw new Error("keepNewest must be a positive integer");
  return store.transaction(() => {
    const db = store.db;
    const head = db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
    if (!head) return { ok: false, reason: "room_not_found" };
    const cursor = db.prepare("SELECT applied_seq, parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    if (!cursor || cursor.applied_seq !== head.sequence || cursor.parity_at_seq !== head.sequence) return { ok: false, reason: "messages_table_not_certified" };
    const state = store.room(roomId).state;
    const seqs = new Map(db.prepare("SELECT message_id, seq FROM messages WHERE room_id=?").all(roomId).map(row => [row.message_id, row.seq]));
    const inProjection = state.messages ?? [];
    if (inProjection.some(message => !seqs.has(message.id))) return { ok: false, reason: "message_missing_from_table" };
    const ordered = [...inProjection].sort((a, b) => seqs.get(a.id) - seqs.get(b.id));
    if (ordered.length <= keepNewest) return { ok: true, dryRun, archived: 0, retained: 0, freedBytes: 0, throughSeq: archiveMarker(db, roomId).throughSeq };
    const tail = ordered.slice(ordered.length - keepNewest);
    const cutoff = seqs.get(tail[0].id);
    const keep = retainedByState(state);
    // Keep whole active threads and open questions: see closeKeepSet.
    for (const message of tail) keep.add(message.id);
    closeKeepSet(ordered, keep);
    const marker = archiveMarker(db, roomId);
    const moving = ordered.filter(message => seqs.get(message.id) < cutoff && !keep.has(message.id));
    if (!moving.length) return { ok: true, dryRun, archived: 0, retained: 0, freedBytes: 0, throughSeq: marker.throughSeq };
    // throughSeq only ever grows: the archived prefix is never shortened.
    const throughSeq = Math.max(marker.throughSeq, seqs.get(moving[moving.length - 1].id));
    const movingIds = new Set(moving.map(message => message.id));
    const retainedIds = ordered.filter(message => seqs.get(message.id) <= throughSeq && !movingIds.has(message.id)).map(message => message.id);
    // Every message at or below the cut that is not moving is explicitly retained.
    const freedBytes = moving.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
    const result = { ok: true, dryRun, archived: moving.length, retained: retainedIds.length, freedBytes, throughSeq };
    // Spot-check before anything moves (dry run too): every moving message has a
    // table row equal to its projection record, and a sample is tied back to its
    // posting event in the log.
    const rowFor = db.prepare("SELECT seq, body, record_json FROM messages WHERE room_id=? AND message_id=?");
    const eventAt = db.prepare("SELECT body FROM events WHERE room_id=? AND sequence=?");
    const step = Math.max(1, Math.floor(moving.length / 25));
    for (const [index, message] of moving.entries()) {
      const row = rowFor.get(roomId, message.id);
      let record = null;
      try { record = JSON.parse(row?.record_json); } catch { /* fails the check below */ }
      let ok = Boolean(row) && isDeepStrictEqual(record, currentRecord(message)) && row.body === storedBody(message);
      if (ok && index % step === 0) {
        let posted = null;
        try { posted = JSON.parse(eventAt.get(roomId, row.seq)?.body); } catch { /* fails below */ }
        // An also-send-to-channel copy is posted by its thread reply's event as `<id>:channel`.
        const postedId = posted?.data?.messageId || posted?.id;
        ok = posted?.type === POSTED && (postedId === message.id || (Boolean(posted.data?.alsoSendToChannel) && `${postedId}:channel` === message.id));
      }
      if (!ok) return { ok: false, reason: "archive_spot_check_failed", messageId: message.id };
    }
    if (dryRun) return result;
    const next = { ...state, messages: inProjection.filter(message => !movingIds.has(message.id)) };
    // The marker must never claim a message that is still in the projection.
    const priorArchived = archivedMessageIds(db, roomId);
    if (next.messages.some(message => movingIds.has(message.id) || priorArchived.has(message.id))) return { ok: false, reason: "marker_overlaps_projection" };
    next.messagesArchive = { throughSeq, count: marker.count + moving.length, retainedIds };
    db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(db, roomId, next, { enabled: store.bodiesAtRest }), roomId);
    return result;
  });
}

// Apply a room's archive marker to a fully replayed state, so a replay can be
// compared with the compacted stored projection. Messages at or below the
// marker and not retained leave the state; the marker is rebuilt from the table.
export function compactReplayLikeArchive(db, roomId, state) {
  const marker = archiveMarker(db, roomId);
  if (!marker.throughSeq) return state;
  const archived = new Set(db.prepare("SELECT message_id FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))")
    .all(roomId, marker.throughSeq, marker.retainedJson).map(row => row.message_id));
  state.messages = (state.messages ?? []).filter(message => !archived.has(message.id));
  state.messagesArchive = { throughSeq: marker.throughSeq, count: archived.size, retainedIds: marker.retainedIds };
  return state;
}

// Rollback of the archive: put every archived message back into the stored
// projection and drop the marker, so code that does not know the marker (a
// flag-off deploy, the old recovery audit) sees the whole room again. The
// archived records come from replaying the event log; nothing else in the
// projection changes. Returns how many messages were restored.
export function restoreArchivedMessages(store, roomId) {
  if (store?.readOnly) throw new Error("Read-only stores do not restore archived messages");
  return store.transaction(() => {
    const db = store.db;
    const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
    if (!head) return 0;
    const archived = archivedMessageIds(db, roomId);
    const state = store.room(roomId).state;
    if (!state.messagesArchive && !archived.size) return 0;
    const present = new Set((state.messages ?? []).map(message => message.id));
    const replayed = new Map((store._replayRoom(roomId, head.sequence).state.messages ?? []).map(message => [message.id, message]));
    const missing = [...archived].filter(id => !present.has(id));
    if (missing.some(id => !replayed.has(id))) throw new Error("Archived message could not be restored from the event log");
    const seqs = new Map(db.prepare("SELECT message_id, seq FROM messages WHERE room_id=?").all(roomId).map(row => [row.message_id, row.seq]));
    const messages = [...(state.messages ?? []), ...missing.map(id => replayed.get(id))]
      .sort((a, b) => (seqs.get(a.id) ?? Infinity) - (seqs.get(b.id) ?? Infinity));
    const next = { ...state, messages };
    delete next.messagesArchive;
    db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(db, roomId, next, { enabled: false }), roomId);
    store._projectionCache?.clear?.();
    return missing.length;
  });
}

// Bring one archived message back into the projection so the normal delete and
// redaction path can act on it. The id joins the marker's retainedIds (it is at
// or below throughSeq but no longer archived) and the archived count drops by
// one, so the marker, the table and a marker-aware replay all agree. Returns
// true when the message was restored. Runs inside the caller's command
// transaction, so a delete the reducer then refuses rolls this back too.
export function restoreArchivedMessage(store, roomId, messageId) {
  const db = store.db;
  const marker = archiveMarker(db, roomId);
  if (!archivedMessageRow(db, roomId, messageId, marker)) return false;
  const state = store.room(roomId).state;
  if ((state.messages ?? []).some(message => message.id === messageId)) return false;
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId);
  const original = (store._replayRoom(roomId, head.sequence).state.messages ?? []).find(message => message.id === messageId);
  if (!original) throw new Error("Archived message could not be restored from the event log");
  const seqs = new Map(db.prepare("SELECT message_id, seq FROM messages WHERE room_id=?").all(roomId).map(row => [row.message_id, row.seq]));
  const messages = [...(state.messages ?? []), original].sort((a, b) => (seqs.get(a.id) ?? Infinity) - (seqs.get(b.id) ?? Infinity));
  const next = { ...state, messages, messagesArchive: { throughSeq: marker.throughSeq, count: Math.max(0, marker.count - 1), retainedIds: [...marker.retainedIds, messageId] } };
  db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(db, roomId, next, { enabled: store.bodiesAtRest }), roomId);
  store._projectionCache?.clear?.();
  return true;
}
