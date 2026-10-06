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
import { EVENT_TYPES, WORK_CLAIM_EVENT_ACTIONS, applyEvent, event, firstBlockedWakeTarget, isRoomArchived } from "../src/events.js";
import { getTier } from "./autonomy-tiers.mjs";
import { postReceiptCard } from "./receipt-cards.mjs";
import { resolveNamedReviewers, hasCurrentReview } from "./work-claims.mjs";

export const WORK_CLAIM_ACTIONS = WORK_CLAIM_EVENT_ACTIONS;

// A title of only whitespace is a legal claim (the state machine stores it)
// but the event envelope rejects a blank string. Fall back to the id so the
// claim write is not rolled back by its own receipt.
const eventTitle = item => {
  const title = typeof item.title === "string" ? item.title : "";
  return title.trim() ? title : item.id;
};

export function workClaimEventData(item, action, { previousOwnerId = null, paths = undefined, pullRequest = undefined, reason = undefined, ciState = undefined, verdict = undefined, attention = undefined, attentionMemberId = undefined } = {}) {
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
  // Updates reads attention on this event. A paused or read-only assignee
  // still gets the item; the wake below is what pause and autonomy skip.
  if (attention) data.attention = attention;
  if (attentionMemberId) data.attentionMemberId = attentionMemberId;
  return data;
}

// CI success/failure, a changes-requested review, an assignment, and a lease
// expiry wake the member through the existing agent wake queue. The queue
// accepts mention and dm; these signals use mention, and messageId starts
// with "work-claim:{id}:{reason}:" so a host can tell them from a chat
// mention and triage on reason. A bad id never rolls back the claim.
//
// Pause (wake_queue_pause) and a t1_readonly tier skip the wake. The room
// event still carries attention, so Updates still lists the assignment.
// Room trust off skips a cross-owner agent wake the same way a mention does.
// The queue coalesces on message id, which is the per-signal rate limit
// this path already has.
function linkedIdentityId(store, roomId, memberId) {
  try {
    return store.db.prepare(
      "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?"
    ).get(roomId, memberId)?.identityId ?? null;
  } catch {
    return null;
  }
}

function claimWakeSkip(store, roomId, memberId, actorId) {
  try {
    if (store.wakeQueue?.pauseStatus?.(roomId, memberId)) return "paused";
  } catch { /* pause table absent on a partial store */ }
  try {
    if (getTier(store.db, roomId, memberId)?.autonomyTier === "t1_readonly") return "readonly";
  } catch { /* tier table absent */ }
  try {
    if (actorId && typeof store.room === "function") {
      const state = store.room(roomId)?.state;
      if (state && firstBlockedWakeTarget(state, actorId, [memberId])) return "trust";
    }
  } catch { /* room unread */ }
  return null;
}

export function enqueueClaimWake(store, roomId, memberId, messageId, { reason, actorId } = {}) {
  if (!store?.agentHeartbeats || typeof memberId !== "string" || typeof messageId !== "string") return null;
  const skipped = claimWakeSkip(store, roomId, memberId, actorId);
  if (skipped) return { enqueued: false, skipped };
  const parts = messageId.startsWith("work-claim:") ? messageId.split(":") : [];
  const derivedReason = reason ?? (parts.length >= 3 ? parts[2] : undefined);
  const workClaim = parts.length >= 2 ? parts[1] : undefined;
  const identityId = linkedIdentityId(store, roomId, memberId);
  const agentId = identityId ?? memberId;
  try {
    const result = store.agentHeartbeats.enqueueWake({ agentId, kind: "mention", roomId, messageId });
    if (result?.enqueued && identityId && store.agentPlugin?.deliverWakePing) {
      const signal = {
        ...result.signal,
        ...(derivedReason ? { reason: derivedReason } : {}),
        ...(workClaim ? { workClaim } : {})
      };
      store.agentPlugin.deliverWakePing({ identityId, signal });
    }
    return result;
  } catch (error) {
    console.error("work claim wake failed:", error?.message ?? error);
    return null;
  }
}

