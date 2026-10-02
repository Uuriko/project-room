// MSG-1: the messages table, double-written with the room event log.
// Read paths still use the projection. This module only writes rows, in the
// same transaction as the event insert. MSG-2 backfills events that landed
// before the table existed.

export const MESSAGE_ROW_TYPES = Object.freeze([
  "message.posted",
  "message.edited",
  "message.deleted",
  "message.reaction_set",
  "message.pinned",
  "message.unpinned"
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
  PRIMARY KEY (room_id, message_id)
);
CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_channel_seq ON messages(room_id, channel_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_thread_seq ON messages(room_id, thread_root_id, seq);
CREATE INDEX IF NOT EXISTS messages_room_dm_seq ON messages(room_id, to_member_id, seq);
`;

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
  const byId = new Map((messages ?? []).map(entry => [entry.id, entry]));
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

function affectedMessageIds(event) {
  const data = event?.data ?? {};
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
      author_id, body, created_at, edited_at, deleted_at, reactions_json, pinned
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
      pinned = excluded.pinned`);
  statements.set(db, hit);
  return hit;
}

function textOrNull(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Same rule as currentBody in server/redact-read.mjs. A deleted message
// stores no text. An edit stores only the current body. Prior wording stays
// in the event log and is left out of this table.
function storedBody(message) {
  if (!message || message.deletedAt || message.body == null) return null;
  return typeof message.body === "string" ? message.body : null;
}

// Upsert one row per message the event touched. seq stays at the earliest
// event that wrote the row, so an edit does not reorder history. Calling
// this twice for the same event leaves one row.
export function syncMessageRows(db, { roomId, sequence, event, state }) {
  if (!MESSAGE_ROW_TYPE_SET.has(event?.type)) return 0;
  const messages = state?.messages ?? [];
  const byId = new Map(messages.map(message => [message.id, message]));
  const pinned = new Set((state?.pins ?? []).map(pin => pin.messageId));
  const upsert = statementFor(db);
  let written = 0;
  for (const messageId of affectedMessageIds(event)) {
    const message = byId.get(messageId);
    if (!message || typeof message.authorId !== "string" || typeof message.createdAt !== "string") continue;
    const reactions = message.reactions && typeof message.reactions === "object" && Object.keys(message.reactions).length
      ? JSON.stringify(message.reactions) : null;
    upsert.run(
      roomId, message.id, sequence,
      textOrNull(message.channelId),
      threadRootId(messages, message),
      textOrNull(message.replyToId),
      textOrNull(message.toMemberId),
      textOrNull(message.workItemId),
      message.authorId,
      storedBody(message),
      message.createdAt,
      textOrNull(message.editedAt),
      textOrNull(message.deletedAt),
      reactions,
      pinned.has(message.id) ? 1 : 0
    );
    written += 1;
  }
  return written;
}
