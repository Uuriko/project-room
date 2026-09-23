// B4: per-member notification feed, derived at read time from the event tail
// after the member's own room cursor. Read model only: it writes nothing,
// enqueues no wake, and delivers nothing (push is a follow-up needing VAPID
// keys; see docs/NOTIFICATIONS.md). Every read re-authenticates, so a member
// whose access ended gets 401/403 and never a stale list.
import { EVENT_TYPES as T, defaultNotificationPreferences } from "../src/events.js";
import { messageAddressesMember } from "../src/conversation.js";
import { ServiceError } from "./store.mjs";
import { mutedEvent } from "./moderation.mjs";

const fail = (status, code, message) => { throw new ServiceError(status, code, message); };

export const NOTIFICATION_KINDS = Object.freeze(["mention", "reply", "assignment", "work_update", "access_request"]);
// Bounded tail: the feed never scans unbounded history. Older unread events
// stay reachable through the return brief; the response says where it started.
export const NOTIFICATION_TAIL = 500;
export const NOTIFICATION_DEFAULT_LIMIT = 50;
export const NOTIFICATION_MAX_LIMIT = 100;
const WORK_UPDATE_TYPES = new Set([
  T.WORK_ACCEPTED, T.WORK_STARTED, T.WORK_BLOCKED, T.WORK_BLOCKER_RESOLVED, T.WORK_COMPLETED, T.WORK_SUPERSEDED,
  T.VERIFICATION_RECORDED, T.OWNER_DECISION_RECORDED, T.WORK_HANDOFF_RECORDED, T.WORK_HALT_CLEARED
]);
// RC-2026-09-19-063: session enforcement events. A round-limit pause or a
// budget stop is a work control firing — the room owner is told even when
// they are not the accountable/verifier on the card, because the pause
// waits on their resume.
const SESSION_ENFORCEMENT_TYPES = new Set([
  T.SESSION_STATUS_CHANGED, T.SESSION_STOPPED
]);
const ROLE_FIELDS = ["accountableMemberId", "verifierMemberId", "humanDecisionMakerId"];

const involvedIn = (item, memberId) => Boolean(item) && (ROLE_FIELDS.some(field => item[field] === memberId) || item.proposedById === memberId);

// Pure derivation. `events` are { sequence, event } rows strictly after the
// member's cursor, in ascending order; `state` is the live projection so edits
// and deletions are honoured without a second store.
export function deriveNotifications({ events, state, member }) {
  const preferences = { ...defaultNotificationPreferences(), ...(member.notificationPreferences ?? {}) };
  const messages = new Map((state.messages ?? []).map(message => [message.id, message]));
  const items = new Map(); // dedupe key (messageId|workItemId, kind) -> item
  const put = (kind, targetKind, targetId, row, extra = {}) => {
    const key = `${kind}:${targetId}`;
    const prior = items.get(key);
    if (prior) { prior.sequence = row.sequence; prior.at = row.event.at; prior.actorId = row.event.actorId; prior.changes += 1; Object.assign(prior, extra); return; }
    items.set(key, { kind, [targetKind]: targetId, sequence: row.sequence, at: row.event.at, actorId: row.event.actorId, changes: 1, ...extra });
  };
  for (const row of events) {
    const { event } = row;
    if (event.actorId === member.id) continue; // Your own actions never notify you.
    // E4: an actor you muted never reaches your feed. Read per request, so
    // unmuting brings their items back on the next read (the owner cannot be muted).
    if (mutedEvent(state, member.id, event)) continue;
    if (event.type === T.MESSAGE_POSTED) {
      const messageId = event.data.messageId || event.id;
      const current = messages.get(messageId);
      if (current?.deletedAt) continue; // A tombstone hides the item with the body.
      const message = current ?? { id: messageId, body: event.data.body, replyToId: event.data.replyToId || null, toMemberId: event.data.toMemberId || null };
      // RC-2026-09-19-070: a DM belongs to its two parties. Every other read
      // surface applies this filter at the HTTP layer; this feed derives its
      // own items from the raw event tail, so it has to apply it itself or it
      // becomes the one way to learn a DM exists. Two ways it leaked: a DM
      // that replies to your public message made you the parent author and so
      // earned you a "reply" item, and an @name inside a DM notified someone
      // who cannot read it, which would make DMs a way to signal any member
      // from a conversation they have no access to. The sender is already
      // skipped above; this leaves the recipient, who is owed their message.
      if (message.toMemberId && message.toMemberId !== member.id) continue;
      const addressed = messageAddressesMember(message, member);
      const parent = message.replyToId ? messages.get(message.replyToId) : null;
      const replyToMe = Boolean(parent) && parent.authorId === member.id;
      // One message yields one item: a reply to you is the more specific relation;
      // a message that only addresses you is a mention.
      if (replyToMe && (preferences.replies === "all" || (preferences.replies === "mentions_only" && addressed))) {
        put("reply", "messageId", messageId, row, { replyToId: parent.id, workItemId: message.workItemId ?? null });
      } else if (addressed && preferences.mentions !== "none") {
        put("mention", "messageId", messageId, row, { workItemId: message.workItemId ?? null });
      }
      continue;
    }
    // RC-2026-09-19-071 (QAJ-006): the room owner hears about every new
    // access request. Approval is their explicit decision and nothing else
    // surfaces the queue, so this is not gated on work_updates preferences —
    // like the session-enforcement carve-out below, it waits on the owner.
    if (event.type === T.ACCESS_REQUESTED) {
      if (member.id === state.room?.ownerId) {
        put("access_request", "requestId", event.data.requestId, row, {
          eventId: event.id,
          displayName: event.data.displayName,
          note: event.data.note ?? null,
        });
      }
      continue;
    }
    if (preferences.work_updates === "none") continue;
    if (event.type === T.WORK_PROPOSED) {
      if (ROLE_FIELDS.some(field => event.data[field] === member.id)) put("assignment", "workItemId", event.data.workItemId, row);
      continue;
    }
    // RC-2026-09-19-063: the room owner hears about every enforcement pause
    // or stop — a round-limit pause is specifically waiting on them.
    if (SESSION_ENFORCEMENT_TYPES.has(event.type) && event.data?.workItemId
      && (event.data.suspendReason === "round_limit" || event.data.budgetEnforced === true)
      && member.id === state.room?.ownerId) {
      put("work_update", "workItemId", event.data.workItemId, row, { eventType: event.type });
      continue;
    }
    if (preferences.work_updates !== "all") continue; // mentions_only keeps direct assignments only.
    if (WORK_UPDATE_TYPES.has(event.type) && event.data?.workItemId && involvedIn(state.workItems?.[event.data.workItemId], member.id)) {
      put("work_update", "workItemId", event.data.workItemId, row, { eventType: event.type });
    }
  }
  return [...items.values()].sort((a, b) => b.sequence - a.sequence);
}

