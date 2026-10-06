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

// G11: read at call time; store.mjs imports this module, so no module-level copy.
import { PILOT_LIMITS } from "./store.mjs";
import { randomUUID } from "node:crypto";
import { event, EVENT_TYPES as T, isRoomArchived } from "../src/events.js";
import { applyEventWithGrowth, growthCollector } from "../src/growth-emit.js";
import { ensureActivationColumn, ensurePayoutColumns, inviteMessage, memberReward, settleActivations, stampIssuer } from "./growth-loop.mjs";

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

export const referralSchema = `
  CREATE TABLE IF NOT EXISTS referrals (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    referrer_member_id TEXT NOT NULL,
    referee_member_id TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    via TEXT NOT NULL CHECK(via IN ('invite','request')),
    PRIMARY KEY (room_id, referee_member_id)
  );
  CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(room_id, referrer_member_id);
`;

const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const REFERRAL_VIA = Object.freeze(["invite", "request"]);

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
    if (!REFERRAL_VIA.includes(via)) fail(422, "invalid_referral", "via must be invite or request");
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
    if (room.sequence >= PILOT_LIMITS.eventsPerRoom) fail(409, "pilot_limit", "Bounded pilot capacity reached; no data was changed");
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
    if (Buffer.byteLength(projection) > PILOT_LIMITS.projectionBytes) fail(409, "pilot_limit", "Room projection limit reached; no data was changed");
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
  // Join counts stay on referralCount / myReferralCount. Rewards use
  // activatedAt: the referee posted, then 24 hours passed. The caller's
  // personal invite is included so an agent can share it from this GET.
  // Member-visible; carries no credential data — ids, display names, counts,
  // and the caller's own invite token.
  board(token, roomId, expectedSessionBinding = null, trace = null) {
    ensureActivationColumn(this.db);
    ensurePayoutColumns(this.db);
    return this.store.transaction(() => {
      const auth = this.store.authenticate(token, roomId, expectedSessionBinding);
      if (!auth?.member) fail(401, "unauthenticated", "Room membership required");
      settleActivations(this.store, roomId);
      const members = this.store.room(roomId).state.members ?? {};
      const nameOf = id => members[id]?.displayName ?? id;
      const rows = this.db.prepare(`SELECT referrer_member_id AS referrerMemberId, referee_member_id AS refereeMemberId,
          completed_at AS completedAt, via, activated_at AS activatedAt FROM referrals
          WHERE room_id=? AND (payout_block IS NULL OR payout_block != 'trace')
          ORDER BY completed_at DESC, referee_member_id ASC`)
        .all(roomId);
      const referrals = rows.map(row => ({
        ...row,
        referrerDisplayName: nameOf(row.referrerMemberId),
        refereeDisplayName: nameOf(row.refereeMemberId),
      }));
      const counts = new Map();
      const activeCounts = new Map();
      for (const row of rows) {
        counts.set(row.referrerMemberId, (counts.get(row.referrerMemberId) ?? 0) + 1);
        if (row.activatedAt != null) activeCounts.set(row.referrerMemberId, (activeCounts.get(row.referrerMemberId) ?? 0) + 1);
      }
      const leaderboard = [...counts.entries()]
        .map(([memberId, referralCount]) => ({ memberId, displayName: nameOf(memberId), referralCount, activeCount: activeCounts.get(memberId) ?? 0 }))
        .sort((a, b) => b.referralCount - a.referralCount || a.displayName.localeCompare(b.displayName));
      const myReferrals = referrals.filter(r => r.referrerMemberId === auth.member.id);
      const reward = memberReward(this.store, roomId, auth.member.id);
      let invite = null;
      if (this.store.shareLinks) {
        const personal = this.store.shareLinks.personalInvite(auth, roomId, reward.inviteCap);
        stampIssuer(this.store, roomId, auth.member.id, trace ?? {});
        if (personal?.token) {
          const title = this.store.room(roomId).state.room?.title;
          invite = {
            token: personal.token,
            hash: `#join/${personal.token}`,
            expiresAt: personal.link.expiresAt,
            remainingJoins: personal.link.remainingJoins,
            maxJoins: personal.link.maxJoins,
            status: personal.link.status,
            message: inviteMessage(title),
          };
        }
      }
      return {
        roomId, referrals, leaderboard, myReferralCount: myReferrals.length, myReferrals,
        myActiveCount: reward.activeCount, reward, invite,
      };
    });
  }
}
