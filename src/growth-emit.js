// Track C slice C3 — Growth event emission wiring.
//
// Bridges the room's event-sourced core (src/events.js) to the growth
// analytics pipeline (C1 contract + C2 collector). Every committed room
// event flows through the single choke point applyEvent; this module wraps
// that choke point and projects the event into a privacy-shaped C1 growth
// event recorded on a C2 collector.
//
// Pure and dependency-free apart from the three sibling modules it bridges.
// No network, no storage, no timers.
//
// Emission never throws into the room path: build/record failures are
// counted in a module-local counter (see getGrowthEmissionFailures) and
// reported on the { growthOk, growthReason } result. A failed emission
// never changes the room state that applyEvent produced.

import { EVENT_TYPES, applyEvent } from "./events.js";
import { defineEvent } from "./growth-events.js";
import { createCollector } from "./growth-collector.js";
import { detectMentions } from "./growth-mentions.js";

// Frozen mapping from room event types (EVENT_TYPES values) to C1 growth
// event types. Room event types absent from this table are skipped silently.
export const ROOM_TO_GROWTH = Object.freeze({
  [EVENT_TYPES.ROOM_CREATED]: "room.created",
  [EVENT_TYPES.MEMBER_ADDED]: "member.joined",
  [EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION]: "member.joined",
  [EVENT_TYPES.MESSAGE_POSTED]: "message.sent",
  [EVENT_TYPES.MESSAGE_REACTION_SET]: "reaction.added",
  [EVENT_TYPES.MESSAGE_PINNED]: "message.pinned",
  [EVENT_TYPES.WORK_PROPOSED]: "work.proposed",
  [EVENT_TYPES.WORK_COMPLETED]: "work.completed",
  [EVENT_TYPES.NOTIFICATION_PREFERENCES_SET]: "notification.preference_set"
});

// Growth type for a room event type string, or null when unmapped.
export const growthTypeFor = roomType =>
  typeof roomType === "string" ? ROOM_TO_GROWTH[roomType] ?? null : null;

// Shared process-local collector for the live commit paths. Later slices
// may persist it or fan events out; C3 keeps it in memory per the contract.
export const growthCollector = createCollector();

// Emission failures are counted here, not on the collector: the C2
// collector only counts envelopes it accepted or rejected at the door,
// while these are failures to build or hand off an envelope at all.
let emissionFailures = 0;
export const getGrowthEmissionFailures = () => emissionFailures;

// Message length buckets for the message.sent aggregate. Bodies are never
// collected — only the bucket travels with the event.
const lengthBucket = body => {
  if (typeof body !== "string") return undefined;
  if (body.length < 200) return "short";
  if (body.length < 2000) return "medium";
  return "long";
};

// The room envelope actor is always a member id. Classify from the
// post-apply projection when available; members are human or agent, and a
// room can only be created by a human owner, so "human" is the safe default.
const classifyActor = (roomEvent, state) => {
  const rawId = roomEvent?.actorId;
  const id = typeof rawId === "string" && rawId ? rawId : "system";
  const kind = state?.members?.[id]?.kind;
  return { id, kind: kind === "agent" ? "agent" : "human" };
};

const roomIdOf = roomEvent =>
  typeof roomEvent?.roomId === "string" && roomEvent.roomId ? roomEvent.roomId : null;

const verificationKindOf = (state, workItemId) => {
  const item = state?.workItems?.[workItemId];
  if (item?.independentVerificationRequired) return "independent_review";
  if (item?.ownerDecisionRequired) return "owner_decision";
  return "none";
};

