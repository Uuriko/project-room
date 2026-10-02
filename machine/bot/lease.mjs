// Phase 0 slot rule, the same one RELAY-0 uses: a board file
// `resource/<machineId>/<slot>` on an active, unexpired kind:"work" claim
// holds that slot. The earliest claimedAt wins. Room also refuses a second
// live claim on the same file, so the bot never asks for a slot someone
// else already holds.

const ACTIVE = new Set(["claimed", "in_progress", "blocked"]);

function holds(claim, machineId, slot, now) {
  if (!claim || claim.kind !== "work") return false;
  if (!ACTIVE.has(claim.state)) return false;
  if (claim.leaseExpiresAt) {
    const expiry = Date.parse(claim.leaseExpiresAt);
    if (Number.isFinite(expiry) && expiry <= now) return false;
  }
  const label = `resource/${machineId}/${slot}`;
  return Array.isArray(claim.files) && claim.files.includes(label);
}

export function slotHolder(claims, machineId, slot, now) {
  const matches = (Array.isArray(claims) ? claims : []).filter(claim => holds(claim, machineId, slot, now));
  matches.sort((left, right) => {
    const delta = Date.parse(left.claimedAt ?? 0) - Date.parse(right.claimedAt ?? 0);
    if (delta !== 0) return delta;
    return String(left.id).localeCompare(String(right.id));
  });
  return matches[0] ?? null;
}

export function pickSlot(claims, machineId, memberId, now) {
  for (const slot of ["desk", "scratch"]) {
    const holder = slotHolder(claims, machineId, slot, now);
    if (!holder) return { slot, existing: null };
    if (holder.owner === memberId) return { slot, existing: holder };
  }
  return { slot: null, existing: null };
}

export function slotLabel(machineId, slot) {
  return `resource/${machineId}/${slot}`;
}
