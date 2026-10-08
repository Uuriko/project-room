// Work-claim digest (FIX-69: event-light claim writes).
//
// The room event log has a lifetime budget of 10,000 events, and every
// committed claim write used to append one work_claim.updated event (~6.5
// per claim lifecycle) — at 200 agents x 1 lifecycle/hour the budget gated
// in ~3h, halting all claiming room-wide. Routine claim lifecycle
// transitions now batch here instead: one work_claim.digest room event per
// room per window, carrying per-action counts and the latest transition per
// claim. Only decision-grade signals (attention, review verdicts) still emit
// a per-transition work_claim.updated event, via emitWorkClaimEventRouted.
//
// The buffer is memory-only per store (like the retired 60s coalesce map):
// a restart drops at most one window of routine transitions. The claim rows
// stay the source of truth, so nothing is lost but tail visibility.
import { WORK_CLAIM_EVENT_ACTIONS } from "../src/events.js";

export const WORK_CLAIM_DIGEST_WINDOW_MS = 5 * 60 * 1000;
export const WORK_CLAIM_DIGEST_MAX_CLAIMS = 64;

const buffers = new WeakMap(); // store -> Map(roomId -> buffer)

const bufferFor = (store, roomId) => {
  let rooms = buffers.get(store);
  if (!rooms) { rooms = new Map(); buffers.set(store, rooms); }
  let buffer = rooms.get(roomId);
  if (!buffer) {
    buffer = { windowStart: null, counts: new Map(), claims: new Map() };
    rooms.set(roomId, buffer);
  }
  return buffer;
};

// Record one routine transition. Keeps per-action counts and the latest
// transition per claim (id -> { action, item, actorId, atMs, paths,
// previousOwnerId }).
export function accumulateClaimDigest(store, roomId, { action, item, actorId = null, atMs = null, paths = undefined, previousOwnerId = null } = {}) {
  if (!store || typeof store !== "object" || typeof roomId !== "string") return;
  if (!WORK_CLAIM_EVENT_ACTIONS.includes(action)) throw new Error(`Unknown work claim action: ${action}`);
  const buffer = bufferFor(store, roomId);
  const stamp = Number.isFinite(atMs) ? atMs : Date.now();
  if (buffer.windowStart === null) buffer.windowStart = stamp;
  buffer.counts.set(action, (buffer.counts.get(action) ?? 0) + 1);
  // Latest action per claim wins; the digest is a visibility batch, not a journal.
  buffer.claims.delete(item.id);
  buffer.claims.set(item.id, { action, item, actorId, atMs: stamp, previousOwnerId,
    paths: Array.isArray(paths) ? [...paths] : [...(item.files ?? [])] });
}

// True when the buffer holds transitions from a window that has lapsed.
export function claimDigestDue(store, roomId, nowMs) {
  const buffer = buffers.get(store)?.get(roomId);
  if (!buffer || buffer.windowStart === null || buffer.claims.size === 0) return false;
  return nowMs - buffer.windowStart >= WORK_CLAIM_DIGEST_WINDOW_MS;
}

// Remove and return the buffer's contents for one digest event. Claims are
// capped so the event stays small; counts are exact regardless.
export function takeClaimDigest(store, roomId, nowMs) {
  const buffer = buffers.get(store)?.get(roomId);
  if (!buffer) return null;
  buffers.get(store).delete(roomId);
  const stamp = Number.isFinite(nowMs) ? nowMs : Date.now();
  const entries = [...buffer.claims.values()].slice(0, WORK_CLAIM_DIGEST_MAX_CLAIMS);
  return {
    windowStart: new Date(buffer.windowStart).toISOString(),
    windowEnd: new Date(stamp).toISOString(),
    actorId: entries.length > 0 ? entries[entries.length - 1].actorId : null,
    counts: Object.fromEntries(buffer.counts),
    claims: entries,
  };
}

// Thin per-claim entry for the digest event body.
export const claimDigestEntryData = ({ action, item, atMs, paths, previousOwnerId }) => ({
  workClaim: item.id,
  action,
  claimState: item.state,
  ownerId: item.owner ?? null,
  ...(previousOwnerId ? { previousOwnerId } : {}),
  title: typeof item.title === "string" && item.title.trim() ? item.title : item.id,
  at: new Date(atMs).toISOString(),
  paths: [...paths],
});

export function claimDigestEventData(digest) {
  return {
    windowStart: digest.windowStart,
    windowEnd: digest.windowEnd,
    digestCounts: { ...digest.counts },
    digestClaims: digest.claims.map(claimDigestEntryData),
  };
}