// Per-type field extraction. Each builder receives the room event, its data
// bag, and the post-apply state, and returns the C1 fields object — or null
// when the room event lacks the identifiers needed for a valid envelope.
// Only identifiers and aggregates are extracted; content bodies, titles,
// summaries, and preferences objects never leave this module.
const fieldBuilders = {
  "room.created": (roomEvent, data) => ({
    roomId: roomIdOf(roomEvent),
    roomKind: data.kind === "organization" ? "organization" : "personal"
  }),
  "member.joined": (roomEvent, data) => {
    if (typeof data.memberId !== "string" || !data.memberId) return null;
    const viaInvitation = roomEvent.type === EVENT_TYPES.MEMBER_JOINED_VIA_INVITATION;
    return {
      roomId: roomIdOf(roomEvent),
      memberId: data.memberId,
      // Invitation joins are always human (enforced by the room core);
      // direct adds carry their kind on the event data.
      memberKind: viaInvitation ? "human" : data.kind === "agent" ? "agent" : "human",
      via: viaInvitation ? "invitation" : "direct"
    };
  },
  "message.sent": (roomEvent, data) => {
    const fields = {
      roomId: roomIdOf(roomEvent),
      messageId: typeof data.messageId === "string" && data.messageId ? data.messageId : roomEvent.id
    };
    if (typeof data.replyToId === "string" && data.replyToId) fields.replyToMessageId = data.replyToId;
    const bucket = lengthBucket(data.body);
    if (bucket) fields.lengthBucket = bucket;
    return fields;
  },
  "reaction.added": (roomEvent, data) => {
    if (typeof data.messageId !== "string" || !data.messageId) return null;
    if (typeof data.reaction !== "string" || !data.reaction) return null;
    return { roomId: roomIdOf(roomEvent), messageId: data.messageId, reaction: data.reaction };
  },
  "message.pinned": (roomEvent, data) => {
    if (typeof data.messageId !== "string" || !data.messageId) return null;
    return { roomId: roomIdOf(roomEvent), messageId: data.messageId };
  },
  "work.proposed": (roomEvent, data) => {
    if (typeof data.workItemId !== "string" || !data.workItemId) return null;
    return { roomId: roomIdOf(roomEvent), workItemId: data.workItemId };
  },
  "work.completed": (roomEvent, data, state) => {
    if (typeof data.workItemId !== "string" || !data.workItemId) return null;
    return {
      roomId: roomIdOf(roomEvent),
      workItemId: data.workItemId,
      verificationKind: verificationKindOf(state, data.workItemId)
    };
  },
  "notification.preference_set": (roomEvent, data) => {
    // One growth event per room event: when several channels change at once
    // the first one wins. The envelope is account-private per the contract.
    const prefs = data.preferences;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) return null;
    const [[channel, level]] = Object.entries(prefs);
    if (typeof channel !== "string" || typeof level !== "string") return null;
    return { roomId: roomIdOf(roomEvent), channel, level };
  }
};

// Build the C1 growth envelope for a room event, or null when the room
// event type has no growth mapping (skipped silently). Throws when the
// mapped event cannot produce a valid envelope — callers that must not
// throw (applyEventWithGrowth) catch and count instead.
export function buildGrowthEvent(roomEvent, state = null) {
  if (!roomEvent || typeof roomEvent !== "object" || Array.isArray(roomEvent)) {
    throw new TypeError("room event must be an object");
  }
  const type = growthTypeFor(roomEvent.type);
  if (!type) return null;
  const data = roomEvent.data && typeof roomEvent.data === "object" && !Array.isArray(roomEvent.data)
    ? roomEvent.data
    : {};
  const fields = fieldBuilders[type](roomEvent, data, state);
  if (!fields) return null;
  return defineEvent(type, {
    actor: classifyActor(roomEvent, state),
    source: "system",
    occurredAt: roomEvent.at,
    fields
  });
}

// Wrapped choke point: applies the room event exactly as applyEvent would,
// then projects and records the growth event. The room state result is
// identical to applyEvent's — emission runs after the apply succeeds and
// can never throw into the room path.
//
// Returns { state, growthOk, growthReason } where growthOk is true when an
// event was recorded, false with a reason when the type was unmapped, the
// envelope could not be built, or the collector refused/failed it.
export function applyEventWithGrowth(current, incoming, collector) {
  const state = applyEvent(current, incoming);
  try {
    if (!collector || typeof collector.record !== "function") {
      throw new TypeError("collector must expose record()");
    }
    const envelope = buildGrowthEvent(incoming, state);
    if (!envelope) return { state, growthOk: false, growthReason: "unmapped room event type" };
    const result = collector.record(envelope);
    if (!result.ok) {
      emissionFailures += 1;
      return { state, growthOk: false, growthReason: `collector refused event: ${result.reason}` };
    }
    // C4: project @-mentions of agent members from posted messages. Mention
    // emission is best-effort and fully isolated from the primary event: a
    // detection or record failure is counted but never changes the primary
    // result, the returned state, or the room path.
    if (incoming.type === EVENT_TYPES.MESSAGE_POSTED) {
      try {
        const mentions = detectMentions(incoming, { members: state.members, actor: envelope.actor });
        for (const mention of mentions) {
          try {
            if (!collector.record(mention).ok) emissionFailures += 1;
          } catch {
            emissionFailures += 1;
          }
        }
      } catch {
        emissionFailures += 1;
      }
    }
    return { state, growthOk: true, growthReason: null };
  } catch (err) {
    emissionFailures += 1;
    return {
      state,
      growthOk: false,
      growthReason: err instanceof Error ? err.message : String(err)
    };
  }
}
