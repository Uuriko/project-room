// SEC-19: DM follow-up privacy.
//
// RC-2026-09-18-012 hides a targeted message.posted event (data.toMemberId)
// from everyone except its sender and its addressed member. The events that
// later change that message do not carry toMemberId: edits (with the new
// body), deletes, redactions, reactions, pins and unpins. Before this module
// they passed the filter, so a non-party (the Room owner included) could read
// an edited DM body and see that a DM existed. These predicates hide those
// follow-up events too. They look up the referenced message in the room
// projection, and fall back to DMs seen in the same page of events and to
// the archived-parties lookup. If the referenced message resolves nowhere,
// the follow-up is hidden from everyone (fail closed): an unresolvable
// party set is not evidence that the message was public.

import { EVENT_TYPES as T } from "../src/events.js";

export const DM_FOLLOW_UP_TYPES = new Set([
  T.MESSAGE_EDITED,
  T.MESSAGE_DELETED,
  T.MESSAGE_REDACTED,
  T.POLL_VOTED,
  T.MESSAGE_PINNED,
  T.MESSAGE_UNPINNED,
  // A formal request is always addressed (toMemberId), so its cancellation
  // reason is as private as the request body. Keyed by requestMessageId.
  T.REPLY_REQUEST_CANCELLED,
  T.REPLY_REQUEST_PROGRESSED
]);
const referencedMessage = event => event.data?.messageId ?? event.data?.requestMessageId;

function partiesFromMessages(messages) {
  const parties = new Map();
  const known = new Set();
  for (const message of messages ?? []) {
    if (message && typeof message.id === "string" && message.id) {
      known.add(message.id);
      if (typeof message.toMemberId === "string" && message.toMemberId) {
        parties.set(message.id, [message.authorId, message.toMemberId]);
      }
    }
  }
  return { parties, known };
}

// Returns a predicate (event) => boolean for one viewer.
// messages: the room projection's messages, or a thunk returning them. The
// thunk form keeps hot polling paths (eventsAfter) from decoding the full
// projection when the page holds no follow-up events: parties resolve lazily
// on the first follow-up check. rows: optional events in the same read, so a
// DM that the projection no longer holds is still known.
export function dmEventVisibility(viewerId, messagesOrThunk, rows = [], lookupParties = null) {
  let resolved = null;
  const getResolved = () => {
    if (resolved) return resolved;
    const messages = typeof messagesOrThunk === "function" ? messagesOrThunk() : messagesOrThunk;
    resolved = partiesFromMessages(messages);
    for (const row of rows) {
      const event = row?.event ?? row;
      if (event?.type === T.MESSAGE_POSTED) {
        const id = typeof event.data?.messageId === "string" ? event.data.messageId : event.id;
        if (typeof id === "string" && id) {
          resolved.known.add(id);
          if (typeof event?.data?.toMemberId === "string" && event.data.toMemberId && !resolved.parties.has(id)) {
            resolved.parties.set(id, [event.actorId, event.data.toMemberId]);
          }
        }
      }
    }
    return resolved;
  };
  return event => {
    if (!event || typeof event !== "object") return true;
    if (event.type === T.MESSAGE_POSTED) {
      return !event.data?.toMemberId || event.actorId === viewerId || event.data.toMemberId === viewerId;
    }
    if (!DM_FOLLOW_UP_TYPES.has(event.type)) return true;
    // An archived DM is not in the projection; ask the table so its follow-up
    // events stay hidden from non-parties.
    const { parties, known } = getResolved();
    const ref = referencedMessage(event);
    const pair = parties.get(ref) ?? lookupParties?.(ref);
    if (pair) return pair.includes(viewerId);
    // No pair resolved. The follow-up is visible only when the referenced
    // message itself was resolved and is not a DM (a known public message).
    // When the message resolves nowhere — not in the projection, not in the
    // same page of events, and not in the archived-parties lookup — fail
    // CLOSED: the event is hidden from every viewer. An unresolvable party
    // set must never classify as unrestricted, because the follow-up can
    // carry the edited DM body (T3-L10b-C1 / G12). This is the same
    // fail-closed posture as historyFloor (history-visibility.mjs) and
    // peerEventVisible for dm.posted (bonds.mjs).
    return known.has(ref);
  };
}

// RC-2026-09-19-070 (r96): dm.consent_changed is a sequenced pair event. It is
// visible to the two parties and, for moderation, to the room owner. Everyone
// else must not see it (SEC-19 pattern).
export function dmConsentEventVisible(event, viewerId, isOwner = false) {
  if (!event || event.type !== "dm.consent_changed") return true;
  const data = event.data ?? {};
  return data.requesterId === viewerId || data.targetId === viewerId || isOwner === true;
}
