// Referral attribution: which member brought which member into the room.
//
// A referral is recorded exactly once per join — the PRIMARY KEY on
// (room_id, referee_member_id) makes double-counting impossible, so retries
// and re-approvals are safe. The referrals table is the queryable source of
// truth for the referral board and leaderboard; each recording also journals
// a referral.completed room event as the timeline-visible audit record.
//
// Two paths create referrals:
// - invite: redeeming an agent invite attributes the join to the invite's
//   minter (the invite record's created_by — already stored at mint time).
// - access-request: the requester optionally names who referred them ("who
//   referred you?"); at approval time the text is matched against member
//   display names, and a unique match attributes the join.
//
// Rules: one-time invites stay one-time; a referral counts only on actual
// join; a member cannot refer themselves (the referee must be a different,
// newly-joined member).

import { randomUUID } from "node:crypto";
import { event, EVENT_TYPES as T, isRoomArchived } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";

// Local ServiceError (mirrors server/store.mjs). We avoid importing from
// store.mjs here to break the circular dependency for the Workers bundle:
// store.mjs imports this module, so this module cannot import from store.mjs
// at the top level without esbuild failing on the cycle.
class ServiceError extends Error {
  constructor(status, code, message, headers = null) { super(message); this.status = status; this.code = code; this.headers = headers; }
}
const fail = (status, code, message) => { throw new ServiceError(status, code, message); };
// Mirrors the projection compaction in store.mjs: strip replay-only caches.
const compactState = state => ({ ...state, eventLog: [], seenEvents: {}, seenIdempotencyKeys: {} });
const MAX_ROOM_EVENTS = 10000;
const MAX_PROJECTION_BYTES = 4 * 1024 * 1024;

export const referralSchema = `
  CREATE TABLE IF NOT EXISTS referrals (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    referrer_member_id TEXT NOT NULL,
    referee_member_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    via TEXT NOT NULL CHECK(via IN ('invite','access-request')),
    PRIMARY KEY (room_id, referee_member_id)
  );
  CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(room_id, referrer_member_id);
`;

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REFERRAL_VIA = Object.freeze(["invite", "access-request"]);

export class Referrals {
  constructor(store) { this.store = store; this.db = store.db; }

  // Record a completed referral. Must run inside the caller's transaction,
  // after the referee's member record exists. Idempotent per referee: a
  // second recording for the same referee is a no-op returning the original.
  record({ roomId, referrerMemberId, refereeMemberId, via, at = this.store.now() }) {
    if (typeof roomId !== "string" || !roomId) fail(422, "invalid_referral", "roomId is required");
    for (const [name, id] of [["referrerMemberId", referrerMemberId], ["refereeMemberId", refereeMemberId]]) {
      if (typeof id !== "string" || !MEMBER_ID_PATTERN.test(id)) fail(422, "invalid_referral", `${name} must be a member id`);
    }
    if (referrerMemberId === refereeMemberId) fail(422, "invalid_referral", "a member cannot refer themselves");
    if (!REFERRAL_VIA.includes(via)) fail(422, "invalid_referral", "via must be invite or access-request");
    const members = this.store.room(roomId).state.members ?? {};
    const referrer = members[referrerMemberId];
    const referee = members[refereeMemberId];
    if (!referrer || referrer.active === false) fail(409, "invalid_referral", "referrer is not an active member");
    if (!referee || referee.active === false) fail(409, "invalid_referral", "referee is not an active member");
    const existing = this.db.prepare("SELECT completed_at AS completedAt, via FROM referrals WHERE room_id=? AND referee_member_id=?")
      .get(roomId, refereeMemberId);
    if (existing) return { roomId, referrerMemberId, refereeMemberId, completedAt: existing.completedAt, via: existing.via, duplicate: true };
    this.db.prepare("INSERT INTO referrals(room_id, referrer_member_id, referee_member_id, completed_at, via) VALUES(?,?,?,?,?)")
      .run(roomId, referrerMemberId, refereeMemberId, at, via);
    // Timeline-visible audit record, same transaction: a referral is never
    // recorded without its journal event. Archived rooms keep the table row
    // without a timeline event — there is no live audience to notify.
    this.emitReferralCompleted(roomId, { referrerMemberId, refereeMemberId, via, at });
    return { roomId, referrerMemberId, refereeMemberId, completedAt: at, via, duplicate: false };
  }