// hw-h2-needs-me-review-asks (3): one wake per new head for each reviewer the
// item names (tag rev-<memberId>) who has not reviewed that head yet. Ready
// means in_progress or a linked PR, the same rule as needs-me reviewAsks. The
// message id carries the head, so repeats coalesce and a new head wakes again.
export function wakeNamedReviewers(store, roomId, item, { actorId } = {}) {
  if (!item || item.state === "done" || !item.owner || item.supersededBy) return [];
  if (!(item.state === "in_progress" || item.pullRequest || (item.pullRequests ?? []).length)) return [];
  const head = item.ci?.headSha ?? item.revision ?? item.claimedAt ?? "none";
  let members = {};
  try { members = (store.roomAuthority?.(roomId) ?? store.room(roomId)?.state)?.members ?? {}; } catch { return []; }
  return resolveNamedReviewers(item, members).filter(memberId => memberId !== item.owner && !hasCurrentReview(item, memberId))
    .map(memberId => enqueueClaimWake(store, roomId, memberId, `work-claim:${item.id}:review:${head}`,
      { reason: "review", actorId: actorId ?? item.owner }));
}

// SEC-2 / Q3-A event budget: note-only writes (a note on a held claim, a
// review note, a lease renewal) coalesce into at most one room event per
// claim and action per 60 s. The claim row still records every write and the
// next event carries the latest state. Transitions, assignments, verdicts
// and PR facts are never coalesced. Memory only, per store: a restart allows
// one extra event per claim, which keeps the bound.
export const CLAIM_EVENT_COALESCE_MS = 60_000;
const CLAIM_EVENT_MEMORY = 10_000;
const lastClaimEvent = new WeakMap();

function noteClaimEvent(store, key, atMs) {
  let seen = lastClaimEvent.get(store);
  if (!seen) { seen = new Map(); lastClaimEvent.set(store, seen); }
  seen.delete(key);
  seen.set(key, atMs);
  if (seen.size > CLAIM_EVENT_MEMORY) seen.delete(seen.keys().next().value);
}

const coalesceKey = (roomId, claimId, action) => `${roomId}\u0000${claimId}\u0000${action}`;

export function claimEventCoalesced(store, roomId, claimId, action, atMs) {
  const at = store && typeof store === "object" ? lastClaimEvent.get(store)?.get(coalesceKey(roomId, claimId, action)) : undefined;
  return Number.isFinite(at) && atMs - at >= 0 && atMs - at < CLAIM_EVENT_COALESCE_MS;
}

// Handler unit tests drive the routes with a registry-only store; events need
// the real event log, so a store without one records nothing here.
export function emitWorkClaimEvent(store, roomId, { actorId, item, action, previousOwnerId = null, atMs = null, paths = undefined, pullRequest = undefined, reason = undefined, ciState = undefined, verdict = undefined, attention = undefined, attentionMemberId = undefined, coalesce = false }) {
  if (!store?.db || typeof store.room !== "function") return null;
  const stamp = Number.isFinite(atMs) ? atMs : (typeof store.now === "function" ? store.now() : Date.now());
  if (coalesce && claimEventCoalesced(store, roomId, item.id, action, stamp)) return null;
  const room = store.room(roomId);
  // The event log refuses anything after archive (applyEvent throws). Skip
  // the receipt so the claim write still commits; an archived room has no
  // live timeline to update.
  if (isRoomArchived(room.state)) return null;
  const actor = room.state.members?.[actorId];
  const incoming = event({
    id: randomUUID(),
    idempotencyKey: randomUUID(),
    type: EVENT_TYPES.WORK_CLAIM_UPDATED,
    actorId: actor && actor.active !== false ? actorId : room.state.room.ownerId,
    roomId,
    at: new Date(stamp).toISOString(),
    data: workClaimEventData(item, action, { previousOwnerId, paths, pullRequest, reason, ciState, verdict, attention, attentionMemberId })
  });
  if (actor?.system === true) incoming.data.actorKind = "system";
  const state = applyEvent(room.state, incoming);
  const sequence = room.sequence + 1;
  store.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
  const compact = { ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} };
  store.db.prepare("UPDATE rooms SET sequence=?, projection=? WHERE id=?").run(sequence, JSON.stringify(compact), roomId);
  if (coalesce) noteClaimEvent(store, coalesceKey(roomId, item.id, action), stamp);
  try {
    if (store.agentPlugin) store.agentPlugin.fanoutRoomEvent({ roomId, event: incoming });
  } catch (error) {
    console.error("work claim fan-out failed:", error?.message ?? error);
  }
  // ACT-1a: in-room receipt for every done claim (result, merged, production).
  // Posted here, not in the Board done branch, while BF is open on work-claim-routes.
  // A receipt failure must not roll back the claim.
  if (action === "state_changed" && item.state === "done") {
    try { postReceiptCard(store, roomId, item, stamp); }
    catch (error) { console.error("work claim receipt card failed:", error?.message ?? error); }
  }
  return { sequence, event: incoming };
}
