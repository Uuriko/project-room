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
import { EVENT_TYPES, WORK_CLAIM_EVENT_ACTIONS, applyEvent, event, isRoomArchived } from "../src/events.js";

export const WORK_CLAIM_ACTIONS = WORK_CLAIM_EVENT_ACTIONS;

// A title of only whitespace is a legal claim (the state machine stores it)
// but the event envelope rejects a blank string. Fall back to the id so the
// claim write is not rolled back by its own receipt.
const eventTitle = item => {
  const title = typeof item.title === "string" ? item.title : "";
  return title.trim() ? title : item.id;
};

export function workClaimEventData(item, action, { previousOwnerId = null, paths = undefined, pullRequest = undefined, reason = undefined, ciState = undefined, verdict = undefined } = {}) {
  if (!WORK_CLAIM_ACTIONS.includes(action)) throw new Error(`Unknown work claim action: ${action}`);
  // Release and lease expiry clear files on the item. Callers pass the paths
  // that were held so the receipt still says which lane opened up.
  const listed = paths === undefined ? (item.files ?? []) : paths;
  if (!Array.isArray(listed)) throw new Error("Work claim paths must be a list");
  const data = {
    workClaim: item.id,
    action,
    claimState: item.state,
    ownerId: item.owner ?? null,
    ...(previousOwnerId ? { previousOwnerId } : {}),
    leaseExpiresAt: item.leaseExpiresAt ?? null,
    title: eventTitle(item),
    paths: [...listed]
  };
  if (action === "pr_merged" || action === "pr_closed") {
    const pull = pullRequest ?? item.pullRequest;
    data.pullRequest = {
      url: pull?.url,
      outcome: action === "pr_merged" ? "merged" : "closed"
    };
  }
  if (reason) data.reason = reason;
  if (ciState) data.ciState = ciState;
  if (verdict) data.verdict = verdict;
  return data;
}

// CI success/failure and a changes-requested review wake the claim owner
// through the existing agent wake queue. The queue accepts mention and dm;
// these signals use mention, and messageId starts with "work-claim:" so a
// host can tell them from a chat mention. A bad id never rolls back the claim.
export function enqueueClaimWake(store, roomId, agentId, messageId) {
  if (!store?.agentHeartbeats || typeof agentId !== "string" || typeof messageId !== "string") return null;
  try {
    return store.agentHeartbeats.enqueueWake({ agentId, kind: "mention", roomId, messageId });
  } catch (error) {
    console.error("work claim wake failed:", error?.message ?? error);
    return null;
  }
}

// Handler unit tests drive the routes with a registry-only store; events need
// the real event log, so a store without one records nothing here.
export function emitWorkClaimEvent(store, roomId, { actorId, item, action, previousOwnerId = null, atMs = null, paths = undefined, pullRequest = undefined, reason = undefined, ciState = undefined, verdict = undefined }) {
  if (!store?.db || typeof store.room !== "function") return null;
  const room = store.room(roomId);
  // The event log refuses anything after archive (applyEvent throws). Skip
  // the receipt so the claim write still commits; an archived room has no
  // live timeline to update.
  if (isRoomArchived(room.state)) return null;
  const actor = room.state.members?.[actorId];
  const stamp = Number.isFinite(atMs) ? atMs : (typeof store.now === "function" ? store.now() : Date.now());
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.WORK_CLAIM_UPDATED,
    actorId: actor && actor.active !== false ? actorId : room.state.room.ownerId,
    roomId,
    at: new Date(stamp).toISOString(),
    data: workClaimEventData(item, action, { previousOwnerId, paths, pullRequest, reason, ciState, verdict })
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
