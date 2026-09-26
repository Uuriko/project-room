// Human browser push. One fixed default: mentions and direct messages.
// The browser permission prompt is the only switch. Notification preference
// levels and quiet hours are not inputs here; thread mutes and member mutes
// are the undo. Agents keep their heartbeat push doorbell. A push names the
// room and a count, never the message.
import { isMutedBy } from "../src/events.js";
import { resolveMentionTargetsInText } from "./mention-lifecycle.mjs";
import { deliverToSubscriptions, normaliseSubscription, pushPayloadFor } from "./push-subscriptions.mjs";

export const HUMAN_PUSH_DEFAULT = "mentions_and_dms";
const MAX_DEVICES = 8;

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.name = "ServiceError"; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const humanPushSchema = `
  CREATE TABLE IF NOT EXISTS human_push_subscriptions (
    endpoint TEXT NOT NULL,
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    expiration_time INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (endpoint, room_id, member_id)
  );
  CREATE INDEX IF NOT EXISTS human_push_member ON human_push_subscriptions(room_id, member_id);
`;

// Humans a message.posted should wake in the browser. A DM stays with its
// recipient. An @mention fans out only in the room channel, and only to
// humans. The sender is never a recipient. Agents are not: they already
// have the heartbeat doorbell.
export function humanPushRecipients({ members, senderMemberId, body, toMemberId }) {
  const roster = {};
  for (const [memberId, member] of Object.entries(members ?? {})) {
    if (!member || member.kind !== "human" || member.active === false || memberId === senderMemberId) continue;
    roster[memberId] = member;
  }
  const dmId = typeof toMemberId === "string" ? toMemberId : "";
  if (dmId) return roster[dmId] ? [{ memberId: dmId, kind: "dm" }] : [];
  return resolveMentionTargetsInText(roster, {}, typeof body === "string" ? body : "", senderMemberId)
    .map(memberId => ({ memberId, kind: "mention" }));
}

function threadRootOf(messages, messageId) {
  const byId = new Map((messages ?? []).map(message => [message.id, message]));
  let node = byId.get(messageId);
  if (!node) return messageId;
  const seen = new Set();
  while (node.replyToId && !seen.has(node.id)) {
    seen.add(node.id);
    const parent = byId.get(node.replyToId);
    if (!parent) break;
    node = parent;
  }
  return node.id;
}

