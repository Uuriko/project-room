// Personal attention surfaces: activity feed, read horizons, saved messages,
// thread mutes. Write-time fan-out for mention/reply/thread_reply/reaction
// events (per-recipient rows, like mention_states), plus read/unread state per
// item. This is the explicit-triage companion to the cursor-derived
// notifications feed (server/notifications.mjs): notifications derive from the
// event tail, activity rows are fanned out at write time and carry their own
// read state, reactions, and thread replies.
//
// Tables:
//   activity_events  one row per (recipient, triggering message, actor)
//   read_horizons    per-member "read up to" marker, room-wide or per thread
//   saved_messages   per-member saved ("later") messages
//   thread_mutes     per-member muted threads (server-side only for now;
//                    the client toggle ships with the thread-options slice)
//
// The store (server/store.mjs) owns persistence and calls recordActivityEvents
// inside the command transaction, next to trackMentions: an activity row is
// never recorded without its triggering message/reaction. Fan-out never
// throws for unparseable input — like the webhook fan-out, it must not fail
// the command that triggered it.
import { extractMentions } from "./mentions.mjs";
import { resolveMentionTarget } from "./mention-lifecycle.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { ServiceError } from "./store.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const ACTIVITY_TYPES = Object.freeze(["mention", "reply", "thread_reply", "reaction"]);
export const isActivityType = value => ACTIVITY_TYPES.includes(value);

export const activitySchema = `
  CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    type TEXT NOT NULL CHECK(type IN ('mention','reply','thread_reply','reaction')),
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    message_id TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read_at INTEGER,
    UNIQUE(room_id, type, message_id, actor_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS activity_events_feed ON activity_events(room_id, user_id, read_at, id DESC);
  CREATE INDEX IF NOT EXISTS activity_events_type ON activity_events(room_id, user_id, type, id DESC);
  CREATE TABLE IF NOT EXISTS read_horizons (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    thread_id TEXT NOT NULL DEFAULT '',
    last_read_message_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id, thread_id)
  );
  CREATE TABLE IF NOT EXISTS saved_messages (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    saved_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS thread_mutes (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(room_id, member_id, thread_id)
  );
`;

// A DM message is visible only to its author and its recipient.
const dmVisible = (message, memberId) =>
  !message?.toMemberId || message.authorId === memberId || message.toMemberId === memberId;

function threadRootOf(messages, replyToId) {
  const byId = new Map(messages.map(m => [m.id, m]));
  let node = byId.get(replyToId);
  if (!node) return "";
  const seen = new Set();
  while (node.replyToId && byId.get(node.replyToId) && !seen.has(node.id)) {
    seen.add(node.id);
    node = byId.get(node.replyToId);
  }
  return node.id;
}

// Distinct authors of the thread rooted at rootId (root + all descendants).
function threadParticipants(messages, rootId) {
  const byId = new Map(messages.map(m => [m.id, m]));
  const authors = new Set();
  for (const m of messages) {
    let node = m;
    const seen = new Set();
    let inThread = m.id === rootId;
    while (!inThread && node && node.replyToId && !seen.has(node.id)) {
      seen.add(node.id);
      if (node.replyToId === rootId) { inThread = true; break; }
      node = byId.get(node.replyToId);
    }
    if (inThread && m.authorId) authors.add(m.authorId);
  }
  return authors;
}

function identityNamesFor(store, roomId) {
  try {
    const links = store.db.prepare(
      `SELECT l.member_id AS memberId, i.display_name AS displayName FROM identity_links l
       JOIN agent_identities i ON i.identity_id=l.identity_id
       WHERE l.room_id=? AND i.revoked_at IS NULL`).all(roomId);
    return Object.fromEntries(links.map(row => [row.memberId, row.displayName]));
  } catch {
    return {};
  }
}

