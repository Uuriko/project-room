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
// That liveness judgement is THE shared live-seat predicate, and this
// module exports it in three forms with one semantics — guestSeatLive
// (single seat), guestSeatLiveMemberIds (every live guest seat in a
// room, batched), and guestSeatLiveSql (the correlated SQL form for
// the webhook drain's batch SELECT, which used to hand-copy the
// credential EXISTS and drifted with it). Every wake leg, the
// wake-status pair below, the public agent page, the public-work
// receipt exception, and the seat-enumeration consumers in
// server/membership-resolution.mjs judge a guest seat through one of
// these forms — never through a local copy. Callers capture one `now`
// from the store clock per operation and pass it down; the predicate
// never re-reads a clock per seat.
//
// Room mode of GET /api/wake-status also resolves through this module
// (identityIdsForWakeRoom / isWakeRoomMember below, #3908 F-8): it was
// identity_links-only, so a guest caller was refused membership in its
// own room and guest seats never appeared in the wakeable lists. Its
// guest leg is gated by the same predicate: a seat that ended —
// disconnected, expired (swept or not) — is not a room member for
// wake purposes, however fresh its heartbeat stamp is.
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
export function guestSeatLive(db, roomId, memberId, now) {
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

// The batched form of the predicate, for enumerations: the set of
// guest member ids in the room holding a live access credential, in
// one query. Returns null ONLY for the pre-schema fallback (no
// credentials table — liveness was never tracked, so every guest seat
// counts live and the caller keeps all its guest rows); any other
// lookup error returns an empty set, the per-seat fail-closed rule
// applied in batch.
export function guestSeatLiveMemberIds(db, roomId, now) {
  if (!db || !roomId) return new Set();
  let rows;
  try {
    rows = db.prepare(
      "SELECT DISTINCT member_id AS memberId FROM credentials WHERE room_id=? AND kind='access' AND revoked=0 AND expires_at>?")
      .all(roomId, now);
  } catch (error) {
    if (/no such table/i.test(error?.message ?? "")) return null;
    return new Set();
  }
  return new Set(rows.map(row => row.memberId));
}

// The SQL form of the predicate, for the one SQL consumer (the webhook
// drain's batch SELECT): a correlated EXISTS over the caller's room /
// member expressions, with exactly one bind parameter — the caller's
// `now`, in the position the drain query already binds it. Unlike the
// JS forms it has no missing-table fallback (a missing credentials
// table would error the drain query rather than admit the row); that
// divergence is unreachable on any database carrying the base schema,
// where credentials exists.
export function guestSeatLiveSql(roomExpr, memberExpr) {
  return `EXISTS (SELECT 1 FROM credentials c WHERE c.room_id = ${roomExpr} AND c.member_id = ${memberExpr} AND c.kind = 'access' AND c.revoked = 0 AND c.expires_at > ?)`;
}

// member -> identity, for the mention fan-out and the reaction-ack path.
// The guest leg is gated on the seat being live (see the header note):
// a disconnected or expired guest member resolves to no identity, so
// no wake is queued for it.
export function identityIdForWakeMember(db, roomId, memberId, now = Date.now()) {
  if (!db || !roomId || !memberId) return null;
  const link = getRow(db,
    "SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (link?.identityId) return link.identityId;
  const guest = getRow(db,
    "SELECT guest_identity_id AS identityId FROM guest_members WHERE room_id=? AND member_id=?",
    roomId, memberId);
  if (!guest?.identityId) return null;
  return guestSeatLive(db, roomId, memberId, now) ? guest.identityId : null;
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

function allRows(db, sql, roomId) {
  try {
    return db.prepare(sql).all(roomId);
  } catch {
    return [];
  }
}

// Every identity seated in a room, for room-scoped wake surfaces
// (wake-status room mode): identity_links first, guest_members as the
// fallback - one entry per identity, the link seat wins where an
// identity somehow holds both rows in the room (the enumeration rule
// in server/membership-resolution.mjs). The guest leg is gated on the
// shared predicate, batched: one guest_members scan plus one batched
// credentials read per room, whatever the seat count — a disconnected
// or expired guest identity is not listed, so it can neither be
// reported wakeable nor partition into the not-wakeable list.
export function identityIdsForWakeRoom(db, roomId, now = Date.now()) {
  if (!db || !roomId) return [];
  const ids = [], seen = new Set();
  for (const row of allRows(db,
    "SELECT identity_id AS identityId FROM identity_links WHERE room_id=?", roomId)) {
    if (row.identityId && !seen.has(row.identityId)) { seen.add(row.identityId); ids.push(row.identityId); }
  }
  // null = pre-schema fallback (no credentials table): keep every
  // guest row, as the ungated enumeration did.
  const liveGuestMemberIds = guestSeatLiveMemberIds(db, roomId, now);
  for (const row of allRows(db,
    "SELECT guest_identity_id AS identityId, member_id AS memberId FROM guest_members WHERE room_id=?", roomId)) {
    if (!row.identityId || seen.has(row.identityId)) continue;
    if (liveGuestMemberIds !== null && !liveGuestMemberIds.has(row.memberId)) continue;
    seen.add(row.identityId); ids.push(row.identityId);
  }
  return ids;
}

// Room membership for a wake surface, resolved through the same
// guest-aware resolver (identity -> member, above) — the guest leg
// inherits its live-seat gate.
export function isWakeRoomMember(db, roomId, identityId, now = Date.now()) {
  return memberIdForWakeIdentity(db, roomId, identityId, now) !== null;
}
