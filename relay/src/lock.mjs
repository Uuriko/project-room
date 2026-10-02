// Phase 0 slot lock. Room still only warns on overlapping files. Of the
// active, unexpired work claims whose files include resource/<machine>/<slot>,
// the earliest claimedAt holds the slot. A later claim, a done claim, an
// expired lease, or a different slot does not take it.

import { ACTIVE_STATES, isSlot } from "./protocol.mjs";

function expiryMs(claim) {
  if (claim?.leaseExpiresAt == null) return null;
  const ms = Date.parse(claim.leaseExpiresAt);
  return Number.isFinite(ms) ? ms : null;
}

export function isActiveWorkClaim(claim, now) {
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) return false;
  if (claim.kind !== "work") return false;
  if (!ACTIVE_STATES.has(claim.state)) return false;
  if (typeof claim.id !== "string" || claim.id.length === 0) return false;
  if (typeof claim.owner !== "string" || claim.owner.length === 0) return false;
  if (typeof claim.claimedAt !== "string" || !Number.isFinite(Date.parse(claim.claimedAt))) return false;
  const expiry = expiryMs(claim);
  if (expiry !== null && expiry <= now) return false;
  return true;
}

export function slotOf(claim, machineId) {
  const prefix = `resource/${machineId}/`;
  if (!Array.isArray(claim?.files)) return null;
  const matches = claim.files.filter(file => typeof file === "string" && file.startsWith(prefix) && !file.slice(prefix.length).includes("/"));
  if (matches.length !== 1) return null;
  const slot = matches[0].slice(prefix.length);
  return isSlot(slot) ? slot : null;
}

export function holdersForMachine(claims, machineId, now) {
  const grouped = new Map();
  for (const claim of Array.isArray(claims) ? claims : []) {
    if (!isActiveWorkClaim(claim, now)) continue;
    const slot = slotOf(claim, machineId);
    if (!slot) continue;
    const list = grouped.get(slot) ?? [];
    list.push(claim);
    grouped.set(slot, list);
  }
  const winners = new Map();
  for (const [slot, list] of grouped) {
    list.sort((left, right) => {
      const delta = Date.parse(left.claimedAt) - Date.parse(right.claimedAt);
      if (delta !== 0) return delta;
      if (left.id === right.id) return 0;
      return left.id < right.id ? -1 : 1;
    });
    winners.set(slot, list[0]);
  }
  return winners;
}