// Write-time fan-out. Called inside the command transaction after the event
// is persisted. One row per recipient per triggering message; when a
// recipient qualifies for several types, the most direct one wins
// (mention > reply > thread_reply). Muted threads generate no thread_reply
// rows. DM scoping: a DM's events only ever reach the DM's two parties.
export function recordActivityEvents(store, roomId, state, senderId, command, incoming) {
  const db = store.db, now = store.now();
  const members = state?.members ?? {};
  const messages = state?.messages ?? [];
  const actorName = members[senderId]?.displayName ?? senderId;
  if (command.type === T.MESSAGE_POSTED) {
    const data = command.data ?? {};
    const messageId = data.messageId || incoming.id;
    const body = typeof data.body === "string" ? data.body : "";
    const identityNames = identityNamesFor(store, roomId);
    const recipients = new Map(); // userId -> { type, threadId }
    let names = [];
    try { names = extractMentions(body); } catch { names = []; }
    for (const name of names) {
      const target = resolveMentionTarget(members, identityNames, name, senderId);
      if (target && !recipients.has(target)) recipients.set(target, { type: "mention", threadId: "" });
    }
    let threadRootId = "";
    if (data.replyToId) {
      const parent = messages.find(m => m.id === data.replyToId);
      if (parent) {
        if (parent.authorId !== senderId && !recipients.has(parent.authorId)) {
          recipients.set(parent.authorId, { type: "reply", threadId: "" });
        }
        threadRootId = threadRootOf(messages, data.replyToId);
      }
    }
    if (threadRootId) {
      const muted = new Set(db.prepare(
        "SELECT member_id FROM thread_mutes WHERE room_id=? AND thread_id=?").all(roomId, threadRootId).map(r => r.member_id));
      for (const participant of threadParticipants(messages, threadRootId)) {
        if (participant === senderId || recipients.has(participant) || muted.has(participant)) continue;
        recipients.set(participant, { type: "thread_reply", threadId: threadRootId });
      }
    }
    // Consent-bound DMs: a DM addressed to you is the most direct attention
    // signal, so the recipient always gets a mention event (mirroring the
    // cursor-derived notifications feed). Events stay between the DM's two
    // parties, so a mention of a third member in a DM never leaks the DM's
    // existence.
    if (typeof data.toMemberId === "string" && data.toMemberId && data.toMemberId !== senderId) {
      if (!recipients.has(data.toMemberId)) recipients.set(data.toMemberId, { type: "mention", threadId: "" });
      for (const userId of [...recipients.keys()]) {
        if (userId !== data.toMemberId) recipients.delete(userId);
      }
    }
    const insert = db.prepare(
      `INSERT OR IGNORE INTO activity_events
       (room_id,type,actor_id,actor_name,message_id,thread_id,user_id,created_at,read_at)
       VALUES(?,?,?,?,?,?,?,?,NULL)`);
    for (const [userId, info] of recipients) {
      insert.run(roomId, info.type, senderId, actorName, messageId, info.threadId, userId, now);
    }
    return;
  }
  if (command.type === T.MESSAGE_REACTION_SET) {
    const data = command.data ?? {};
    const message = messages.find(m => m.id === data.messageId);
    if (!message) return;
    if (data.active === true) {
      if (message.authorId === senderId) return; // no self-events
      db.prepare(
        `INSERT OR IGNORE INTO activity_events
         (room_id,type,actor_id,actor_name,message_id,thread_id,user_id,created_at,read_at)
         VALUES(?,?,?,?,?,?,?,?,NULL)`)
        .run(roomId, "reaction", senderId, actorName, message.id, "", message.authorId, now);
    } else if (data.active === false) {
      // Toggle-off retracts the still-unread event.
      db.prepare(
        `DELETE FROM activity_events
         WHERE room_id=? AND type='reaction' AND message_id=? AND actor_id=? AND user_id=? AND read_at IS NULL`)
        .run(roomId, message.id, senderId, message.authorId);
    }
  }
}

// --- HTTP-facing reads/writes (membership re-checked on every call) ----------

function authed(store, token, roomId, expectedSessionBinding) {
  const auth = store.authenticate(token, roomId, expectedSessionBinding);
  if (!auth.member || auth.member.active === false) fail(403, "access_denied", "Room membership is inactive");
  return auth;
}

