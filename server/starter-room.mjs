// First room seed: a connect card and one task with an acceptance line.
// No Room Guide, no choice checklist, no secret. The account create path
// and a later seedStarter call on an agent-created room write the same cards.
import { EVENT_TYPES } from "../src/events.js";
import { FIRST_TASK_ID, connectAgentCard, firstTaskAcceptance, firstTaskCard } from "../src/first-room-copy.js";
import { ServiceError } from "./service-error.mjs";
import { createWork } from "./work-claims.mjs";
import { emitWorkClaimEvent } from "./work-claim-events.mjs";
import { appendRoomEvent } from "./receipt-cards.mjs";

const FIRST_ROOM_TEMPLATE = "first-room";

export function starterTitleForIntent(intent) {
  const trimmed = typeof intent === "string" ? intent.trim() : "";
  return trimmed.slice(0, 80);
}

function intentKindOf(intent, start) {
  const key = typeof intent === "string" ? intent.trim().toLowerCase() : "";
  if (key === "bug" || key === "review" || key === "plan") return key;
  if (key) return "custom";
  if (start) return "start";
  return "custom";
}

function answerOf(intent, state) {
  const trimmed = typeof intent === "string" ? intent.trim().slice(0, 80) : "";
  if (trimmed) return trimmed;
  const purpose = typeof state?.room?.purpose === "string" ? state.room.purpose.trim().slice(0, 80) : "";
  if (purpose) return purpose;
  const title = typeof state?.room?.title === "string" ? state.room.title.trim().slice(0, 80) : "";
  if (title) return title;
  return "First task";
}

function putClaim(store, roomId, actorId, spec, now) {
  if (store.workClaims.has(roomId, spec.id)) return store.workClaims.get(roomId, spec.id);
  const item = createWork({
    id: spec.id,
    title: spec.title,
    tags: spec.tags,
    acceptanceCriteria: spec.acceptanceCriteria
  }, { now, agentId: actorId });
  store.workClaims.set(roomId, item);
  emitWorkClaimEvent(store, roomId, { actorId, item, action: "created", atMs: now });
  return item;
}

function postCard(store, roomId, actorId, id, body, now) {
  appendRoomEvent(store, roomId, {
    id,
    type: EVENT_TYPES.MESSAGE_POSTED,
    actorId,
    atMs: now,
    data: { messageId: id, body }
  });
}

export function seedStarter(store, roomId, { intent = null, ownerMemberId, start = false } = {}) {
  return store.transaction(() => {
    const room = store.room(roomId);
    const state = room.state;
    if (!state?.room) throw new ServiceError(404, "room_not_found", "Room not found");
    if (state.room.ownerId !== ownerMemberId) throw new ServiceError(403, "owner_required", "Only the room owner can seed a starter");
    if (!state.room.starterSeeded) {
      const now = store.now();
      const answer = answerOf(intent, state);
      const acceptance = firstTaskAcceptance(answer);
      postCard(store, roomId, ownerMemberId, `mc-${roomId}`, connectAgentCard(), now);
      postCard(store, roomId, ownerMemberId, `mt-${roomId}`, firstTaskCard(answer), now);
      putClaim(store, roomId, ownerMemberId, {
        id: FIRST_TASK_ID,
        title: answer,
        tags: ["first-task"],
        acceptanceCriteria: [acceptance]
      }, now);
      appendRoomEvent(store, roomId, {
        id: `ss-${roomId}`,
        type: EVENT_TYPES.ROOM_STARTER_SEEDED,
        actorId: ownerMemberId,
        atMs: now,
        data: { templateSlug: FIRST_ROOM_TEMPLATE, intentKind: intentKindOf(intent, start) }
      });
    }
    const seeded = store.room(roomId).state;
    return {
      roomId,
      templateSlug: seeded.room.starterSeeded?.templateSlug ?? FIRST_ROOM_TEMPLATE,
      intentKind: seeded.room.starterSeeded?.intentKind ?? intentKindOf(intent, start),
      connectMessageId: `mc-${roomId}`,
      taskMessageId: `mt-${roomId}`,
      taskClaimId: FIRST_TASK_ID
    };
  });
}

// Called from createAccountRoom when the request carries intent or start=1.
// roomId and ownerMemberId are required: an account can own more than one room.
export function seedStarterForNewAccount(store, accountId, { intent = null, templateSlug = null, roomId = null, ownerMemberId = null, start = false } = {}) {
  void accountId;
  void templateSlug;
  if (!roomId || !ownerMemberId) return null;
  if (!intent && !start && !templateSlug) return null;
  return seedStarter(store, roomId, { intent, ownerMemberId, start: Boolean(start) });
}
