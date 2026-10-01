// Referral growth: a join is recorded immediately, and it counts toward a
// reward only after the new member posts a message and 24 hours pass from
// that message. Rewards are room-founding credits (a guest room, or one
// extra agent room past the daily bucket) plus a larger personal invite.
//
// No new tables. Activation is a column on referrals. Extra agent rooms are
// a column on agent_room_ownership. Personal invites are ordinary share_links
// rows whose token is recomputed from the room's referral signing seed.

import { createHash, createHmac } from "node:crypto";
import { inviteMessage } from "../src/share-links.js";

export { inviteMessage };

export const ACTIVATION_DWELL_MS = 24 * 60 * 60 * 1000;
export const PERSONAL_INVITE_PREFIX = "growth-personal:";
export const GROWTH_ROOM_ORIGIN = "growth-room";
export const GROWTH_FUNDING = "growth";
export const PERSONAL_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Payouts, not joins. A referrer can be credited for at most this many
// activations in a rolling day, across every room their account is in.
export const PAYOUT_DAILY_CAP = 3;
export const PAYOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

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

const TRACE_BLOCK = "trace";

export function ensurePayoutColumns(db) {
  ensureActivationColumn(db);
  ensureColumn(db, "referrals", "payout_block", "ALTER TABLE referrals ADD COLUMN payout_block TEXT");
  ensureColumn(db, "referrals", "referee_address", "ALTER TABLE referrals ADD COLUMN referee_address TEXT");
  ensureColumn(db, "referrals", "referee_session", "ALTER TABLE referrals ADD COLUMN referee_session TEXT");
  ensureColumn(db, "agent_identities", "growth_mint_account", "ALTER TABLE agent_identities ADD COLUMN growth_mint_account TEXT");
  ensureColumn(db, "agent_identities", "growth_mint_address", "ALTER TABLE agent_identities ADD COLUMN growth_mint_address TEXT");
  ensureColumn(db, "agent_identities", "growth_mint_session", "ALTER TABLE agent_identities ADD COLUMN growth_mint_session TEXT");
}

function traceRefereeId(memberId) {
  return `trace${createHash("sha256").update(String(memberId)).digest("hex").slice(0, 16)}`;
}

function partyDigest(label, value) {
  return createHash("sha256").update(`project-room-growth-${label}-v1:${value}`).digest("hex");
}

export function partyAddress(address) {
  if (typeof address !== "string" || !address.trim()) return null;
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  return partyDigest("addr", ip);
}