// Session-ownership envelope, mirroring the notifications route: the client's
// guarded readers end the session when a response lacks these fields.
function viewerEnvelope(auth, roomId) {
  return {
    roomId,
    viewerId: auth.member.id,
    viewerAccountId: auth.account?.id ?? null,
    viewerAuthEpoch: auth.account?.authEpoch ?? null,
    viewerSessionBinding: auth.sessionBinding,
    viewerSessionRevision: auth.sessionRevision ?? null,
  };
}

// Public view of one event row, joined against the live message so edits and
// tombstones are honoured. DM rows for conversations the viewer is not a
// party to are dropped (fail closed), mirroring the pins route.
function eventView(store, roomId, row, memberId) {
  const message = store.room(roomId).state.messages.find(m => m.id === row.message_id);
  if (!message || !dmVisible(message, memberId)) return null;
  return {
    id: row.id, type: row.type, roomId,
    actorId: row.actor_id, actorName: row.actor_name,
    messageId: row.message_id, threadId: row.thread_id || null,
    messageBody: message.deletedAt ? null : String(message.body ?? "").slice(0, 280),
    messageAuthorId: message.authorId, messageDeleted: Boolean(message.deletedAt),
    messageCreatedAt: message.createdAt, createdAt: row.created_at, readAt: row.read_at
  };
}

const ACTIVITY_LIMIT_DEFAULT = 50, ACTIVITY_LIMIT_MAX = 100;

export function listActivity(store, token, roomId, params = {}, expectedSessionBinding = null) {
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  const { before = null, limit = ACTIVITY_LIMIT_DEFAULT, type = null } = params ?? {};
  if (before !== null && !(typeof before === "string" && /^[1-9]\d*$/.test(before))) {
    fail(422, "invalid_activity_selection", "before must be a positive event id");
  }
  const count = limit === undefined || limit === null ? ACTIVITY_LIMIT_DEFAULT : Number(limit);
  if (!Number.isInteger(count) || count < 1 || count > ACTIVITY_LIMIT_MAX) {
    fail(422, "invalid_activity_limit", `limit must be an integer between 1 and ${ACTIVITY_LIMIT_MAX}`);
  }
  if (type !== null && type !== undefined && !isActivityType(type)) {
    fail(422, "invalid_activity_type", `type must be one of ${ACTIVITY_TYPES.join(", ")}`);
  }
  return store.readTransaction(() => {
    const clauses = ["room_id=?", "user_id=?"];
    const args = [roomId, member.id];
    if (type) { clauses.push("type=?"); args.push(type); }
    if (before !== null) { clauses.push("id<?"); args.push(Number(before)); }
    const rows = store.db.prepare(
      `SELECT * FROM activity_events WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`).all(...args, count + 1);
    const items = [];
    for (const row of rows.slice(0, count)) {
      const view = eventView(store, roomId, row, member.id);
      if (view) items.push(view);
    }
    return { ...viewerEnvelope(auth, roomId), items, hasMore: rows.length > count, before: before === null ? null : Number(before) };
  });
}

export function activityUnreadCount(store, token, roomId, expectedSessionBinding = null) {
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.readTransaction(() => {
    const rows = store.db.prepare(
      `SELECT type, COUNT(*) AS n FROM activity_events
       WHERE room_id=? AND user_id=? AND read_at IS NULL GROUP BY type`).all(roomId, member.id);
    const byType = Object.fromEntries(ACTIVITY_TYPES.map(t => [t, 0]));
    for (const row of rows) byType[row.type] = row.n;
    return { ...viewerEnvelope(auth, roomId), total: rows.reduce((sum, row) => sum + row.n, 0), byType };
  });
}

