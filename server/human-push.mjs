// Human browser push. Default: mentions and direct messages, both on until
// the member opts out per kind. The browser permission prompt is the subscribe
// switch; the per-kind preference switches (human_push_preferences) are the
// undo, enforced before any send. Thread mutes and member mutes are the other
// undo. Agents keep their heartbeat push doorbell. A push names the room and
// a count; only when the member opts into previews does the payload also
// carry the sender, a lock-screen-safe preview of the message, and a deep
// link back to it. Quiet hours suppress the push channel for the window the
// member sets.
import { isMutedBy } from "../src/events.js";
import { notificationFromPush } from "../src/human-push-display.js";
import { resolveMentionTargetsInText } from "./mention-lifecycle.mjs";
import { isQuietAt, normalizeQuietHours, NotifyError } from "./notify-prefs.mjs";
import { deliverToSubscriptions, normaliseSubscription, pushPayloadFor, richPushPayloadFor } from "./push-subscriptions.mjs";
import { dmTargetIds } from "./dm-rooms.mjs";

export const HUMAN_PUSH_DEFAULT = "mentions_and_dms";
// The two event kinds the push channel actually delivers. Preferences switch
// each kind on or off for one member in one room; both are on by default, so
// a member who never touches them gets exactly today's behavior.
export const HUMAN_PUSH_PREF_KINDS = Object.freeze(["mention", "dm"]);
export const HUMAN_PUSH_PREF_DEFAULTS = Object.freeze({ mention: true, dm: true });
const MAX_DEVICES = 8;
const DECLARATIVE_LIMIT = 4096;

// HB-3a. iOS 18.4+ can show this without waking the service worker. The
// count fields stay so every other platform still uses the worker. Off
// unless PUSH_DECLARATIVE=on. A payload that would reach 4KB is left as the
// count payload.
export function declarativePushPayload(payload, { enabled = false } = {}) {
  if (enabled !== true || !payload || typeof payload !== "object") return payload;
  const note = notificationFromPush(payload);
  const navigate = typeof payload.navigateUrl === "string" && payload.navigateUrl.startsWith("/") && !payload.navigateUrl.startsWith("//")
    ? payload.navigateUrl
    : note.data.url;
  const notification = {
    title: note.title,
    body: note.body,
    navigate_url: navigate,
    tag: note.tag
  };
  if (Number.isInteger(payload.needsMeCount) && payload.needsMeCount >= 0) notification.app_badge = payload.needsMeCount;
  const next = { ...payload, web_push: 8030, notification };
  if (new TextEncoder().encode(JSON.stringify(next)).length >= DECLARATIVE_LIMIT) return payload;
  return next;
}

export function declarativePushEnabled(env = process.env) {
  return env?.PUSH_DECLARATIVE === "on";
}

class ServiceError extends Error {
  constructor(status, code, message) { super(message); this.name = "ServiceError"; this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
const exactKeys = (value, fields) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

// Browser-issued delivery services only. A subscriber must never turn a
// mention into an arbitrary HTTPS request from the server's network.
function checkEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { fail(422, "invalid_push_endpoint", "Use a browser-issued push endpoint"); }
  const host = url.hostname;
  const allowed = host === "fcm.googleapis.com" || host === "updates.push.services.mozilla.com"
    || host === "web.push.apple.com" || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (url.protocol !== "https:" || !allowed || url.username || url.password || url.port || url.hash)
    fail(422, "invalid_push_endpoint", "Use a browser-issued push endpoint");
}

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

// Per-member push-channel preferences (wave-2 #1601). One row per member per
// room; absent means both kinds on. This is the switch the human controls for
// the browser push channel. It does not consult the older in-app
// notificationPreferences levels, which steer the in-app feed only.
//
// preview_enabled is the member's lock-screen preview switch: off by default,
// so a push carries no room content unless the member opts in — the standing
// privacy contract (a push names the room and a count, never the message).
// When the member turns preview on, the payload carries sender, preview,
// and deep link; turning it back off restores the counts-only payload byte
// for byte. quiet_hours is JSON { start, end, tz } or null; while the window
// is active the push channel stays silent for that member.
export const humanPushPrefsSchema = `
  CREATE TABLE IF NOT EXISTS human_push_preferences (
    room_id TEXT NOT NULL,
    member_id TEXT NOT NULL,
    mention_enabled INTEGER NOT NULL DEFAULT 1,
    dm_enabled INTEGER NOT NULL DEFAULT 1,
    preview_enabled INTEGER NOT NULL DEFAULT 0,
    quiet_hours TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, member_id)
  );
`;

// Humans a message.posted should wake in the browser. A DM stays with its
// recipients (one for a pair DM, all of them for a group DM). An @mention
// fans out only in the room channel, and only to humans. The sender is never
// a recipient. Agents are not: they already have the heartbeat doorbell.
export function humanPushRecipients({ members, senderMemberId, body, toMemberId, toMemberIds }) {
  const roster = {};
  for (const [memberId, member] of Object.entries(members ?? {})) {
    if (!member || member.kind !== "human" || member.active === false || memberId === senderMemberId) continue;
    roster[memberId] = member;
  }
  const dmIds = dmTargetIds({ toMemberId, toMemberIds });
  if (dmIds.length > 0) return dmIds.filter(id => roster[id]).map(id => ({ memberId: id, kind: "dm" }));
  return resolveMentionTargetsInText(members, {}, typeof body === "string" ? body : "", senderMemberId)
    .filter(memberId => Object.hasOwn(roster, memberId))
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
    this.inflight = new Set();
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
    const memberId = this._human(auth);
    const body = {
      roomId,
      configured: Boolean(this.vapid),
      default: HUMAN_PUSH_DEFAULT,
      preferences: this._prefsFor(roomId, memberId),
      ...this._viewer(auth)
    };
    if (this.vapid) body.publicKey = this.vapid.publicKey;
    return Object.freeze(body);
  }

