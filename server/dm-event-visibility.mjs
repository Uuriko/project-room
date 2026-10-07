// SEC-19: DM follow-up privacy.
//
// RC-2026-09-18-012 hides a targeted message.posted event (data.toMemberId)
// from everyone except its sender and its addressed member. The events that
// later change that message do not carry toMemberId: edits (with the new
// body), deletes, redactions, reactions, pins and unpins. Before this module
// they passed the filter, so a non-party (the Room owner included) could read
// an edited DM body and see that a DM existed. These predicates hide those
// follow-up events too. They look up the referenced message in the room
// projection, and fall back to DMs seen in the same page of events.

import { EVENT_TYPES as T } from "../src/events.js";

export const DM_FOLLOW_UP_TYPES = new Set([
  T.MESSAGE_EDITED,
  T.MESSAGE_DELETED,
  T.MESSAGE_REDACTED,
  T.MESSAGE_REACTION_SET,
  T.MESSAGE_PINNED,
  T.MESSAGE_UNPINNED
]);

function partiesFromMessages(messages) {
  const parties = new Map();
  for (const message of messages ?? []) {
    if (message && typeof message.id === "string" && typeof message.toMemberId === "string" && message.toMemberId) {
      parties.set(message.id, [message.authorId, message.toMemberId]);
    }
  }
  return parties;
}

// Returns a predicate (event) => boolean for one viewer.
// messages: the room projection's messages. rows: optional events in the
// same read, so a DM that the projection no longer holds is still known.
export function dmEventVisibility(viewerId, messages, rows = []) {
  const parties = partiesFromMessages(messages);
  for (const row of rows) {
    const event = row?.event ?? row;
    if (event?.type === T.MESSAGE_POSTED && typeof event?.data?.toMemberId === "string" && event.data.toMemberId) {
      const id = typeof event.data.messageId === "string" ? event.data.messageId : event.id;
      if (!parties.has(id)) parties.set(id, [event.actorId, event.data.toMemberId]);
    }
  }
  return event => {
    if (!event || typeof event !== "object") return true;
    if (event.type === T.MESSAGE_POSTED) {
      return !event.data?.toMemberId || event.actorId === viewerId || event.data.toMemberId === viewerId;
    }
    if (!DM_FOLLOW_UP_TYPES.has(event.type)) return true;
    const pair = parties.get(event.data?.messageId);
    return !pair || pair.includes(viewerId);
  };
}