export function markActivityRead(store, token, roomId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_activity_read", "ids is required");
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "ids" || !Array.isArray(data.ids) || data.ids.length === 0 || data.ids.length > 200
    || data.ids.some(id => !Number.isInteger(id) || id < 1)) {
    fail(422, "invalid_activity_read", "ids must be a non-empty array of up to 200 positive event ids");
  }
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.transaction(() => {
    const now = store.now();
    const placeholders = data.ids.map(() => "?").join(",");
    const result = store.db.prepare(
      `UPDATE activity_events SET read_at=? WHERE room_id=? AND user_id=? AND read_at IS NULL AND id IN (${placeholders})`
    ).run(now, roomId, member.id, ...data.ids);
    return { ...viewerEnvelope(auth, roomId), read: result.changes };
  });
}

export function markActivityReadAll(store, token, roomId, data = {}, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_activity_read", "type is optional");
  const keys = Object.keys(data);
  if (keys.some(key => key !== "type")) fail(422, "invalid_activity_read", "Only type may be supplied");
  if (data.type !== undefined && !isActivityType(data.type)) {
    fail(422, "invalid_activity_type", `type must be one of ${ACTIVITY_TYPES.join(", ")}`);
  }
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.transaction(() => {
    const now = store.now();
    const result = data.type
      ? store.db.prepare(
        "UPDATE activity_events SET read_at=? WHERE room_id=? AND user_id=? AND type=? AND read_at IS NULL")
        .run(now, roomId, member.id, data.type)
      : store.db.prepare(
        "UPDATE activity_events SET read_at=? WHERE room_id=? AND user_id=? AND read_at IS NULL")
        .run(now, roomId, member.id);
    return { ...viewerEnvelope(auth, roomId), read: result.changes, type: data.type ?? null };
  });
}

// --- read horizons ------------------------------------------------------------

export function getReadHorizon(store, token, roomId, params = {}, expectedSessionBinding = null) {
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  const threadId = params?.threadId ?? "";
  if (typeof threadId !== "string" || threadId.length > 384) fail(422, "invalid_horizon", "threadId must be a short string");
  return store.readTransaction(() => {
    const row = store.db.prepare(
      "SELECT last_read_message_id FROM read_horizons WHERE room_id=? AND member_id=? AND thread_id=?")
      .get(roomId, member.id, threadId);
    return { ...viewerEnvelope(auth, roomId), threadId, lastReadMessageId: row?.last_read_message_id ?? null };
  });
}

export function setReadHorizon(store, token, roomId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_horizon", "Supply threadId and lastReadMessageId");
  const keys = Object.keys(data);
  if (!keys.includes("lastReadMessageId") || keys.some(key => !["threadId", "lastReadMessageId"].includes(key))) {
    fail(422, "invalid_horizon", "Supply lastReadMessageId; threadId is optional");
  }
  const threadId = data.threadId ?? "";
  if (typeof threadId !== "string" || threadId.length > 384) fail(422, "invalid_horizon", "threadId must be a short string");
  const lastReadMessageId = data.lastReadMessageId;
  if (lastReadMessageId !== null && (typeof lastReadMessageId !== "string" || !lastReadMessageId.trim() || lastReadMessageId.length > 384)) {
    fail(422, "invalid_horizon", "lastReadMessageId must be a message id or null");
  }
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.transaction(() => {
    if (lastReadMessageId !== null) {
      const message = store.room(roomId).state.messages.find(m => m.id === lastReadMessageId);
      if (!message) fail(404, "message_not_found", "No such message in this room");
    }
    const now = store.now();
    store.db.prepare(
      `INSERT INTO read_horizons (room_id,member_id,thread_id,last_read_message_id,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(room_id,member_id,thread_id) DO UPDATE SET last_read_message_id=excluded.last_read_message_id, updated_at=excluded.updated_at`)
      .run(roomId, member.id, threadId, lastReadMessageId, now);
    return { ...viewerEnvelope(auth, roomId), threadId, lastReadMessageId };
  });
}

// --- saved messages -----------------------------------------------------------