export class Notifications {
  constructor(store) { this.store = store; this.db = store.db; }
  // `tail` is an internal bound for tests; the HTTP route never passes it.
  list(token, roomId, binding = null, { limit = NOTIFICATION_DEFAULT_LIMIT, tail = NOTIFICATION_TAIL, before = null } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > NOTIFICATION_MAX_LIMIT) fail(422, "invalid_notification_limit", `Choose a limit between 1 and ${NOTIFICATION_MAX_LIMIT}`);
    if (!Number.isSafeInteger(tail) || tail < 1 || tail > NOTIFICATION_TAIL) fail(422, "invalid_notification_limit", `Choose a tail between 1 and ${NOTIFICATION_TAIL}`);
    if (before !== null && (!Number.isSafeInteger(before) || before < 1)) fail(422, "invalid_notification_selection", "Choose a positive before sequence");
    return this.store.readTransaction(() => {
      // Membership is rechecked on every read; nothing here is cached per member.
      const auth = this.store.authenticate(token, roomId, binding);
      const room = this.store.room(roomId);
      const cursor = this.db.prepare("SELECT sequence FROM cursors WHERE room_id=? AND member_id=?").get(roomId, auth.member.id)?.sequence ?? 0;
      // Fetch one row past the bound so truncation is a fact, not a guess at exactly `tail` rows.
      const through = before === null ? room.sequence : Math.min(room.sequence, before - 1);
      const fetched = this.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND sequence>? AND sequence<=? ORDER BY sequence DESC LIMIT ?").all(roomId, cursor, through, tail + 1);
      const truncated = fetched.length > tail;
      const rows = fetched.slice(0, tail).reverse().map(r => ({ sequence: r.sequence, event: JSON.parse(r.body) }));
      const member = room.state.members[auth.member.id] ?? auth.member;
      const notifications = deriveNotifications({ events: rows, state: room.state, member });
      const nextBefore = notifications.length > limit ? notifications[limit - 1].sequence
        : truncated ? rows[0].sequence : null;
      return {
        pageBefore: before, nextBefore,
        roomId, viewerId: auth.member.id, viewerAccountId: auth.account?.id ?? null, viewerAuthEpoch: auth.account?.authEpoch ?? null,
        viewerSessionBinding: auth.sessionBinding, viewerSessionRevision: auth.sessionRevision ?? null,
        evaluatedAt: this.store.now(), sequence: room.sequence, cursor,
        // Items derive from events (cursor, sequence]; `from` names the oldest event actually scanned.
        basis: { from: rows[0]?.sequence ?? null, through, truncated },
        preferences: { ...defaultNotificationPreferences(), ...(member.notificationPreferences ?? {}) },
        unread: notifications.length,
        notifications: notifications.slice(0, limit)
      };
    });
  }
}