  emitReferralCompleted(roomId, { referrerMemberId, refereeMemberId, via, at }) {
    const room = this.store.room(roomId);
    if (isRoomArchived(room.state)) return;
    if (room.sequence >= MAX_ROOM_EVENTS) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
    const incoming = event({
      id: randomUUID(),
      idempotencyKey: `referral-completed:${roomId}:${refereeMemberId}`,
      type: T.REFERRAL_COMPLETED,
      roomId,
      actorId: referrerMemberId,
      at: new Date(at).toISOString(),
      data: { referrerMemberId, refereeMemberId, via, completedAt: at },
    });
    let state;
    try { state = compactState(applyEventWithGrowth(room.state, incoming, growthCollector).state); }
    catch (error) { fail(409, "referral_rejected", error.message); }
    const projection = JSON.stringify(state);
    if (Buffer.byteLength(projection) > MAX_PROJECTION_BYTES) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
    const sequence = room.sequence + 1;
    this.db.prepare("INSERT INTO events VALUES(?,?,?,?)").run(roomId, sequence, incoming.id, JSON.stringify(incoming));
    this.db.prepare("UPDATE rooms SET sequence=?,projection=? WHERE id=?").run(sequence, projection, roomId);
  }

  // Match free text against member display names (case-insensitive, trimmed).
  // Returns the member id on a unique match among active members, else null.
  // Ambiguous or missing matches attribute nothing — the join still proceeds.
  matchReferrer(roomId, text) {
    const needle = typeof text === "string" ? text.trim().toLowerCase() : "";
    if (!needle) return null;
    const members = this.store.room(roomId).state.members ?? {};
    const hits = Object.values(members).filter(m => m.active !== false
      && typeof m.displayName === "string" && m.displayName.trim().toLowerCase() === needle);
    return hits.length === 1 ? hits[0].id : null;
  }

  // Board data: referrals newest-first with display names, plus a plain
  // leaderboard ranked by successful referrals (joined only, never minted).
  // Member-visible; carries no credential data — ids, display names, counts.
  board(token, roomId, expectedSessionBinding = null) {
    const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
    if (!auth?.member) fail(401, "unauthenticated", "Room membership required");
    const members = this.store.room(roomId).state.members ?? {};
    const nameOf = id => members[id]?.displayName ?? id;
    const rows = this.db.prepare(`SELECT referrer_member_id AS referrerMemberId, referee_member_id AS refereeMemberId,
        completed_at AS completedAt, via FROM referrals WHERE room_id=? ORDER BY completed_at DESC, referee_member_id ASC`)
      .all(roomId);
    const referrals = rows.map(row => ({
      ...row,
      referrerDisplayName: nameOf(row.referrerMemberId),
      refereeDisplayName: nameOf(row.refereeMemberId),
    }));
    const counts = new Map();
    for (const row of rows) counts.set(row.referrerMemberId, (counts.get(row.referrerMemberId) ?? 0) + 1);
    const leaderboard = [...counts.entries()]
      .map(([memberId, referralCount]) => ({ memberId, displayName: nameOf(memberId), referralCount }))
      .sort((a, b) => b.referralCount - a.referralCount || a.displayName.localeCompare(b.displayName));
    const myReferrals = referrals.filter(r => r.referrerMemberId === auth.member.id);
    return { roomId, referrals, leaderboard, myReferralCount: myReferrals.length, myReferrals };
  }
}
