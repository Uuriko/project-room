// Referral growth: a join is recorded immediately, and it counts toward a
// reward only after the new member posts a message and 24 hours pass from
// that message. Rewards are room-founding credits (a guest room, or one
// extra agent room past the daily bucket) plus a larger personal invite.
//
// No new tables. Activation is a column on referrals. Extra agent rooms are
// a column on agent_room_ownership. Personal invites are ordinary share_links
// rows whose token is recomputed from the room's referral signing seed.

import { createHmac } from "node:crypto";
import { inviteMessage } from "../src/share-links.js";

export { inviteMessage };

export const ACTIVATION_DWELL_MS = 24 * 60 * 60 * 1000;
export const PERSONAL_INVITE_PREFIX = "growth-personal:";
export const GROWTH_ROOM_ORIGIN = "growth-room";
export const GROWTH_FUNDING = "growth";
export const PERSONAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Active referrals in one room. inviteCap is the personal link's join limit
// (share_links max_joins is 1–25). credits are room-founding credits.
export const GROWTH_TIERS = Object.freeze([
  Object.freeze({ name: "Member", active: 0, inviteCap: 5, credits: 0 }),
  Object.freeze({ name: "Host", active: 1, inviteCap: 10, credits: 1 }),
  Object.freeze({ name: "Connector", active: 3, inviteCap: 15, credits: 2 }),
  Object.freeze({ name: "Builder", active: 6, inviteCap: 25, credits: 4 }),
]);

export function tierFor(activeCount) {
  let current = GROWTH_TIERS[0];
  for (const tier of GROWTH_TIERS) if (activeCount >= tier.active) current = tier;
  return current;
}

export function nextTier(activeCount) {
  return GROWTH_TIERS.find(tier => tier.active > activeCount) ?? null;
}

export function personalInviteToken(privateSeed, roomId, memberId, generation) {
  return createHmac("sha256", privateSeed).update(`${roomId}\0${memberId}\0${generation}`).digest("base64url");
}

export function ensureColumn(db, table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some(col => col.name === column)) return;
  try { db.exec(ddl); }
  catch (error) {
    if (!/duplicate column name/i.test(String(error?.message))) throw error;
  }
}

export function ensureActivationColumn(db) {
  ensureColumn(db, "referrals", "activated_at", "ALTER TABLE referrals ADD COLUMN activated_at INTEGER");
}

export function ensureGrowthFundingColumn(db) {
  ensureColumn(db, "agent_room_ownership", "funded_by", "ALTER TABLE agent_room_ownership ADD COLUMN funded_by TEXT");
}

// First message starts the clock. The referral activates at firstMessage + 24h,
// not at join, so an empty signup never counts.
export function settleActivations(store, roomId) {
  ensureActivationColumn(store.db);
  const pending = store.db.prepare(
    "SELECT referee_member_id AS refereeMemberId FROM referrals WHERE room_id=? AND activated_at IS NULL"
  ).all(roomId);
  if (!pending.length) return 0;
  const firstByAuthor = new Map();
  for (const message of store.room(roomId).state.messages ?? []) {
    if (!message?.authorId || typeof message.createdAt !== "string") continue;
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at)) continue;
    const prior = firstByAuthor.get(message.authorId);
    if (prior === undefined || at < prior) firstByAuthor.set(message.authorId, at);
  }
  const now = store.now();
  const update = store.db.prepare(
    "UPDATE referrals SET activated_at=? WHERE room_id=? AND referee_member_id=? AND activated_at IS NULL"
  );
  let settled = 0;
  for (const row of pending) {
    const first = firstByAuthor.get(row.refereeMemberId);
    if (first === undefined || now < first + ACTIVATION_DWELL_MS) continue;
    update.run(first + ACTIVATION_DWELL_MS, roomId, row.refereeMemberId);
    settled += 1;
  }
  return settled;
}

export function memberReward(store, roomId, memberId) {
  ensureActivationColumn(store.db);
  const activeCount = store.db.prepare(
    "SELECT count(*) AS n FROM referrals WHERE room_id=? AND referrer_member_id=? AND activated_at IS NOT NULL"
  ).get(roomId, memberId).n;
  const welcomeCredit = store.db.prepare(
    "SELECT 1 AS ok FROM referrals WHERE room_id=? AND referee_member_id=? AND activated_at IS NOT NULL"
  ).get(roomId, memberId) ? 1 : 0;
  const tier = tierFor(activeCount);
  const upcoming = nextTier(activeCount);
  return {
    tier: tier.name,
    activeCount,
    inviteCap: tier.inviteCap,
    credits: tier.credits,
    welcomeCredit,
    next: upcoming ? { name: upcoming.name, active: upcoming.active, remaining: upcoming.active - activeCount } : null,
  };
}

function creditsForMemberships(store, rows) {
  let tierCredits = 0;
  let welcome = 0;
  for (const row of rows) {
    settleActivations(store, row.room_id);
    const reward = memberReward(store, row.room_id, row.member_id);
    tierCredits += reward.credits;
    if (reward.welcomeCredit) welcome = 1;
  }
  return { tierCredits, welcome, total: tierCredits + welcome };
}

export function accountRoomCredits(store, accountId) {
  const rows = store.db.prepare("SELECT room_id, member_id FROM member_accounts WHERE account_id=?").all(accountId);
  return creditsForMemberships(store, rows);
}

export function identityRoomCredits(store, identityId) {
  const rows = store.db.prepare("SELECT room_id, member_id FROM identity_links WHERE identity_id=?").all(identityId);
  return creditsForMemberships(store, rows);
}

export function growthFundedRooms(store, identityId) {
  ensureGrowthFundingColumn(store.db);
  return store.db.prepare(
    "SELECT count(*) AS n FROM agent_room_ownership WHERE identity_id=? AND funded_by=?"
  ).get(identityId, GROWTH_FUNDING).n;
}
