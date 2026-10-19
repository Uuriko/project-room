import { writeMessageReplaySnapshot, discardMessageReplaySnapshot, decodeMessageReplaySnapshot } from './message-replay-snapshot.mjs';
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
  reducer_extras_json TEXT,
  PRIMARY KEY (room_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_channel_seq ON messages(room_id, channel_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_thread_seq ON messages(room_id, thread_root_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_dm_seq ON messages(room_id, to_member_id, seq);
`;

// One row per room the replay has touched. applied_seq is the last event
// whose message rows are certified. state_seq/replay_event_id anchor the
// separate, possibly chunked snapshot; replay may be ahead of certification.
// The empty room_id row
// is the parity sweep cursor, not a room. Written by the cron, not on open.
export const MESSAGES_BACKFILL_CURSOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_backfill_cursor (
  room_id TEXT PRIMARY KEY,
  applied_seq INTEGER NOT NULL,
  applied_event_id TEXT NOT NULL DEFAULT '',
  state_seq INTEGER NOT NULL DEFAULT 0,
  replay_event_id TEXT NOT NULL DEFAULT '',
  parity_at_seq INTEGER,
  sweep_after TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS messages_backfill_state (
  room_id TEXT NOT NULL,
  part INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (room_id, part)
);
`;

// One row per room whose backfill is parked: replaying its stored log throws
// (an event the current reducer rejects, or a head sequence the log no
// longer reaches). The row names the exact event so the failure is an
// operator-actionable record instead of an anonymous wedge that re-throws
// every tick and blocks every other room. Written by the backfill, cleared
// when the room's log is replaced or a fresh diagnosis replays cleanly.
// last_diagnosed_at stamps the most recent diagnosis attempt (the park
// itself, a head-moved refresh, or a periodic re-diagnosis) and drives the
// periodic re-diagnosis cadence in refreshStaleBlocks.
export const MESSAGES_BACKFILL_BLOCKS_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages_backfill_blocks (
  room_id TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL,
  event_id TEXT,
  error TEXT NOT NULL,
  head_seq INTEGER NOT NULL DEFAULT 0,
  blocked_at INTEGER NOT NULL DEFAULT 0,
  last_diagnosed_at INTEGER NOT NULL DEFAULT 0
);
`;

// How long a parked room whose head never moves waits between re-diagnoses.
// The repair this serves is invisible to the head: an operator fixing the
// named event in place, or a deploy fixing the reducer that rejects it —
// neither appends an event, so head movement alone would leave a quiet
// room parked forever. Six hours bounds the replay cost of a still-poisoned
// room to a handful of full-log replays a day while a repaired room clears
// the same day it was fixed.
export const MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Periodic re-diagnoses per backfill call: a fleet of parked rooms becoming
// due at once must not turn one tick into an unbounded replay session.
const BLOCK_REDIAGNOSIS_PER_CALL = 1;

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

function statementFor(db, exactSequence = false) {
  let cache = statements.get(db);
  if (!cache) { cache = new Map(); statements.set(db,cache); }
  let hit = cache.get(exactSequence);
  if (hit) return hit;
  hit = db.prepare(`INSERT INTO messages (
      room_id, message_id, seq, channel_id, thread_root_id, reply_to_id, to_member_id, work_item_id,
      author_id, body, created_at, edited_at, deleted_at, reactions_json, pinned, record_json, reducer_extras_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(room_id, message_id) DO UPDATE SET
      seq = ${exactSequence ? 'excluded.seq' : 'MIN(messages.seq, excluded.seq)'},
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
      record_json = excluded.record_json,
      reducer_extras_json = excluded.reducer_extras_json`);
  cache.set(exactSequence, hit);
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
function reducerExtras(message) {
  return message.editHistory === undefined ? {} : { editHistory: message.editHistory };
}

function currentRecord(message) {
  const { editHistory: _history, ...record } = message;
  return { ...record, body: storedBody(message) };
}

// Upsert one row per message the event touched. seq stays at the earliest
// event that wrote the row, so an edit does not reorder history. Calling
// this twice for the same event leaves one row.
export function syncMessageRows(db, { roomId, sequence, event, state }) {
  if (!MESSAGE_ROW_TYPE_SET.has(event?.type)) return 0;
  const affected = affectedMessageIds(event);
  return writeMessageRows(db, {roomId,state,sequenceById:new Map(affected.map(id=>[id,sequence]))});
}

function writeMessageRows(db, {roomId,state,sequenceById,messageIndex=null,exactSequence=false}) {
  const messages = state?.messages ?? [];
  const affected = [...sequenceById.keys()];
  if (!affected.length) return 0;
  // Index only what this write touches. The full id map cost ~90ms per
  // write on a 3.8k-message room; the ancestor walk for thread roots needs
  // it only when an affected message is itself a reply.
  const touched = new Map();
  for (const id of affected) {
    const message = messageIndex ? messageIndex.get(id) : messages.find(entry => entry?.id === id);
    if (message) touched.set(id, message);
  }
  const byId = messageIndex ?? ([...touched.values()].some(message => message?.replyToId)
    ? new Map(messages.map(message => [message.id, message])) : touched);
  const pinned = new Set((state?.pins ?? []).map(pin => pin.messageId));
  const upsert = statementFor(db,exactSequence);
  let written = 0;
  for (const messageId of affected) {
    const message = byId.get(messageId);
    if (!message || typeof message.authorId !== "string" || typeof message.createdAt !== "string") continue;
    const reactions = message.reactions && typeof message.reactions === "object" && Object.keys(message.reactions).length
      ? JSON.stringify(message.reactions) : null;
    upsert.run(
      roomId, message.id, sequenceById.get(message.id),
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
      JSON.stringify(currentRecord(message)),
      JSON.stringify(reducerExtras(message))
    );
    written += 1;
  }
  return written;
}

// Opt-in migration carrier: only transitions whose message writes are fully
// covered by syncMessageRows can carry an existing parity certificate forward.
// Redaction, archive and import still require the budgeted parity sweep.
const CERTIFIED_MESSAGE_TRANSITIONS = new Set([
  "message.posted", "message.edited", "poll.voted", "message.pinned", "message.unpinned"
]);
export function captureMessageCertification(db, { roomId, sequence, event }) {
  if (!db.isTransaction || !CERTIFIED_MESSAGE_TRANSITIONS.has(event?.type)) return null;
  const row = db.prepare(`SELECT c.applied_event_id AS anchor FROM messages_backfill_cursor c
    JOIN rooms r ON r.id=c.room_id JOIN events e ON e.room_id=r.id AND e.sequence=r.sequence
    WHERE r.id=? AND r.sequence=? AND c.applied_seq=r.sequence
      AND c.parity_at_seq=r.sequence AND c.applied_event_id=e.id
      AND NOT EXISTS (SELECT 1 FROM messages_backfill_blocks b WHERE b.room_id=r.id)`)
    .get(roomId, sequence);
  if (!row) return null;
  const positions = new Map(affectedMessageIds(event).map(id => [id,
    db.prepare("SELECT seq FROM messages WHERE room_id=? AND message_id=?").get(roomId, id)?.seq ?? null]));
  return { roomId, sequence, anchor: row.anchor, positions };
}

export function advanceMessageCertification(db, certificate, { sequence, event, state }) {
  if (!certificate || !db.isTransaction || !CERTIFIED_MESSAGE_TRANSITIONS.has(event?.type)
    || sequence !== certificate.sequence + 1) return false;
  const { roomId } = certificate;
  const ids = affectedMessageIds(event);
  if (!ids.length) return false;
  const messages = state.messages ?? [];
  const pinned = new Set((state.pins ?? []).map(pin => pin.messageId));
  for (const id of ids) {
    const message = messages.find(entry => entry?.id === id);
    const row = db.prepare("SELECT * FROM messages WHERE room_id=? AND message_id=?").get(roomId, id);
    if (!message || !row) return false;
    let record, reactions, extras;
    try { record = JSON.parse(row.record_json); reactions = row.reactions_json === null ? {} : JSON.parse(row.reactions_json); extras = row.reducer_extras_json === null ? null : JSON.parse(row.reducer_extras_json); }
    catch { return false; }
    const expectedSequence = event.type === "message.posted" ? sequence : certificate.positions.get(id);
    if (expectedSequence == null || row.seq !== expectedSequence
      || row.thread_root_id !== threadRootId(messages, message)
      || !isDeepStrictEqual(record, currentRecord(message)) || !isDeepStrictEqual(extras, reducerExtras(message)) || row.author_id !== message.authorId
      || row.body !== storedBody(message) || row.channel_id !== textOrNull(message.channelId)
      || row.reply_to_id !== textOrNull(message.replyToId) || row.to_member_id !== textOrNull(message.toMemberId)
      || row.work_item_id !== textOrNull(message.workItemId) || row.created_at !== message.createdAt
      || row.edited_at !== textOrNull(message.editedAt) || row.deleted_at !== textOrNull(message.deletedAt)
      || row.pinned !== (pinned.has(id) ? 1 : 0) || !isDeepStrictEqual(reactions, message.reactions ?? {})) return false;
  }
  // Keep state_json/state_seq at the older replay checkpoint: loadState already
  // replays its delta when the next unsupported event needs backfill.
  const result = db.prepare(`UPDATE messages_backfill_cursor SET applied_seq=?, applied_event_id=?, parity_at_seq=?
    WHERE room_id=? AND applied_seq=? AND parity_at_seq=? AND applied_event_id=?
      AND EXISTS (SELECT 1 FROM rooms r JOIN events e ON e.room_id=r.id AND e.sequence=r.sequence
        WHERE r.id=? AND r.sequence=? AND e.id=?)`)
    .run(sequence, event.id, sequence, roomId, certificate.sequence, certificate.sequence, certificate.anchor,
      roomId, sequence, event.id);
  return Number(result.changes) === 1;
}

// Re-derive a room's existing messages rows from a rebuilt projection
// state (account deletion's rebuildRoom, after redaction rewrote the log).
// Per-row redaction nulls a row's record for already-archived rooms; the
// rebuild makes the projection the redacted truth, and without this resync
// the rows keep the NULL records parity then mismatches forever — the room
// is caught up, so the backfill never re-selects it. Every field written
// here derives from the same rebuilt message parity certifies against, and
// each row keeps the sequence it already carries (parity compares it
// against the original posting event). Messages with no row yet are the
// backfill's to create; messages archived out of the projection are not in
// the state and keep their rows untouched (parity compares those by count
// only). Returns the number of rows rewritten.
export function resyncRoomMessageRows(db, roomId, state) {
  const messages = state?.messages ?? [];
  if (!messages.length) return 0;
  const rowSeq = new Map(db.prepare("SELECT message_id, seq FROM messages WHERE room_id=?")
    .all(roomId).map(row => [row.message_id, row.seq]));
  if (!rowSeq.size) return 0;
  const archive = archiveMarker(db, roomId);
  const archivedRows = archive.throughSeq
    ? db.prepare("SELECT message_id, reply_to_id FROM messages WHERE room_id=? AND seq<=? AND message_id NOT IN (SELECT value FROM json_each(?))").all(roomId, archive.throughSeq, archive.retainedJson) : [];
  // The same thread map certifyMessagesParity certifies against: archived
  // parents stay reachable as stubs for the thread-root comparison.
  const byId = new Map([...archivedRows.map(row => [row.message_id, { id: row.message_id, replyToId: row.reply_to_id }]),
    ...messages.map(message => [message.id, message])]);
  const pinned = new Set((state?.pins ?? []).map(pin => pin.messageId));
  const upsert = statementFor(db);
  let written = 0;
  for (const message of messages) {
    const seq = rowSeq.get(message?.id);
    if (seq === undefined) continue;
    if (typeof message.authorId !== "string" || typeof message.createdAt !== "string") continue;
    const reactions = message.reactions && typeof message.reactions === "object" && Object.keys(message.reactions).length
      ? JSON.stringify(message.reactions) : null;
    upsert.run(
      roomId, message.id, seq,
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
      JSON.stringify(currentRecord(message)),
      JSON.stringify(reducerExtras(message))
    );
    written += 1;
  }
  return written;
}

function compactState(state) {
  return { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
}

function readCursor(db, roomId, includeSnapshot = false) {
  if (!includeSnapshot) return db.prepare(`SELECT applied_seq, applied_event_id, state_seq, replay_event_id
    FROM messages_backfill_cursor WHERE room_id=?`).get(roomId) ?? null;
  return db.prepare(`SELECT c.applied_seq, c.applied_event_id, c.state_seq, c.replay_event_id, s.state_json
    FROM messages_backfill_cursor c LEFT JOIN message_replay_snapshots s ON s.room_id=c.room_id WHERE c.room_id=?`).get(roomId) ?? null;
}

function cursorMatches(db, roomId, cursor, sequence) {
  if (!cursor) return true;
  if (!Number.isInteger(cursor.applied_seq) || cursor.applied_seq < 0 || cursor.applied_seq > sequence) return false;
  if (cursor.applied_seq === 0 && cursor.applied_event_id !== "") return false;
  if (cursor.applied_seq > 0 && db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId,cursor.applied_seq)?.id !== cursor.applied_event_id) return false;
  if (cursor.state_seq > cursor.applied_seq) {
    if (cursor.state_seq > sequence || db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId,cursor.state_seq)?.id !== cursor.replay_event_id) return false;
  }
  return true;
}

function saveCursor(db, roomId, replaySeq, eventId, state) {
  writeMessageReplaySnapshot(db,roomId,JSON.stringify(state));
  db.prepare(`INSERT INTO messages_backfill_cursor
      (room_id, applied_seq, applied_event_id, state_seq, replay_event_id, parity_at_seq)
    VALUES (?, 0, '', ?, ?, NULL)
    ON CONFLICT(room_id) DO UPDATE SET
      state_seq=excluded.state_seq,
      replay_event_id=excluded.replay_event_id,
      parity_at_seq=NULL`).run(roomId,replaySeq,eventId);
}

// Messages at or below projection.messagesArchive.throughSeq were moved out of
// the projection and live only in this table; they are not stale rows.
export function archiveMarker(db, roomId) {
  // WRITE-PATH-WINS win 5: this runs on message paths (a post whose id is
  // not in the projection probes for an archived row), and json_extract
  // must tokenize the whole multi-megabyte projection to prove the marker
  // absent — the common case. A raw substring probe answers "absent" at
  // memchr speed; it can only false-positive (a body quoting the key),
  // never false-negative, because our serializer writes the key verbatim.
  const probe = db.prepare("SELECT instr(projection, '\"messagesArchive\"') AS found FROM rooms WHERE id=?").get(roomId);
  if (!probe?.found) return { throughSeq: 0, count: 0, retainedIds: [], retainedJson: "[]" };
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
    discardMessageReplaySnapshot(store.db,roomId);
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

// r52: diagnose from the backfill's own resume point instead of sequence 0.
// diagnoseBlock replays the whole room log; for muse-room (about 14k events)
// that was 35.8 s of CPU in one integrity tick on a shared 4-CPU box, over
// the production Durable Object's 30 s cpu_ms, and the head-moved
// re-diagnosis runs it with no deadline. The cursor already holds the state
// the backfill resumes from (state_json at applied_seq, anchored to the
// event id it names), so the question "does this room move past its block
// now" only needs the events after it: through the old blocked sequence on a
// re-diagnosis, or to the first failure on a fresh park. Returns undefined
// when there is no usable snapshot (no cursor, torn or stale snapshot, a
// rewritten anchor event), and the caller falls back to the full replay.
function diagnoseFromCursor(db, roomId, upTo) {
  const cursor = readCursor(db, roomId, true);
  if (!cursor || typeof cursor.state_json !== "string" || !Number.isInteger(cursor.state_seq) || cursor.state_seq <= 0 || cursor.state_seq < cursor.applied_seq) return undefined;
  if (!(Number.isInteger(upTo) && upTo > cursor.state_seq) || !cursorMatches(db,roomId,cursor,upTo)) return undefined;
  let state;
  try { state = decodeMessageReplaySnapshot(db, roomId, cursor.state_json); } catch { return undefined; }
  const rows = db.prepare("SELECT sequence, id, body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence")
    .all(roomId, cursor.state_seq, upTo);
  for (const row of rows) {
    try {
      state = compactState(applyEvent(state, JSON.parse(row.body)));
    } catch (error) {
      return { sequence: row.sequence, eventId: row.id, error: error.message };
    }
  }
  return null;
}

function rediagnoseBlock(db, roomId, blockedSeq) {
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? 0;
  const maxSeq = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS n FROM events WHERE room_id=?").get(roomId).n;
  if (maxSeq >= head && Number.isInteger(blockedSeq) && blockedSeq > 0) {
    const resumed = diagnoseFromCursor(db, roomId, Math.min(blockedSeq, head));
    if (resumed !== undefined) return resumed;
  }
  return diagnoseBlock(db, roomId);
}

// Record (or refresh) a room's block. Returns true when the block is new or
// changed — the caller surfaces a fresh block once, loudly, instead of
// re-throwing it every tick.
function recordBlock(store, roomId, block) {
  const db = store.db;
  const head = db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId)?.sequence ?? 0;
  const existing = db.prepare("SELECT sequence, event_id, error FROM messages_backfill_blocks WHERE room_id=?").get(roomId);
  const fresh = !existing || existing.sequence !== block.sequence || existing.event_id !== block.eventId || existing.error !== block.error;
  const now = Date.now();
  store.transaction(() => {
    db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET sequence=excluded.sequence, event_id=excluded.event_id,
        error=excluded.error, head_seq=excluded.head_seq, blocked_at=excluded.blocked_at,
        last_diagnosed_at=excluded.last_diagnosed_at`)
      .run(roomId, block.sequence, block.eventId, block.error, head, now, now);
  });
  return fresh;
}

