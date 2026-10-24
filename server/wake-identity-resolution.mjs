// Guest-aware identity resolution for the wake legs (decision #25).
//
// A room member resolves to an agent identity through identity_links —
// except trial seats (guests), who are seated through guest_members and
// never receive an identity_links row. Each wake leg originally did its
// own lookup and they drifted: the mention fan-out grew a local
// guest_members fallback (#3230), while the reaction-ack path (#3764)
// and the webhook fan-out (#3777) kept resolving identity_links only, so
// guest reaction acks silently no-oped (the wake re-fired on every poll)
// and guest webhook subscriptions silently received no room events. All
// wake legs now resolve through this module — identity_links first,
// guest_members as the fallback — so a trial seat's mention wake and
// webhook deliveries resolve the same identity. (The third leg, the
// reaction ack, was later removed with reactions.)
//
// Deliberately NOT used by identityIdForMember (the work-wake resolver
// in server/agent-identities.mjs): work wakes stay excluded for trial
// seats (decision #25 boundary).
//
// Both lookups are defensive against pre-schema databases (a missing
// table reads as "no resolution", never a throw), matching the wake
// legs' existing never-throw posture.

function getRow(db, sql, roomId, key) {
  try {
    return db.prepare(sql).get(roomId, key);
  } catch {
    return undefined;
  }
}

// member -> identity, for the mention fan-out and the reaction-ack path.
export function identityIdForWakeMember(db, roomId, memberId) {
  if (!db || !roomId || !memberId) return null;
  const link = getRow(db,
    "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (link?.identityId) return link.identityId;
  const guest = getRow(db,
    "SELECT guest_identity_id AS identityId FROM guest_members WHERE room_id=? AND member_id=?",
    roomId, memberId);
  return guest?.identityId ?? null;
}

// Provenance-classified member -> identity resolution for the presence
// reads (PRESENCE-PRIM, MIG-PRESENCE Gap 3). store.presence() resolved
// host status through identity_links alone, so guest seats, stamped-
// identity seats with no link row (the key/grant admission class), and
// sponsored seats read a silent presence:null even when the agent behind
// the seat had live hosts. presenceSeatForMember names the seat's
// provenance and the identity behind it (or the absence of one), in the
// precedence the seat tables themselves assert:
//
//   link      identity_links row
//   guest     guest_members row (guest_identity_id)
//   sponsored agent_connections row still issued — identity only when
//             the member record itself carries one (a connection created
//             with an identity also writes identity_links, so the link
//             leg above wins whenever both exist)
//   key       a guest_selfserve key seat (no identity exists), or the
//             member record's own stamped identityId (Round-2 #101)
//             with no link/guest/grant binding
//   oauth     the stamped identityId plus a live oauth_grant_agents row
//             for it (the stage-2 grant record, PR #4416 — that table is
//             read defensively until the grant build lands)
//
// Every lookup is defensive against pre-schema databases (a missing
// table reads as "no binding", never a throw), matching this module's
// posture. This is a READ classification only: it grants nothing, wakes
// nothing, and does not move the decision #25 boundary — the work-wake
// resolver (identityIdForMember) is untouched.
function queryRow(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return undefined;
  }
}

function stampedIdentityOf(member) {
  return typeof member?.identityId === "string" && member.identityId ? member.identityId : null;
}

export function presenceSeatForMember(db, roomId, member) {
  if (!db || !roomId || !member?.id) return { identityId: null, seat: null };
  const memberId = member.id;
  const link = queryRow(db,
    "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (link?.identityId) return { identityId: link.identityId, seat: "link" };
  const guest = queryRow(db,
    "SELECT guest_identity_id AS identityId FROM guest_members WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (guest?.identityId) return { identityId: guest.identityId, seat: "guest" };
  const connection = queryRow(db,
    "SELECT status FROM agent_connections WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (connection?.status === "issued") {
    return { identityId: stampedIdentityOf(member), seat: "sponsored" };
  }
  const selfServe = queryRow(db,
    "SELECT member_id AS memberId FROM guest_selfserve WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (selfServe) return { identityId: null, seat: "key" };
  const stamped = stampedIdentityOf(member);
  if (stamped) {
    const grant = queryRow(db,
      "SELECT identity_id AS identityId FROM oauth_grant_agents WHERE identity_id=? AND revoked_at IS NULL",
      stamped);
    if (grant?.identityId) return { identityId: stamped, seat: "oauth" };
    return { identityId: stamped, seat: "key" };
  }
  return { identityId: null, seat: null };
}

// identity -> member, for the webhook fan-out. The guest seat's member id
// keeps the targeted-DM privacy fence meaningful for guest subscribers:
// a guest must not receive third-party DMs either (#3777).
export function memberIdForWakeIdentity(db, roomId, identityId) {
  if (!db || !roomId || !identityId) return null;
  const link = getRow(db,
    "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?",
    roomId, identityId);
  if (link?.memberId) return link.memberId;
  const guest = getRow(db,
    "SELECT member_id AS memberId FROM guest_members WHERE room_id=? AND guest_identity_id=?",
    roomId, identityId);
  return guest?.memberId ?? null;
}