export class HumanPush {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.vapid = null;
    this.fetchImpl = null;
    this.inflight = [];
  }

  configure({ vapid = undefined, fetchImpl = undefined } = {}) {
    if (vapid !== undefined) this.vapid = vapid && vapid.publicKey && vapid.privateKey && vapid.subject ? vapid : null;
    if (fetchImpl !== undefined) this.fetchImpl = fetchImpl;
    return this;
  }

  _auth(token, roomId, binding) {
    const auth = this.store.authenticate(token, roomId, binding);
    if (!auth?.member?.id) fail(401, "unauthenticated", "Sign in to turn on notifications");
    return auth;
  }

  _viewer(auth) {
    return {
      viewerId: auth.member.id,
      viewerAccountId: auth.account?.id ?? null,
      viewerAuthEpoch: auth.account?.authEpoch ?? null,
      viewerSessionBinding: auth.sessionBinding,
      viewerSessionRevision: auth.sessionRevision ?? null
    };
  }

  _human(auth) {
    if (auth.member.kind !== "human") fail(403, "human_push_humans_only", "Browser push is for human members");
    return auth.member.id;
  }

  status(token, roomId, binding = null) {
    const auth = this._auth(token, roomId, binding);
    this._human(auth);
    const body = {
      roomId,
      configured: Boolean(this.vapid),
      default: HUMAN_PUSH_DEFAULT,
      ...this._viewer(auth)
    };
    if (this.vapid) body.publicKey = this.vapid.publicKey;
    return Object.freeze(body);
  }

  save(token, roomId, data, binding = null) {
    if (!data || typeof data !== "object" || Array.isArray(data)) fail(422, "invalid_human_push", "Send the browser subscription");
    const fields = Object.keys(data);
    if (!fields.includes("endpoint") || !fields.includes("keys")
      || fields.some(field => !["endpoint", "keys", "expirationTime"].includes(field))) {
      fail(422, "invalid_human_push", "Send endpoint, keys, and optional expirationTime");
    }
    if (!data.keys || typeof data.keys !== "object" || Array.isArray(data.keys)) fail(422, "invalid_human_push", "Send the subscription keys");
    const keyNames = Object.keys(data.keys);
    if (!keyNames.includes("p256dh") || !keyNames.includes("auth") || keyNames.some(name => !["p256dh", "auth"].includes(name))) {
      fail(422, "invalid_human_push", "Subscription keys are p256dh and auth");
    }
    if (!this.vapid) fail(404, "push_not_configured", "Push is not configured on this server");
    const auth = this._auth(token, roomId, binding);
    const memberId = this._human(auth);
    let normalised;
    try { normalised = normaliseSubscription(data, { now: this.store.now(), memberId }); }
    catch (error) {
      if (error?.name === "PushSubscriptionError") fail(422, error.code, error.message);
      throw error;
    }
    return this.store.transaction(() => {
      const prior = this.db.prepare(
        "SELECT 1 FROM human_push_subscriptions WHERE endpoint=? AND room_id=? AND member_id=?"
      ).get(normalised.endpoint, roomId, memberId);
      if (!prior) {
        const count = this.db.prepare(
          "SELECT COUNT(*) AS n FROM human_push_subscriptions WHERE room_id=? AND member_id=?"
        ).get(roomId, memberId).n;
        if (count >= MAX_DEVICES) fail(409, "human_push_device_limit", "This member already has 8 browsers subscribed");
      }
      this.db.prepare(`INSERT INTO human_push_subscriptions
        (endpoint, room_id, member_id, p256dh, auth, expiration_time, created_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(endpoint, room_id, member_id) DO UPDATE SET
          p256dh=excluded.p256dh, auth=excluded.auth,
          expiration_time=excluded.expiration_time, created_at=excluded.created_at`
      ).run(normalised.endpoint, roomId, memberId, normalised.keys.p256dh, normalised.keys.auth,
        normalised.expirationTime, this.store.now());
      return Object.freeze({ roomId, saved: true, ...this._viewer(auth) });
    });
  }

  remove(token, roomId, data, binding = null) {
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.keys(data).some(field => field !== "endpoint")
      || typeof data.endpoint !== "string" || !data.endpoint) {
      fail(422, "invalid_human_push", "Send the subscription endpoint");
    }
    const auth = this._auth(token, roomId, binding);
    const memberId = this._human(auth);
    return this.store.transaction(() => {
      const result = this.db.prepare(
        "DELETE FROM human_push_subscriptions WHERE endpoint=? AND room_id=? AND member_id=?"
      ).run(data.endpoint, roomId, memberId);
      return Object.freeze({ roomId, removed: result.changes > 0, ...this._viewer(auth) });
    });
  }

  _rows(roomId, memberId) {
    try {
      return this.db.prepare(`SELECT endpoint, p256dh, auth, expiration_time AS expirationTime
        FROM human_push_subscriptions WHERE room_id=? AND member_id=?`).all(roomId, memberId)
        .map(row => ({
          endpoint: row.endpoint,
          keys: { p256dh: row.p256dh, auth: row.auth },
          expirationTime: row.expirationTime
        }));
    } catch {
      return [];
    }
  }

  _suppressed(roomId, state, memberId, senderMemberId, messageId) {
    if (isMutedBy(state, memberId, senderMemberId)) return true;
    const root = threadRootOf(state?.messages, messageId);
    try { return this.store.threadMutes.mutedThreadIds(roomId, memberId).has(root); }
    catch { return false; }
  }

  // Fire-and-forget. Called from the message.posted transaction after the
  // event is stored. A push failure never fails the post. With no VAPID
  // keys this returns before it looks anyone up.
  notifyPosted({ roomId, state, senderMemberId, body, toMemberId, messageId, sequence }) {
    try {
      if (!this.vapid) return;
      for (const recipient of humanPushRecipients({ members: state?.members, senderMemberId, body, toMemberId })) {
        if (this._suppressed(roomId, state, recipient.memberId, senderMemberId, messageId)) continue;
        const subscriptions = this._rows(roomId, recipient.memberId);
        if (subscriptions.length === 0) continue;
        const payload = pushPayloadFor({
          roomId,
          unread: 1,
          sequence,
          notifications: [{ kind: recipient.kind }]
        });
        const pending = deliverToSubscriptions({
          subscriptions,
          payload,
          vapid: this.vapid,
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {})
        }).then(result => this._retire(result.retire)).catch(() => {});
        this.inflight.push(pending);
      }
    } catch {
      // The push path never fails the post.
    }
  }

  _retire(endpoints) {
    if (!endpoints?.length) return;
    try {
      const drop = this.db.prepare("DELETE FROM human_push_subscriptions WHERE endpoint=?");
      for (const endpoint of endpoints) drop.run(endpoint);
    } catch {
      // A closed store or a busy write can wait until the next send.
    }
  }

  async flush() {
    const pending = this.inflight.splice(0, this.inflight.length);
    await Promise.all(pending);
  }
}
