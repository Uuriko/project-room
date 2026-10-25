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
// The guest fallback in memberIdForWakeIdentity is additionally gated
// on the seat being LIVE: a guest seat holds an unrevoked, unexpired
// access credential in credentials for as long as it is seated, and
// loses it the moment it ends — disconnect() revokes every credential
// the seat holds, the expiry sweeps judge the seat by that same state,
// and the guest_members row stays behind either way (a returning guest
// reactivates the same seat). Judging the seat by the row alone kept
// resolving a disconnected guest's identity, so its webhook
// subscriptions kept receiving room message bodies after the seat was
// gone. credentials is base schema and predates guest seats, so a
// database without the credentials table is a pre-schema artifact
// where liveness was never tracked: there the seat resolves on its
// row, as before. On every database that tracks credentials, no live
// credential means no resolution.
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

// Whether a guest seat is live, judged by the seat's access credential
// — the same state GuestInvites.disconnect() (hasLiveCredential) and
// sweepExpiredGuests ("judge the seat by an unrevoked row only") use.
// A missing credentials table means a pre-schema database where
// liveness was never tracked (see the header note): the seat counts as
// live there. Any other lookup failure fails closed.
function guestSeatLive(db, roomId, memberId, now) {
  let row;
  try {
    row = db.prepare(
      "SELECT 1 AS live FROM credentials WHERE room_id=? AND member_id=? AND kind='access' AND revoked=0 AND expires_at>?")
      .get(roomId, memberId, now);
  } catch (error) {
    return /no such table/i.test(error?.message ?? "");
  }
  return !!row;
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

// identity -> member, for the webhook fan-out. The guest seat's member id
// keeps the targeted-DM privacy fence meaningful for guest subscribers:
// a guest must not receive third-party DMs either (#3777).
export function memberIdForWakeIdentity(db, roomId, identityId, now = Date.now()) {
  if (!db || !roomId || !identityId) return null;
  const link = getRow(db,
    "SELECT member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?",
    roomId, identityId);
  if (link?.memberId) return link.memberId;
  const guest = getRow(db,
    "SELECT member_id AS memberId FROM guest_members WHERE room_id=? AND guest_identity_id=?",
    roomId, identityId);
  if (!guest?.memberId) return null;
  return guestSeatLive(db, roomId, guest.memberId, now) ? guest.memberId : null;
}
