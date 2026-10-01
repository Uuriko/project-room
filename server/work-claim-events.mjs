// Work-claim room events. A claim, renewal, handoff or release used to change
// only the work_claims table: nobody saw it in the room, the event tail, the
// digest or an agent's wake feed, so agents re-announced every claim in chat.
// Each committed claim change now appends one thin `work_claim.updated` room
// event, attributed to the member who made it. The work_claims table stays the
// source of truth; the event carries a pointer and the state a reader needs.
// (claimState, not state: the envelope reserves data.state for land.updated.)
//
// Same append path as the land queue (server/land-queue.mjs #emit): the event
// row and the projection update run inside the caller's claim transaction, so
// a claim and its event commit or roll back together.
import { randomUUID } from "node:crypto";
import { EVENT_TYPES, WORK_CLAIM_EVENT_ACTIONS, applyEvent, event } from "../src/events.js";

export const WORK_CLAIM_ACTIONS = WORK_CLAIM_EVENT_ACTIONS;

export function workClaimEventData(item, action, { previousOwnerId = null } = {}) {
  if (!WORK_CLAIM_ACTIONS.includes(action)) throw new Error(`Unknown work claim action: ${action}`);
  return {
    workClaim: item.id,
    action,
    claimState: item.state,
    ownerId: item.owner ?? null,
    ...(previousOwnerId ? { previousOwnerId } : {}),
    leaseExpiresAt: item.leaseExpiresAt ?? null,
    title: item.title ?? item.id,
    paths: [...(item.files ?? [])]
  };
}

// Handler unit tests drive the routes with a registry-only store; events need
// the real event log, so a store without one records nothing here.
export function emitWorkClaimEvent(store, roomId, { actorId, item, action, previousOwnerId = null }) {
  if (!store?.db || typeof store.room !== "function") return null;
  const room = store.room(roomId);
  const actor = room.state.members?.[actorId];
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.WORK_CLAIM_UPDATED,
    actorId: actor && actor.active !== false ? actorId : room.state.room.ownerId,
    roomId,
    at: new Date(typeof store.now === "function" ? store.now() : Date.now()).toISOString(),
    data: workClaimEventData(item, action, { previousOwnerId })
  });
  const state = applyEvent(room.state, incoming);
  const sequence = room.sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, JSON.stringify(compact), roomId);
  try {
    if (store.agentPlugin) store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
  } catch (error) {
    console.error("work claim fan-out failed:", error?.message ?? error);
  }
  return { sequence, event: incoming };
}