export function partySession(session) {
  if (typeof session !== "string" || !session || session.length > 512) return null;
  return partyDigest("session", session);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function columnExists(db, table, column) {
  return tableExists(db, table) && db.prepare(`PRAGMA table_info(${table})`).all().some(col => col.name === column);
}

// Remember who minted an identity when the HTTP mint can see an account,
// a browser session, or a client address. The first observation sticks.
export function noteIdentityMint(store, identityId, { address, session, accountId } = {}) {
  if (typeof identityId !== "string" || !identityId) return;
  ensurePayoutColumns(store.db);
  const mintAddress = partyAddress(address);
  const mintSession = partySession(session);
  const account = typeof accountId === "string" && accountId ? accountId : null;
  if (!mintAddress && !mintSession && !account) return;
  const write = () => {
    store.db.prepare(`UPDATE agent_identities SET
      growth_mint_address=COALESCE(growth_mint_address, ?),
      growth_mint_session=COALESCE(growth_mint_session, ?),
      growth_mint_account=COALESCE(growth_mint_account, ?)
      WHERE identity_id=?`).run(mintAddress, mintSession, account, identityId);
  };
  if (store.db.isTransaction) write();
  else store.transaction(write);
}

export function stampIssuer(store, roomId, memberId, { address, session } = {}) {
  ensurePayoutColumns(store.db);
  const addr = partyAddress(address);
  const sess = partySession(session);
  if (!addr && !sess) return;
  const referee = traceRefereeId(memberId);
  const existing = store.db.prepare("SELECT 1 AS ok FROM referrals WHERE room_id=? AND referee_member_id=?").get(roomId, referee);
  if (!existing) {
    store.db.prepare(`INSERT INTO referrals(room_id, referrer_member_id, referee_member_id, completed_at, via, payout_block, referee_address, referee_session)
      VALUES(?,?,?,?, 'invite', ?, ?, ?)`).run(roomId, memberId, referee, store.now(), TRACE_BLOCK, addr, sess);
    return;
  }
  store.db.prepare(`UPDATE referrals SET
      referee_address=CASE WHEN ? IS NULL THEN referee_address ELSE ? END,
      referee_session=CASE WHEN ? IS NULL THEN referee_session ELSE ? END
    WHERE room_id=? AND referee_member_id=? AND payout_block=?`).run(addr, addr, sess, sess, roomId, referee, TRACE_BLOCK);
}

export function rememberReferee(store, roomId, refereeMemberId, { address, session } = {}) {
  ensurePayoutColumns(store.db);
  const addr = partyAddress(address);
  const sess = partySession(session);
  if (!addr && !sess) return;
  store.db.prepare(`UPDATE referrals SET
      referee_address=COALESCE(referee_address, ?),
      referee_session=COALESCE(referee_session, ?)
    WHERE room_id=? AND referee_member_id=?`).run(addr, sess, roomId, refereeMemberId);
}

function accountIdFor(store, roomId, memberId) {
  if (!tableExists(store.db, "member_accounts")) return null;
  return store.db.prepare("SELECT account_id AS accountId FROM member_accounts WHERE room_id=? AND member_id=?").get(roomId, memberId)?.accountId ?? null;
}

function identityIdFor(store, roomId, memberId) {
  const linked = tableExists(store.db, "identity_links")
    ? store.db.prepare("SELECT identity_id AS identityId FROM identity_links WHERE room_id=? AND member_id=?").get(roomId, memberId)?.identityId
    : null;
  if (linked) return linked;
  if (!tableExists(store.db, "agent_identities")) return null;
  return store.db.prepare("SELECT identity_id AS identityId FROM agent_identities WHERE identity_id=?").get(memberId)?.identityId ?? null;
}

function mintRow(store, identityId) {
  if (!identityId || !columnExists(store.db, "agent_identities", "growth_mint_account")) return null;
  return store.db.prepare(`SELECT growth_mint_account AS accountId, growth_mint_address AS address, growth_mint_session AS session
    FROM agent_identities WHERE identity_id=?`).get(identityId) ?? null;
}

// An agent the inviter minted or owns does not pay. Signals are the inviter's
// account, the browser session that fetched the invite, and the client address.
export function referralBlockReason(store, roomId, referrerMemberId, refereeMemberId) {
  ensurePayoutColumns(store.db);
  const db = store.db;
  const referrerAccount = accountIdFor(store, roomId, referrerMemberId);
  const refereeAccount = accountIdFor(store, roomId, refereeMemberId);
  if (referrerAccount && refereeAccount && referrerAccount === refereeAccount) return "owner";
  const referrerIdentity = identityIdFor(store, roomId, referrerMemberId);
  const refereeIdentity = identityIdFor(store, roomId, refereeMemberId);
  if (referrerIdentity && refereeIdentity && referrerIdentity === refereeIdentity) return "owner";
  const refereeMint = mintRow(store, refereeIdentity);
  if (referrerAccount && refereeMint?.accountId === referrerAccount) return "owner";
  if (referrerAccount && refereeIdentity && tableExists(db, "identity_links") && tableExists(db, "member_accounts")) {
    const owned = db.prepare(`SELECT 1 AS ok FROM identity_links il
      JOIN member_accounts ma ON ma.room_id=il.room_id AND ma.member_id=il.member_id
      WHERE il.identity_id=? AND ma.account_id=?`).get(refereeIdentity, referrerAccount);
    if (owned) return "owner";
  }
  if (tableExists(db, "agent_connections")) {
    const sponsored = db.prepare(`SELECT 1 AS ok FROM agent_connections
      WHERE room_id=? AND member_id=? AND (sponsor_member_id=? OR (? IS NOT NULL AND sponsor_account_id=?))`)
      .get(roomId, refereeMemberId, referrerMemberId, referrerAccount, referrerAccount);
    if (sponsored) return "owner";
  }
  const issuer = db.prepare(`SELECT referee_address AS address, referee_session AS session FROM referrals
    WHERE room_id=? AND referee_member_id=? AND payout_block=?`).get(roomId, traceRefereeId(referrerMemberId), TRACE_BLOCK);
  const issuerAddress = issuer?.address ?? null;
  const issuerSession = issuer?.session ?? null;
  const referral = db.prepare(`SELECT referee_address AS address, referee_session AS session FROM referrals
    WHERE room_id=? AND referee_member_id=?`).get(roomId, refereeMemberId);
  if (issuerSession && (referral?.session === issuerSession || refereeMint?.session === issuerSession)) return "session";
  if (issuerAddress && (referral?.address === issuerAddress || refereeMint?.address === issuerAddress)) return "address";
  const referrerMint = mintRow(store, referrerIdentity);
  if (referrerMint?.address && refereeMint?.address && referrerMint.address === refereeMint.address) return "address";
  if (referrerMint?.session && refereeMint?.session && referrerMint.session === refereeMint.session) return "session";
  if (referrerIdentity && refereeIdentity && columnExists(db, "agent_identities", "mint_address")) {
    const rows = db.prepare("SELECT identity_id AS identityId, mint_address AS mintAddress FROM agent_identities WHERE identity_id IN (?, ?)").all(refereeIdentity, referrerIdentity);
    const byId = new Map(rows.map(row => [row.identityId, row.mintAddress]));
    if (byId.get(refereeIdentity) && byId.get(refereeIdentity) === byId.get(referrerIdentity)) return "address";
  }
  return null;
}

function payoutsInWindow(store, roomId, referrerMemberId, now) {
  const since = now - PAYOUT_WINDOW_MS;
  const account = accountIdFor(store, roomId, referrerMemberId);
  if (account) {
    return store.db.prepare(`SELECT count(*) AS n FROM referrals r
      JOIN member_accounts ma ON ma.room_id=r.room_id AND ma.member_id=r.referrer_member_id
      WHERE ma.account_id=? AND r.activated_at IS NOT NULL AND r.activated_at>?`).get(account, since).n;
  }
  return store.db.prepare(`SELECT count(*) AS n FROM referrals
    WHERE referrer_member_id=? AND activated_at IS NOT NULL AND activated_at>?`).get(referrerMemberId, since).n;
}

// First message starts the clock. The referral activates at firstMessage + 24h,
// not at join, so an empty signup never counts. An agent the inviter minted
// or owns never activates. Everyone else is capped at PAYOUT_DAILY_CAP
// activations in a rolling day; a later day can still pay a referral that
// already qualified.
export function settleActivations(store, roomId) {
  ensurePayoutColumns(store.db);
  const pending = store.db.prepare(
    `SELECT referee_member_id AS refereeMemberId, referrer_member_id AS referrerMemberId, payout_block AS payoutBlock
     FROM referrals WHERE room_id=? AND activated_at IS NULL ORDER BY completed_at ASC, referee_member_id ASC`
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
  const activate = store.db.prepare(
    "UPDATE referrals SET activated_at=? WHERE room_id=? AND referee_member_id=? AND activated_at IS NULL AND payout_block IS NULL"
  );
  const block = store.db.prepare(
    "UPDATE referrals SET payout_block=? WHERE room_id=? AND referee_member_id=? AND activated_at IS NULL AND payout_block IS NULL"
  );
  let settled = 0;
  for (const row of pending) {
    if (row.payoutBlock) continue;
    const reason = referralBlockReason(store, roomId, row.referrerMemberId, row.refereeMemberId);
    if (reason) {
      block.run(reason, roomId, row.refereeMemberId);
      continue;
    }
    const first = firstByAuthor.get(row.refereeMemberId);
    if (first === undefined || now < first + ACTIVATION_DWELL_MS) continue;
    if (payoutsInWindow(store, roomId, row.referrerMemberId, now) >= PAYOUT_DAILY_CAP) continue;
    if (activate.run(first + ACTIVATION_DWELL_MS, roomId, row.refereeMemberId).changes) settled += 1;
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