function savedView(store, roomId, row, memberId) {
  const message = store.room(roomId).state.messages.find(m => m.id === row.message_id);
  if (!message || !dmVisible(message, memberId)) return null;
  const members = store.room(roomId).state.members;
  return {
    messageId: row.message_id, savedAt: row.saved_at,
    authorId: message.authorId, authorName: members[message.authorId]?.displayName ?? message.authorId,
    body: message.deletedAt ? null : String(message.body ?? "").slice(0, 280),
    deleted: Boolean(message.deletedAt), createdAt: message.createdAt, replyToId: message.replyToId ?? null
  };
}

export function listSaved(store, token, roomId, expectedSessionBinding = null) {
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.readTransaction(() => {
    const rows = store.db.prepare(
      "SELECT * FROM saved_messages WHERE room_id=? AND member_id=? ORDER BY saved_at DESC, message_id").all(roomId, member.id);
    const items = [];
    for (const row of rows) {
      const view = savedView(store, roomId, row, member.id);
      if (view) items.push(view);
    }
    return { ...viewerEnvelope(auth, roomId), count: items.length, items };
  });
}

export function setSaved(store, token, roomId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_saved", "messageId and saved are required");
  const keys = Object.keys(data);
  if (!keys.includes("messageId") || !keys.includes("saved") || keys.some(key => !["messageId", "saved"].includes(key))) {
    fail(422, "invalid_saved", "messageId and saved are required");
  }
  if (typeof data.messageId !== "string" || !data.messageId.trim() || data.messageId.length > 384) {
    fail(422, "invalid_saved", "messageId must be a message id");
  }
  if (typeof data.saved !== "boolean") fail(422, "invalid_saved", "saved must be true or false");
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.transaction(() => {
    const message = store.room(roomId).state.messages.find(m => m.id === data.messageId);
    if (!message || !dmVisible(message, member.id)) fail(404, "message_not_found", "No such message in this room");
    if (data.saved && message.deletedAt) fail(409, "message_deleted", "A deleted message cannot be saved");
    const now = store.now();
    if (data.saved) {
      store.db.prepare(
        "INSERT OR IGNORE INTO saved_messages (room_id,member_id,message_id,saved_at) VALUES(?,?,?,?)")
        .run(roomId, member.id, data.messageId, now);
    } else {
      store.db.prepare("DELETE FROM saved_messages WHERE room_id=? AND member_id=? AND message_id=?")
        .run(roomId, member.id, data.messageId);
    }
    return { ...viewerEnvelope(auth, roomId), messageId: data.messageId, saved: data.saved };
  });
}

// --- thread mutes (server-side only for now) ------------------------------------

export function setThreadMute(store, token, roomId, data, expectedSessionBinding = null) {
  if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_thread_mute", "threadId and muted are required");
  const keys = Object.keys(data);
  if (!keys.includes("threadId") || !keys.includes("muted") || keys.some(key => !["threadId", "muted"].includes(key))) {
    fail(422, "invalid_thread_mute", "threadId and muted are required");
  }
  if (typeof data.threadId !== "string" || !data.threadId.trim() || data.threadId.length > 384) {
    fail(422, "invalid_thread_mute", "threadId must be a message id");
  }
  if (typeof data.muted !== "boolean") fail(422, "invalid_thread_mute", "muted must be true or false");
  const auth = authed(store, token, roomId, expectedSessionBinding);
  const member = auth.member;
  return store.transaction(() => {
    const rootId = threadRootOf(store.room(roomId).state.messages, data.threadId);
    if (!rootId) fail(404, "message_not_found", "No such thread in this room");
    const now = store.now();
    if (data.muted) {
      store.db.prepare("INSERT OR IGNORE INTO thread_mutes (room_id,member_id,thread_id,created_at) VALUES(?,?,?,?)")
        .run(roomId, member.id, rootId, now);
    } else {
      store.db.prepare("DELETE FROM thread_mutes WHERE room_id=? AND member_id=? AND thread_id=?")
        .run(roomId, member.id, rootId);
    }
    return { ...viewerEnvelope(auth, roomId), threadId: rootId, muted: data.muted };
  });
}