  // An absent row preserves the default; unreadable preferences fail closed.
  // quiet_hours is stored as JSON text; a row that predates the column (or a
  // corrupt value) reads as no quiet hours rather than failing the send.
  _prefsFor(roomId, memberId) {
    let row = null;
    try {
      row = this.db.prepare(
        "SELECT mention_enabled, dm_enabled, preview_enabled, quiet_hours FROM human_push_preferences WHERE room_id=? AND member_id=?"
      ).get(roomId, memberId);
    } catch {
      row = null;
    }
    if (!row) return { ...HUMAN_PUSH_PREF_DEFAULTS, preview: false, quietHours: null };
    let quietHours = null;
    if (typeof row.quiet_hours === "string" && row.quiet_hours) {
      try {
        const parsed = JSON.parse(row.quiet_hours);
        quietHours = parsed && typeof parsed === "object" ? normalizeQuietHours(parsed) : null;
      } catch { quietHours = null; }
    }
    return {
      mention: row.mention_enabled !== 0,
      dm: row.dm_enabled !== 0,
      preview: row.preview_enabled !== 0,
      quietHours
    };
  }

  preferences(token, roomId, binding = null) {
    const auth = this._auth(token, roomId, binding);
    const memberId = this._human(auth);
    return Object.freeze({ roomId, preferences: this._prefsFor(roomId, memberId), ...this._viewer(auth) });
  }