// Stamp a re-diagnosis attempt that changed nothing: the block's content
// (and blocked_at — when the standing accusation was recorded) stays as it
// was; only the cadence clock moves, so the room is not re-diagnosed again
// until the interval elapses.
function noteDiagnosisAttempt(store, roomId, at) {
  store.transaction(() => {
    store.db.prepare("UPDATE messages_backfill_blocks SET last_diagnosed_at=? WHERE room_id=?").run(at, roomId);
  });
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
//
// A parked room whose head never moves is not abandoned either: the repair
// it waits for (an operator fixing the named event in place, a deploy
// fixing the reducer) appends no event, so on a slow cadence — at most
// BLOCK_REDIAGNOSIS_PER_CALL rooms per call, each at most once per
// MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS — the room earns a periodic
// re-diagnosis through the same diagnoseBlock path. A clean replay clears
// the park and the room rejoins this call's sweep; a still-failing log
// keeps its park, with only the attempt stamp moving when the diagnosis is
// unchanged. Periodic attempts honor the caller's deadline; head-moved
// diagnoses keep their existing unconditional pass.
function refreshStaleBlocks(store, freshRooms = new Map(), { deadline = Infinity } = {}) {
  const rows = store.db.prepare(
    "SELECT room_id, sequence, event_id, error, head_seq, last_diagnosed_at FROM messages_backfill_blocks ORDER BY room_id"
  ).all();
  let periodicLeft = BLOCK_REDIAGNOSIS_PER_CALL;
  for (const row of rows) {
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(row.room_id)?.sequence;
    if (head === undefined) { clearBlock(store, row.room_id); continue; }
    if (head !== row.head_seq) {
      const block = rediagnoseBlock(store.db, row.room_id, row.sequence);
      if (!block) clearBlock(store, row.room_id);
      else if (recordBlock(store, row.room_id, block)) freshRooms.set(row.room_id, true);
      continue;
    }
    if (periodicLeft <= 0) continue;
    // A row with no stamp predates the cadence (written before the column
    // existed, or inserted directly): start its clock on first sight
    // rather than diagnosing on the spot, so the cadence means the same
    // thing for every parked room.
    if (!row.last_diagnosed_at) { noteDiagnosisAttempt(store, row.room_id, Date.now()); continue; }
    if (Date.now() - row.last_diagnosed_at < MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS) continue;
    if (Date.now() > deadline) break;
    periodicLeft -= 1;
    const block = rediagnoseBlock(store.db, row.room_id, row.sequence);
    if (!block) { clearBlock(store, row.room_id); continue; }
    const changed = row.sequence !== block.sequence || row.event_id !== block.eventId || row.error !== block.error;
    if (changed) {
      recordBlock(store, row.room_id, block);
      freshRooms.set(row.room_id, true);
    } else {
      noteDiagnosisAttempt(store, row.room_id, Date.now());
    }
  }
}

function loadState(db, roomId, cursor) {
  if (!cursor) return { state: emptyRoomState(), seq: 0 };
  const replayFrom = (start, state) => {
    const rows = db.prepare("SELECT body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence")
      .all(roomId, start, cursor.applied_seq);
    let current = state;
    for (const row of rows) current = compactState(applyEvent(current, JSON.parse(row.body)));
    return current;
  };
  if (typeof cursor.state_json === "string" && cursor.state_seq >= cursor.applied_seq) {
    try { return { state: decodeMessageReplaySnapshot(db, roomId, cursor.state_json), seq: cursor.state_seq }; }
    catch { /* a torn snapshot replays from the log */ }
  }
  if (typeof cursor.state_json === "string" && Number.isInteger(cursor.state_seq) && cursor.state_seq >= 0 && cursor.state_seq < cursor.applied_seq) {
    try { return { state: replayFrom(cursor.state_seq, decodeMessageReplaySnapshot(db, roomId, cursor.state_json)), seq: cursor.applied_seq }; }
    catch { /* fall through to a full replay */ }
  }
  return { state: replayFrom(0, emptyRoomState()), seq: cursor.applied_seq };
}

// Parked rooms are excluded by the messages_backfill_blocks clause below, so
// no per-call NOT IN list is needed: binding one value per room parked in
// this call broke past 100 (the Worker's Durable Object SQL limit) exactly
// when many rooms stop replaying at once.
function nextRoom(db) {
  return db.prepare(`SELECT r.id AS id, r.sequence AS sequence
    FROM rooms r
    LEFT JOIN messages_backfill_cursor c ON c.room_id = r.id
    WHERE (c.room_id IS NULL
      OR c.applied_seq != r.sequence
      OR (c.applied_seq > 0 AND NOT EXISTS (
        SELECT 1 FROM events e
        WHERE e.room_id = r.id AND e.sequence = c.applied_seq AND e.id = c.applied_event_id
      )))
      AND NOT EXISTS (SELECT 1 FROM messages_backfill_blocks b WHERE b.room_id = r.id)
    ORDER BY r.id
    LIMIT 1`).get() ?? null;
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

// A replay checkpoint is staging, not serving progress. Only an exact-head
// fold may publish; the surrounding transaction includes rows and the cursor.
function publishReplayMessages(store, roomId, sequence, anchor, state) {
  const db=store.db;
  const published=readCursor(db,roomId)?.applied_seq ?? 0;
  const index=new Map((state.messages ?? []).map(message=>[message.id,message]));
  const touched=new Set(), postingSequences=new Map();
  const types=MESSAGE_ROW_TYPES.map(()=>'?').join(',');
  const changes=db.prepare(`SELECT sequence,id,json_extract(body,'$.type') AS type,
    json_extract(body,'$.data.messageId','$.data.replyToId','$.data.toMemberId',
      '$.data.workItemId','$.data.alsoSendToChannel') AS refs
    FROM events WHERE room_id=? AND sequence>? AND sequence<=?
      AND json_extract(body,'$.type') IN (${types}) ORDER BY sequence`)
    .all(roomId,published,sequence,...MESSAGE_ROW_TYPES);
  for(const row of changes) {
    const [messageId,replyToId,toMemberId,workItemId,alsoSendToChannel]=JSON.parse(row.refs);
    const incoming={id:row.id,type:row.type,data:{messageId,replyToId,toMemberId,workItemId,alsoSendToChannel}};
    for(const id of affectedMessageIds(incoming)) {
      if(!index.has(id))continue;
      touched.add(id);
      if (row.type === POSTED && !postingSequences.has(id)) {
        postingSequences.set(id, row.sequence);
      }
    }
  }
  const ids=[...touched], existing=new Map();
  for(let start=0;start<ids.length;start+=256) {
    for(const row of db.prepare(`SELECT message_id,seq,body,record_json,reducer_extras_json FROM messages
      WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))`).all(roomId,JSON.stringify(ids.slice(start,start+256))))existing.set(row.message_id,row);
  }
  // References and archived entities already serve current content. Replaying
  // a changed/corrupt log must not silently replace that authority.
  const raw=JSON.parse(db.prepare('SELECT projection FROM rooms WHERE id=?').get(roomId).projection);
  const references=new Set((raw.messages ?? []).filter(message=>message?._entity===1).map(message=>message.id));
  const archive=archiveMarker(db,roomId), retained=new Set(archive.retainedIds);
  const authoritative=row=>references.has(row.message_id)||(archive.throughSeq&&row.seq<=archive.throughSeq&&!retained.has(row.message_id));
  const validate=row=>{
    if(!authoritative(row))return;
    const expected=index.get(row.message_id);
    let record,extras;
    try {record=JSON.parse(row.record_json);extras=row.reducer_extras_json===null?null:JSON.parse(row.reducer_extras_json);}catch{throw new Error('messages serving entity requires reconciliation');}
    if(!expected || row.body!==storedBody(expected) || !isDeepStrictEqual(record,currentRecord(expected))
      || extras!==null&&!isDeepStrictEqual(extras,reducerExtras(expected)))throw new Error('messages serving entity requires reconciliation');
  };
  if(published===0&&(references.size||archive.throughSeq)) {
    for(const row of db.prepare('SELECT message_id,seq,body,record_json,reducer_extras_json FROM messages WHERE room_id=?').all(roomId))validate(row);
  } else for(const row of existing.values())validate(row);
  const sequences=new Map();
  for(const id of ids) {
    const position=postingSequences.get(id) ?? existing.get(id)?.seq;
    if(!Number.isSafeInteger(position))throw new Error('messages replay is missing posting provenance');
    sequences.set(id,position);
  }
  if(published===0)db.prepare('DELETE FROM messages WHERE room_id=?').run(roomId);
  writeMessageRows(db,{roomId,state,sequenceById:sequences,messageIndex:index,exactSequence:true});
  pruneMessages(db,roomId);
  db.prepare(`UPDATE messages_backfill_cursor SET applied_seq=?,applied_event_id=?,parity_at_seq=NULL WHERE room_id=?`)
    .run(sequence,anchor,roomId);
}

function fillRoom(store, room, budget, expired, yieldBetween) {
  let cursor = readCursor(store.db, room.id, true);
  if (cursor && !cursorMatches(store.db, room.id, cursor, room.sequence)) {
    resetRoom(store, room.id);
    cursor = null;
  }
  let { state, seq } = loadState(store.db, room.id, cursor);
  let events = 0;
  while (events < budget) {
    if (expired()) return { events, stopped: true, budgetExceeded: true, replaySeq: seq };
    const rows = store.db.prepare(`SELECT sequence, id, body FROM events
      WHERE room_id=? AND sequence>? ORDER BY sequence LIMIT ?`)
      .all(room.id, seq, Math.min(BACKFILL_COMMIT, budget - events));
    if (!rows.length) {
      const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(room.id).sequence;
      if (seq !== sequence) throw new Error(`messages backfill stopped at ${seq} before room ${room.id} reached sequence ${sequence}`);
      // The last chunk already stored its event id. Saving here would replace
      // that id with a blank one and the next pass would replay the room.
      store.transaction(() => {
        const anchor=store.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(room.id,seq)?.id ?? "";
        if (seq === 0) saveCursor(store.db,room.id,0,"",state);
        publishReplayMessages(store,room.id,seq,anchor,state);
      });
      return { events, stopped: false, budgetExceeded: false, replaySeq: seq };
    }
    const outcome = store.transaction(() => {
      let next = state;
      let last = null;
      for (const row of rows) {
        const incoming = JSON.parse(row.body);
        next = compactState(applyEvent(next, incoming));
        last = row;
      }
      const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(room.id).sequence;
      saveCursor(store.db, room.id, last.sequence, last.id, next);
      if (last.sequence === sequence) publishReplayMessages(store,room.id,sequence,last.id,next);
      return { state: next, seq: last.sequence };
    });
    state = outcome.state;
    seq = outcome.seq;
    events += rows.length;
    yieldBetween();
  }
  return { events, stopped: false, budgetExceeded: false, replaySeq: seq };
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
// on later calls until refreshStaleBlocks finds the block stale — the
// room's head moved, or the periodic re-diagnosis cadence came due and
// the underlying event proves repaired — so a poisoned room neither
// wedges the batch nor re-runs forever; its failure stays recorded in the unified
// integrity surface until the room backfills clean. Parking is deliberate
// — skipping the event silently would corrupt the table the parity check
// certifies against the projection; the block names what an operator must
// repair.
export function runMessagesBackfill(store, { limit = MESSAGES_BACKFILL_BATCH, deadline = Infinity, yieldBetween = () => {} } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not backfill messages");
  if (typeof yieldBetween !== "function") throw new TypeError("yieldBetween must be a function");
  const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : MESSAGES_BACKFILL_BATCH;
  const failed = [];
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
  refreshStaleBlocks(store, freshRooms, { deadline });
  let events = 0;
  let rooms = 0;
  let roomId = null;
  let appliedSeq = null;
  let replaySeq = null;
  const seen = new Set();
  while (events < cap) {
    if (Date.now() > deadline) return { done: false, events, rooms, budgetExceeded: true, roomId, appliedSeq, replaySeq, blocked: allBlocked(), failed };
    const room = nextRoom(store.db);
    if (!room) return { done: true, events, rooms, budgetExceeded: false, roomId, appliedSeq, replaySeq, blocked: allBlocked(), failed };
    if (seen.has(room.id)) return { done: false, events, rooms, budgetExceeded: false, roomId, appliedSeq, replaySeq, blocked: allBlocked(), failed };
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
      roomId = room.id;
      const progress = readCursor(store.db, room.id);
      appliedSeq = progress?.applied_seq ?? null;
      replaySeq = progress?.state_seq ?? null;
      continue;
    }
    events += wrote.events;
    roomId = room.id;
    appliedSeq = readCursor(store.db, room.id)?.applied_seq ?? 0;
    replaySeq = wrote.replaySeq;
    if (wrote.stopped) return { done: false, events, rooms, budgetExceeded: true, roomId, appliedSeq, replaySeq, blocked: allBlocked(), failed };
  }
  return { done: nextRoom(store.db) == null, events, rooms, budgetExceeded: false, roomId, appliedSeq, replaySeq, blocked: allBlocked(), failed };
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
export function checkMessagesParity(store, { roomId = null } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not check message parity");
  if (roomId !== null && typeof roomId !== "string") throw new TypeError("roomId must be a string");
  // Hold the writer lock across the comparison and certification. Commit a
  // detected mismatch's invalidation before reporting the failure to callers.
  const result = store.transaction(() => {
    try { return { value: certifyMessagesParity(store, roomId) }; }
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

// `target` certifies that one room instead of the sweep's next room (the
// operator archive door, which must certify the room it is about to archive
// at its current head). A target that has not replayed to its head is not
// checked, and the sweep position does not move for a targeted call.
function certifyMessagesParity(store, target = null) {
  let roomId;
  if (target !== null) {
    if (!messagesBackfillCaughtUp(store.db, target)) return { ok: false, checked: 0, roomId: target, reason: "not_caught_up" };
    roomId = target;
  } else {
    const sweepAfter = store.db.prepare("SELECT sweep_after FROM messages_backfill_cursor WHERE room_id=?").get(SWEEP_ID)?.sweep_after ?? "";
    roomId = nextParityRoom(store.db, sweepAfter);
  }
  if (!roomId) return { ok: true, checked: 0 };
  // A failed recheck must not leave an earlier certification usable.
  store.transaction(() => store.db.prepare("UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?").run(roomId));
  const numbers = parityNumbers(store.db, roomId);
  if (numbers.projectionCount !== numbers.tableCount || numbers.projectionLastSeq !== numbers.tableLastSeq) {
    throw new Error(`messages parity failed for ${roomId}: projection count ${numbers.projectionCount}, table count ${numbers.tableCount}, projection last seq ${numbers.projectionLastSeq}, table last seq ${numbers.tableLastSeq}`);
  }
  const hydration = hydrateProjection(store.db, roomId, JSON.parse(store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId).projection), { verifyBodyHashes: true });
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
    let record, reactions, extras;
    try { record = JSON.parse(row.record_json); reactions = row.reactions_json === null ? {} : JSON.parse(row.reactions_json); extras = row.reducer_extras_json === null ? null : JSON.parse(row.reducer_extras_json); }
    catch { /* invalid records fail parity */ }
    if (!message || !isDeepStrictEqual(record, currentRecord(message))
      || (extras !== null && !isDeepStrictEqual(extras, reducerExtras(message)))
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
  if (target === null) rememberSweep(store, roomId);
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

// Message ids among `candidates` that any event after `afterSeq` names
// anywhere in its body. Matching every string value, not a list of keys,
// keeps this right for event types added later; it can only over-keep.
function idsNamedAfter(db, roomId, afterSeq, candidates) {
  const named = new Set();
  if (!candidates.size) return named;
  const visit = value => {
    if (typeof value === "string") {
      if (candidates.has(value)) named.add(value);
      if (candidates.has(`${value}:channel`)) named.add(`${value}:channel`);
    } else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { visit(key); visit(item); }
  };
  for (const row of db.prepare("SELECT body FROM events WHERE room_id=? AND sequence>? ORDER BY sequence").iterate(roomId, afterSeq)) {
    let body;
    try { body = JSON.parse(row.body); } catch { body = row.body; }
    visit(body);
  }
  return named;
}

// Move old messages out of rooms.projection into the messages table only. Keeps
// the newest `keepNewest` messages and everything retainedByState. Needs a
// certified messages table (parity at the room head). dryRun reports what
// would move and changes nothing. Returns { ok, ... } and never throws for
// "not ready" conditions.
export function archiveRoomMessages(store, roomId, { keepNewest = 2000, dryRun = true, belowCursor = false } = {}) {
  if (store?.readOnly) throw new Error("Read-only stores do not archive messages");
  if (!Number.isInteger(keepNewest) || keepNewest < 1) throw new Error("keepNewest must be a positive integer");
  return store.transaction(() => {
    const db = store.db;
    const head = db.prepare("SELECT sequence, projection FROM rooms WHERE id=?").get(roomId);
    if (!head) return { ok: false, reason: "room_not_found" };
    const cursor = db.prepare("SELECT applied_seq, applied_event_id, state_seq, replay_event_id, parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    // belowCursor: a room whose backfill is behind its head (parked, or not
    // yet caught up) can still shed history the table already holds. Only
    // rows at or below the cursor's own exact-head fold may move, and only
    // messages no later event mentions; everything newer stays.
    let limitSeq = head.sequence;
    if (belowCursor) {
      if (!cursor || !(cursor.applied_seq > 0) || !cursorMatches(db, roomId, cursor, head.sequence)) return { ok: false, reason: "messages_cursor_unusable" };
      limitSeq = cursor.applied_seq;
    } else if (!cursor || cursor.applied_seq !== head.sequence || cursor.parity_at_seq !== head.sequence) return { ok: false, reason: "messages_table_not_certified" };
    const state = store.room(roomId).state;
    const inProjection = state.messages ?? [];
    // Once migrated, only the bounded tail/dependency set needs inspection.
    // Do not rescan every normalized history row on each compaction.
    const projectionIds = JSON.stringify(inProjection.map(message => message.id));
    const seqs = new Map(db.prepare("SELECT message_id, seq FROM messages WHERE room_id=? AND seq<=? AND message_id IN (SELECT value FROM json_each(?))")
      .all(roomId, limitSeq, projectionIds).map(row => [row.message_id, row.seq]));
    // Below the cursor, a message with no row is newer than the cursor: it
    // sorts after every row and never moves.
    if (!belowCursor && inProjection.some(message => !seqs.has(message.id))) return { ok: false, reason: "message_missing_from_table" };
    const seqOf = message => seqs.get(message.id) ?? Infinity;
    const ordered = [...inProjection].sort((a, b) => {
      const x = seqOf(a), y = seqOf(b);
      return x === y ? 0 : x < y ? -1 : 1;
    });
    if (ordered.length <= keepNewest) return { ok: true, dryRun, archived: 0, retained: 0, freedBytes: 0, throughSeq: archiveMarker(db, roomId).throughSeq };
    const tail = ordered.slice(ordered.length - keepNewest);
    const cutoff = Math.min(seqOf(tail[0]), limitSeq + 1);
    const keep = retainedByState(state);
    let touchedKept = 0;
    if (belowCursor && limitSeq < head.sequence) {
      // A row is exact at its cursor; an event after the cursor that names a
      // message (edit, reaction, pin, reply, delete...) may have changed it,
      // so that message stays in the projection.
      const touched = idsNamedAfter(db, roomId, limitSeq, new Set(ordered.filter(message => seqOf(message) < cutoff).map(message => message.id)));
      for (const id of touched) if (!keep.has(id)) { keep.add(id); touchedKept += 1; }
    }
    // Keep whole active threads and open questions: see closeKeepSet.
    for (const message of tail) keep.add(message.id);
    closeKeepSet(ordered, keep);
    const marker = archiveMarker(db, roomId);
    const moving = ordered.filter(message => seqOf(message) < cutoff && !keep.has(message.id));
    const scope = belowCursor ? { belowCursor: true, cursorSeq: limitSeq, touchedKept } : {};
    if (!moving.length) return { ok: true, dryRun, archived: 0, retained: 0, freedBytes: 0, throughSeq: marker.throughSeq, ...scope };
    // throughSeq only ever grows: the archived prefix is never shortened.
    const throughSeq = Math.max(marker.throughSeq, seqs.get(moving[moving.length - 1].id));
    const movingIds = new Set(moving.map(message => message.id));
    const retainedIds = ordered.filter(message => seqOf(message) <= throughSeq && !movingIds.has(message.id)).map(message => message.id);
    // Every message at or below the cut that is not moving is explicitly retained.
    const freedBytes = moving.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message)) + 1, 0);
    const result = { ok: true, dryRun, archived: moving.length, retained: retainedIds.length, freedBytes, throughSeq, ...scope };
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
    // Fill reducer-only history for pre-v39 rows at the migration boundary.
    // These bytes are never returned by current-message repository reads.
    const extras = db.prepare('UPDATE messages SET reducer_extras_json=? WHERE room_id=? AND message_id=?');
    for (const message of moving) extras.run(JSON.stringify(reducerExtras(message)), roomId, message.id);
    const next = { ...state, messages: inProjection.filter(message => !movingIds.has(message.id)) };
    // The marker must never claim a message that is still in the projection.
    const overlaps = db.prepare(`SELECT 1 FROM messages WHERE room_id=? AND seq<=?
      AND message_id NOT IN (SELECT value FROM json_each(?))
      AND message_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(roomId, marker.throughSeq, marker.retainedJson, JSON.stringify(next.messages.map(message => message.id)));
    if (overlaps || next.messages.some(message => movingIds.has(message.id))) return { ok: false, reason: "marker_overlaps_projection" };
    next.messagesArchive = { throughSeq, count: marker.count + moving.length, retainedIds };
    db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(storedProjection(db, roomId, next, { enabled: store.bodiesAtRest, messageEntities: store.messageEntityProjection }), roomId);
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

// Load the referenced entities into a command-owned context. This performs no
// writes or cache invalidation: only the accepted command publishes the resulting
// state. Keep the committed serving projection intact throughout admission.
// An owner/author deletion may load its private target without loading ancestors;
// other references only load ancestry visible to the actor.
export function archivedMessageCommandContext(store, roomId, room, messageId, { actorId, ancestors = true, allowPrivate = false } = {}) {
  if (typeof messageId !== 'string' || !messageId) return room;
  const marker = archiveMarker(store.db, roomId), rows = [], seen = new Set();
  let reference = messageId;
  while (typeof reference === 'string' && reference && !seen.has(reference)) {
    seen.add(reference);
    const row = archivedMessageRow(store.db, roomId, reference, marker);
    if (!row || !allowPrivate && row.to_member_id && row.author_id !== actorId && row.to_member_id !== actorId) break;
    rows.push(row);
    if (!ancestors) break;
    reference = row.reply_to_id;
  }
  const db = store.db, state = room.state;
  const live = new Set((state.messages ?? []).map(message=>message.id));
  const missing = rows.filter(row=>!live.has(row.message_id));
  if (!missing.length) return room;
  let replayed;
  const restored = missing.map(row=>{
    const messageId = row.message_id;
    // One indexed provenance check per entity, including channel-copy IDs.
    const source = db.prepare('SELECT body FROM events WHERE room_id=? AND sequence=?').get(roomId, row.seq);
    let posting;
    try { posting = JSON.parse(source?.body); } catch { /* Refuse below. */ }
    if (posting?.type !== POSTED || !affectedMessageIds(posting).includes(messageId)) {
      throw new Error('Archived message could not be restored from the event log');
    }
    let original;
    if (typeof row.record_json === 'string' && typeof row.reducer_extras_json === 'string') {
      try {
        const record = JSON.parse(row.record_json), extras = JSON.parse(row.reducer_extras_json);
        if (record?.id === messageId && record.body === row.body && extras && typeof extras === 'object'
          && !Array.isArray(extras) && Object.keys(extras).every(key => key === 'editHistory')
          && (!Object.hasOwn(extras,'editHistory') || Array.isArray(extras.editHistory))) original = { ...record, ...extras };
      } catch { /* Legacy or damaged entity state is rebuilt from the scrubbed journal. */ }
    }
    if (!original) {
      // A chain containing multiple legacy rows still replays only once.
      replayed ??= new Map((store._replayRoom(roomId, room.sequence).state.messages ?? []).map(message=>[message.id,message]));
      original = replayed.get(messageId);
    }
    if (!original) throw new Error('Archived message could not be restored from the event log');
    return original;
  });
  const restoredIds = restored.map(message=>message.id);
  const ids = JSON.stringify([...live, ...restoredIds]);
  const seqs = new Map(db.prepare('SELECT message_id,seq FROM messages WHERE room_id=? AND message_id IN (SELECT value FROM json_each(?))').all(roomId, ids).map(row=>[row.message_id,row.seq]));
  const messages = [...(state.messages ?? []), ...restored].sort((a,b)=>(seqs.get(a.id) ?? Infinity)-(seqs.get(b.id) ?? Infinity));
  const next = { ...state, messages, messagesArchive: { throughSeq: marker.throughSeq,
    count: Math.max(0, marker.count-restored.length), retainedIds: [...marker.retainedIds,...restoredIds] } };
  return { ...room, state: next };
}
