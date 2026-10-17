// Shared membership enumeration for agent read surfaces (bug sweep
// 2026-10-16, lane 08 F-4 / issue #3882).
//
// An identity holds a room seat through identity_links — except trial
// seats (guests), who are seated through guest_members and never receive
// an identity_links row. Read surfaces that enumerate "my rooms" from
// identity_links alone silently drop every trial seat: the needs-me
// inbox, the agent-rooms list, and the capability catalog each did their
// own links-only query and drifted into the same omission (the wake legs
// had already converged on server/wake-identity-resolution.mjs for the
// per-room member<->identity direction). Enumeration now goes through
// this module — identity_links first, guest_members as the fallback —
// so every surface counts a guest seat as a membership.
//
// One seat per room: when an identity somehow holds both rows in a room
// (a guest seat alongside a later link), the link seat wins — full
// membership supersedes the trial seat, and the surfaces' live-member
// rechecks arbitrate which member record is actually active.
//
// This module ENUMERATES seats only; it grants nothing. Each surface
// keeps its own live-membership recheck (room authority / room state)
// before serving a room, exactly as before. Deliberately NOT used by
// identityIdForMember / resolveIdentityLink (the auth and work-wake
// primitives): trial seats stay excluded from work wakes (decision #25
// boundary) and link-based auth is unchanged.
//
// Both lookups are defensive against pre-schema databases (a missing
// table reads as "no seats", never a throw), matching the wake
// resolver's posture.

function seatRows(db, sql, identityId) {
  try {
    return db.prepare(sql).all(identityId);
  } catch {
    return [];
  }
}

// Every seat an identity holds, as [{ roomId, memberId, seat }] with
// seat "link" (identity_links) or "guest" (guest_members), ordered by
// roomId. `after` is an exclusive roomId cursor and `limit` caps the
// page, mirroring the keyset pagination the surfaces used in SQL.
export function identityRoomSeats(db, identityId, { after = "", limit = null } = {}) {
  if (!db || typeof identityId !== "string" || !identityId) return [];
  const byRoom = new Map();
  for (const row of seatRows(db,
    "SELECT room_id AS roomId, member_id AS memberId FROM identity_links WHERE identity_id=?",
    identityId)) {
    byRoom.set(row.roomId, { roomId: row.roomId, memberId: row.memberId, seat: "link" });
  }
  for (const row of seatRows(db,
    "SELECT room_id AS roomId, member_id AS memberId FROM guest_members WHERE guest_identity_id=?",
    identityId)) {
    if (!byRoom.has(row.roomId)) {
      byRoom.set(row.roomId, { roomId: row.roomId, memberId: row.memberId, seat: "guest" });
    }
  }
  const seats = [...byRoom.values()]
    .filter(seat => typeof seat.roomId === "string" && seat.roomId > after)
    .sort((a, b) => (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0));
  return limit == null ? seats : seats.slice(0, Math.max(0, limit));
}