  // Partial merge over the stored row: send only the kinds to change.
  // Preferences are intent, not delivery, so they store even when push is
  // not configured; delivery stays dark until VAPID keys exist.
  setPreferences(token, roomId, data, binding = null) {
    if (!data || typeof data !== "object" || Array.isArray(data) || !exactKeys(data, ["preferences"]))
      fail(422, "invalid_human_push_preferences", "Send { preferences: { mention, dm, preview, quietHours } }");
    const prefs = data.preferences;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) fail(422, "invalid_human_push_preferences", "Send { preferences: { mention, dm, preview, quietHours } }");
    const fields = Object.keys(prefs);
    const BOOLEAN_FIELDS = [...HUMAN_PUSH_PREF_KINDS, "preview"];
    if (fields.length === 0 || fields.some(field => !BOOLEAN_FIELDS.includes(field) && field !== "quietHours")
      || fields.some(field => BOOLEAN_FIELDS.includes(field) && typeof prefs[field] !== "boolean"))
      fail(422, "invalid_human_push_preferences", "preferences holds mention, dm, preview (each true or false) and/or quietHours ({ start, end, tz } or null)");
    let quietHours = null;
    let quietHoursTouched = false;
    if (Object.hasOwn(prefs, "quietHours")) {
      quietHoursTouched = true;
      const raw = prefs.quietHours;
      if (raw !== null) {
        try { quietHours = normalizeQuietHours(raw); }
        catch (error) {
          if (error instanceof NotifyError || error?.name === "NotifyError")
            fail(422, "invalid_human_push_preferences", `quietHours is invalid: ${error.message}`);
          throw error;
        }
      }
    }
    const auth = this._auth(token, roomId, binding);
    const memberId = this._human(auth);
    const current = this._prefsFor(roomId, memberId);
    const next = {
      mention: fields.includes("mention") ? prefs.mention : current.mention,
      dm: fields.includes("dm") ? prefs.dm : current.dm,
      preview: fields.includes("preview") ? prefs.preview : current.preview,
      quietHours: quietHoursTouched ? quietHours : current.quietHours
    };
    this.db.prepare(`INSERT INTO human_push_preferences
      (room_id, member_id, mention_enabled, dm_enabled, preview_enabled, quiet_hours, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(room_id, member_id) DO UPDATE SET
        mention_enabled=excluded.mention_enabled,
        dm_enabled=excluded.dm_enabled,
        preview_enabled=excluded.preview_enabled,
        quiet_hours=excluded.quiet_hours,
        updated_at=excluded.updated_at`
    ).run(roomId, memberId, next.mention ? 1 : 0, next.dm ? 1 : 0, next.preview ? 1 : 0,
      next.quietHours ? JSON.stringify(next.quietHours) : null, this.store.now());
    return Object.freeze({ roomId, preferences: next, configured: Boolean(this.vapid), ...this._viewer(auth) });
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
    checkEndpoint(data.endpoint);
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
    catch { return true; } // Missing mute evidence must not disclose activity.
  }

  // Fire-and-forget. Called from the message.posted transaction after the
  // event is stored. A push failure never fails the post. With no VAPID
  // keys this returns before it looks anyone up.
  notifyPosted({ roomId, state, senderMemberId, body, toMemberId, toMemberIds, messageId, sequence, eventId }) {
    try {
      if (!this.vapid) return;
      for (const recipient of humanPushRecipients({ members: state?.members, senderMemberId, body, toMemberId, toMemberIds })) {
        if (this._suppressed(roomId, state, recipient.memberId, senderMemberId, messageId)) continue;
        // The member's own push switch. Default on: never touching
        // preferences keeps today's mentions-and-DMs behavior exactly.
        const prefs = this._prefsFor(roomId, recipient.memberId);
        if (recipient.kind === "mention" && !prefs.mention) continue;
        if (recipient.kind === "dm" && !prefs.dm) continue;
        // Quiet hours silence the push channel for the member's window. The
        // message still lands in the room; only the wake is skipped.
        if (prefs.quietHours && isQuietAt(prefs.quietHours, this.store.now())) continue;
        const subscriptions = this._rows(roomId, recipient.memberId);
        if (subscriptions.length === 0) continue;
        const sender = state?.members?.[senderMemberId] ?? null;
        const payload = declarativePushPayload(richPushPayloadFor({
          roomId,
          roomName: typeof state?.room?.title === "string" ? state.room.title : null,
          unread: 1,
          sequence,
          notifications: [{ kind: recipient.kind }],
          kind: recipient.kind,
          sender: sender ? { memberId: senderMemberId, name: sender.displayName ?? null } : null,
          body: typeof body === "string" ? body : null,
          messageId,
          preview: prefs.preview === true
        }), { enabled: declarativePushEnabled() });
        // Start only after synchronous transaction completion. A failed outer
        // transaction may remove this event even after command() returned.
        const stillVisible = endpoint => {
          const stored = this.db.prepare("SELECT id FROM events WHERE room_id=? AND sequence=?").get(roomId, sequence);
          if (stored?.id !== eventId) return false;
          const current = this.store.room(roomId).state;
          const member = current.members?.[recipient.memberId];
          const message = current.messages?.find(row => row.id === messageId);
          const prefs = this._prefsFor(roomId, recipient.memberId);
          const kindOn = recipient.kind === "mention" ? prefs.mention : prefs.dm;
          return kindOn && member?.kind === "human" && member.active !== false
            && message && !message.deletedAt
            && (dmTargetIds(message).length === 0 || dmTargetIds(message).includes(recipient.memberId))
            && !this._suppressed(roomId, current, recipient.memberId, senderMemberId, messageId)
            && this._rows(roomId, recipient.memberId).some(row => row.endpoint === endpoint);
        };
        const pending = Promise.resolve().then(() => deliverToSubscriptions({
          subscriptions,
          payload,
          vapid: this.vapid,
          fetchImpl: (url, init) => {
            checkEndpoint(url);
            if (!stillVisible(url)) throw new Error("Push no longer authorized");
            return (this.fetchImpl ?? globalThis.fetch)(url, { ...init, redirect: "error" });
          }
        })).then(result => this._retire(result.retire)).catch(() => {});
        this.inflight.add(pending);
        void pending.finally(() => this.inflight.delete(pending));
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
    const pending = [...this.inflight];
    await Promise.all(pending);
  }
}
