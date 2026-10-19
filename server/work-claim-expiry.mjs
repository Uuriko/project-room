// Work-claim lease expiry (Fix Programme v2, RP-1; cures RC-1).
//
// A lease lapse is a fact about stored state, and materialising it — the
// released claim row, the lease_expired room event, the former owner's one
// wake — is state maintenance. Programme law (RP-RULE): state maintenance
// never rides a read. The stored sweep therefore runs only where
// maintenance belongs:
//
//   * at store open (sweepExpiredWorkClaimLeasesAtOpen, called by
//     RoomStore next to the work-item board backfill), and
//   * on write requests through the work-claims handler (the explicit
//     sweep route and every mutation), via sweepExpiredWorkClaimLeases.
//
// Reads never sweep. A read that finds a claim whose lease has lapsed
// presents the pure releaseExpired form in memory
// (presentWithLapsedLeases) — byte-identical to what the stored sweep
// would have persisted — and persists nothing, emits no event, and fires
// no wake. The stored form converges at the next open or write. This is
// the RP-3 pattern (derived status on read, stored transition by the next
// writer or at open) applied to claim leases.
//
// The per-release side effects are exactly the ones the request-time
// sweep performed before RP-1: one registry write, one lease_expired
// room event attributed to the former owner, and one wake under the
// coalescing message id work-claim:<id>:lease_expired:<leaseExpiresAt>,
// so a lapse is still announced exactly once however it materialises.
import { ACTIVE_CLAIM_STATES, releaseExpired } from "./work-claims.mjs";
import { emitWorkClaimEvent, enqueueClaimWake } from "./work-claim-events.mjs";

// The lapsed subset of `items`, paired with the released form the stored
// sweep would persist. Selection mirrors the pre-RP-1 request sweep
// exactly: active claims whose leaseExpiresAt is at or before nowMs, and
// of those only the ones releaseExpired actually transitions to
// unclaimed. Pure: inputs are never mutated.
export function lapsedLeaseReleases(items, nowMs) {
  const expired = items.filter(item => ACTIVE_CLAIM_STATES.includes(item?.state)
    && typeof item?.leaseExpiresAt === "string"
    && Date.parse(item.leaseExpiresAt) <= nowMs);
  if (expired.length === 0) return [];
  const released = releaseExpired(expired, nowMs);
  const pairs = [];
  for (let index = 0; index < expired.length; index += 1) {
    if (expired[index].state !== "unclaimed" && released[index].state === "unclaimed") {
      pairs.push({ before: expired[index], item: released[index] });
    }
  }
  return pairs;
}

// Present a stored item list as a reader must see it at nowMs: lapsed
// claims in their released form, everything else the stored object
// untouched. Returns the presented list and the ids this presentation
// releases (what a stored sweep at the same instant would report).
export function presentWithLapsedLeases(items, nowMs) {
  const pairs = lapsedLeaseReleases(items, nowMs);
  if (pairs.length === 0) return { items, releasedIds: [] };
  const releasedById = new Map(pairs.map(({ before, item }) => [before.id, item]));
  return {
    items: items.map(item => releasedById.get(item?.id) ?? item),
    releasedIds: pairs.map(({ before }) => before.id),
  };
}

// The stored sweep: persist every lapsed release in the room's registry,
// emitting the lease_expired event and the former owner's wake per
// release. Callers own the surrounding transaction (the work-claims
// handler's request transaction on writes; a per-room transaction at
// store open). Returns the released claim ids, in registry order.
export function sweepExpiredWorkClaimLeases(store, registry, roomId, nowMs) {
  const pairs = lapsedLeaseReleases(registry.list(roomId), nowMs);
  for (const { before, item } of pairs) {
    registry.set(roomId, item);
    const receipt = emitWorkClaimEvent(store, roomId, {
      actorId: before.owner, item, action: "lease_expired",
      previousOwnerId: before.owner, atMs: nowMs, paths: before.files ?? [],
    });
    // One wake per expiry. The message id includes the lapsed lease time,
    // so a later claim that expires again wakes again, and a repeat sweep
    // of this lapse coalesces.
    enqueueClaimWake(store, roomId, before.owner,
      `work-claim:${item.id}:lease_expired:${before.leaseExpiresAt ?? receipt?.sequence ?? nowMs}`,
      { reason: "lease_expired", actorId: before.owner });
  }
  return pairs.map(({ before }) => before.id);
}

// Store-open pass: run the stored sweep for every room, one transaction
// per room, so leases that lapsed while the store was closed are already
// materialised before the first read. Bounded by the lapsed set — a
// converged store releases nothing and writes nothing. A failing room
// never bricks the open (the board backfill's discipline): the error is
// reported in the result and the next open retries the room.
export function sweepExpiredWorkClaimLeasesAtOpen(store, nowMs) {
  const report = { rooms: 0, released: 0, releasedIds: [], errors: [] };
  let roomIds = [];
  try {
    roomIds = store.db.prepare("SELECT id FROM rooms ORDER BY id").all().map(row => row.id);
  } catch (error) {
    report.errors.push({ roomId: null, message: error?.message ?? String(error) });
    return report;
  }
  for (const roomId of roomIds) {
    report.rooms += 1;
    try {
      const releasedIds = store.transaction(() =>
        sweepExpiredWorkClaimLeases(store, store.workClaims, roomId, nowMs));
      report.released += releasedIds.length;
      report.releasedIds.push(...releasedIds);
    } catch (error) {
      report.errors.push({ roomId, message: error?.message ?? String(error) });
    }
  }
  return report;
}
