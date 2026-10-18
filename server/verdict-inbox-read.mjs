// CD-01 (COMP-DEEP #1): the store-facing fan-out behind
// GET /api/verdict-inbox. The pure section builder lives in
// server/verdict-inbox.mjs; this module assembles its inputs per room
// (claims, members, room owner, room config) for the rooms the caller has
// already authorised, and injects Lane B's CD-06 follow records
// (Contract F) when that provider is present on the store.
//
// Contract F consumption: CD-06 (Lane B) shipped claimFollowTotals +
// listClaimFollows in server/claim-follows.mjs — per-member totals
// { followedClaims, unreadClaims, unreadEvents, mentions } and per-claim
// follow records { claimId, roomId, policy, unreadCount, mentionCount }.
// This PR lands after CD-06, so the import is direct. A generic
// store-surface probe remains as a fallback for alternate wirings; if
// neither answers, follow reads as null — never as invented zeroes.
import { buildVerdictInbox } from "./verdict-inbox.mjs";
import { claimFollowTotals, listClaimFollows } from "./claim-follows.mjs";
import { ownMember } from "../src/events.js";

const MAX_ROOMS = 40;

function followForRoom(store, roomId, memberId) {
  try {
    const totals = claimFollowTotals(store.db, { roomId, memberId });
    if (totals && typeof totals === "object") {
      const claims = listClaimFollows(store.db, { roomId, memberId })
        .filter(row => row && typeof row.claimId === "string")
        .map(row => ({
          claimId: row.claimId,
          roomId: typeof row.roomId === "string" ? row.roomId : roomId,
          ...(row.policy ? { policy: row.policy } : {}),
          ...(Number.isSafeInteger(row.unreadCount) ? { unreadCount: row.unreadCount } : {}),
          ...(Number.isSafeInteger(row.mentionCount) ? { mentionCount: row.mentionCount } : {}),
        }));
      return { totals, claims };
    }
  } catch { /* fall through to the generic probe */ }
  const providers = [store.followRecords, store.claimFollows, store.follows].filter(Boolean);
  for (const provider of providers) {
    try {
      if (typeof provider.totalsFor !== "function") continue;
      const totals = provider.totalsFor(memberId, roomId) ?? provider.totalsFor(memberId);
      if (!totals || typeof totals !== "object") continue;
      let claims = [];
      if (typeof provider.listForMember === "function") {
        const rows = provider.listForMember(memberId, roomId) ?? [];
        if (Array.isArray(rows)) {
          claims = rows.filter(row => row && typeof (row.claimId ?? row.claim_id) === "string").map(row => ({
            claimId: row.claimId ?? row.claim_id,
            roomId: typeof row.roomId === "string" ? row.roomId : roomId,
            ...(row.policy ? { policy: row.policy } : {}),
            ...(Number.isSafeInteger(row.unreadCount) ? { unreadCount: row.unreadCount } : {}),
            ...(Number.isSafeInteger(row.mentionCount) ? { mentionCount: row.mentionCount } : {}),
          }));
        }
      }
      return { totals, claims };
    } catch { /* a broken follow provider must not blank the inbox */ }
  }
  return null;
}

// memberByRoom: Map<roomId, memberId> the route resolved for the viewer
// (account-session memberships on the human door, identity seats on the
// agent door). A room whose read throws is skipped and named in
// roomErrors — the overview's partial-failure contract (#3342), never a
// 500 for one broken room.
export function collectVerdictInbox(store, { memberByRoom, surface = "human", nowMs = Date.now() } = {}) {
  if (!store) throw new TypeError("collectVerdictInbox needs a store");
  const rooms = [];
  const roomErrors = [];
  for (const [roomId, memberId] of [...(memberByRoom ?? new Map())].slice(0, MAX_ROOMS)) {
    try {
      const state = store.room(roomId).state;
      const archived = store.db.prepare("SELECT archived_at AS archivedAt FROM rooms WHERE id=?").get(roomId)?.archivedAt;
      if (archived) continue;
      const member = ownMember(state.members ?? {}, memberId);
      if (!member || member.active === false) continue;
      let claims = [];
      try { claims = store.workClaims?.list(roomId) ?? []; } catch { claims = []; }
      let config = null;
      try { config = store.workClaims?.configFor(roomId) ?? null; } catch { config = null; }
      rooms.push({
        roomId,
        viewerId: memberId,
        claims,
        members: state.members ?? {},
        roomOwnerId: state.room?.ownerId ?? null,
        ...(config ? { config } : {}),
        follow: followForRoom(store, roomId, memberId),
      });
    } catch (error) {
      roomErrors.push({ roomId, error: typeof error?.code === "string" ? error.code : "room_read_failed" });
    }
  }
  const inbox = buildVerdictInbox({ rooms, nowMs, surface });
  return Object.freeze({ ...inbox, roomErrors: Object.freeze(roomErrors) });
}
