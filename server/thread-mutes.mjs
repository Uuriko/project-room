// Per-thread mutes.
//
// A member can mute a thread: the thread's activity stops surfacing for
// them in the notification/unread feed (server/notifications.mjs reads the
// table at read time, so unmuting restores the items on the next read — the
// same forward-only semantics as member mutes in server/moderation.mjs).
//
// Model: one row per (room, member, thread root). Mute is recorded against
// the thread's root message id; muting any message in a thread resolves to
// the root first. Rows live in this side table, never as room events, so
// muting is private to the muter and appends no room-visible history.
//
// The DDL intentionally matches the attention slice's thread_mutes table
// (server/activity.mjs on jill/attention-activity-2026-09-23) so the two
// converge instead of colliding: CREATE TABLE IF NOT EXISTS is idempotent.
//
// The module is storage-shaped like DmConsents/Moderation: it takes the
// RoomStore (db handle, transactions, room state) and exports its schema
// for store.mjs to apply. Local ServiceError avoids the store.mjs import
// cycle (Workers-bundle-safe).

class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const threadMutesSchema = `
  CREATE TABLE IF NOT EXISTS thread_mutes (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id, thread_id)
  );
  CREATE INDEX IF NOT EXISTS thread_mutes_member ON thread_mutes(room_id, member_id);
`;

// Walk a message up to its thread root. Returns "" when the message is
// unknown or the chain is broken; the caller turns that into a 404.
function threadRootOf(messages, messageId) {
  const byId = new Map((messages ?? []).map(m => [m.id, m]));
  let node = byId.get(messageId);
  if (!node) return "";
  const seen = new Set();
  while (node.replyToId && !seen.has(node.id)) {
    seen.add(node.id);
    const parent = byId.get(node.replyToId);
    if (!parent) break;
    node = parent;
  }
  return node.id;
}

export class ThreadMutes {
  constructor(store) {
    if (!store || !store.db) fail(500, "thread_mute_store_missing", "ThreadMutes requires a store with a db handle");
    this.store = store;
    this.db = store.db;
  }

  _roomState(roomId) {
    const room = this.store.room(roomId);
    if (!room) fail(404, "room_not_found", "No such room");
    return room.state;
  }

  _auth(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!auth?.member?.id) fail(401, "unauthenticated", "Sign in to manage thread mutes");
    return auth;
  }

  // Ownership envelope so the browser client can verify the payload belongs
  // to its own session (ownsResponse), exactly like the sibling reads.
  _viewer(auth) {
    return {
      viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null,
    };
  }

  // Read model: the caller's own muted thread-root ids. Pure read — no writes.
  list(token, roomId, binding = null) {
    const auth = this._auth(token, roomId, binding);
    return this.store.readTransaction(() => {
      this._roomState(roomId); // 404 on unknown room before leaking rows.
      const rows = this.db.prepare("SELECT thread_id FROM thread_mutes WHERE room_id=? AND member_id=? ORDER BY thread_id")
        .all(roomId, auth.member.id);
      return Object.freeze({ roomId, threadIds: Object.freeze(rows.map(r => r.thread_id)), ...this._viewer(auth) });
    });
  }

  // Write model: { threadId, muted }. threadId may be any message in the
  // thread; it resolves to the thread root. Idempotent both ways.
  set(token, roomId, data, binding = null) {
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_thread_mute", "threadId and muted are required");
    const keys = Object.keys(data);
    if (!keys.includes("threadId") || !keys.includes("muted") || keys.some(key => !["threadId", "muted"].includes(key))) {
      fail(422, "invalid_thread_mute", "threadId and muted are the accepted fields");
    }
    if (typeof data.threadId !== "string" || !data.threadId.trim() || data.threadId.length > 384) {
      fail(422, "invalid_thread_mute", "threadId must be a message id");
    }
    if (typeof data.muted !== "boolean") fail(422, "invalid_thread_mute", "muted must be true or false");
    const auth = this._auth(token, roomId, binding);
    const memberId = auth.member.id;
    return this.store.transaction(() => {
      const rootId = threadRootOf(this._roomState(roomId).messages, data.threadId);
      if (!rootId) fail(404, "message_not_found", "No such thread in this room");
      const now = this.store.now();
      if (data.muted) {
        this.db.prepare("INSERT OR IGNORE INTO thread_mutes (room_id,member_id,thread_id,created_at) VALUES(?,?,?,?)")
          .run(roomId, memberId, rootId, now);
      } else {
        this.db.prepare("DELETE FROM thread_mutes WHERE room_id=? AND member_id=? AND thread_id=?")
          .run(roomId, memberId, rootId);
      }
      return Object.freeze({ roomId, memberId, threadId: rootId, muted: data.muted, ...this._viewer(auth) });
    });
  }

  // Read helper for the notification feed: the member's muted thread-root
  // ids as a Set. Empty set when the table is absent (older writer).
  mutedThreadIds(roomId, memberId) {
    try {
      const rows = this.db.prepare("SELECT thread_id FROM thread_mutes WHERE room_id=? AND member_id=?").all(roomId, memberId);
      return new Set(rows.map(r => r.thread_id));
    } catch {
      return new Set();
    }
  }
}
