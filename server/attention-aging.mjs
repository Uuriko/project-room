// One aging doctrine for every ask family (redesign charter B-3, step 2).
//
// Before this module each decide mechanism invented its own answer to
// "what happens when nobody answers": access requests lapsed silently at
// 7 days (lazy maybeExpire() on read, no job, no notification — E65),
// bonds derived-expired at 7 days, bounty challenges auto-approved at
// 3 days, disputes default-released at 14 days, and reply requests, DM
// consents, verifications, owner decisions, and inbox drafts waited
// forever. The stores, decider rules, and outcome vocabularies are NOT
// merged (the full map's rule: aggregate, never merge). What is shared
// is the doctrine: one table of TTL / escalation constants, one age
// classification, and one counted "expired undecided" state that the
// attention surfaces (#662 per-room card, #3342 cross-room overview)
// derive from.
//
// A family entry:
//   ttlMs           — how long an undecided ask lives before its expiry
//                     resolution fires; null means the ask never expires
//                     (it escalates instead of lapsing).
//   escalateAfterMs — age at which an undecided ask stops being merely
//                     open and becomes escalated (surfaced harder, pushed
//                     via the decision push class, and — for critical
//                     families — raised through the owner-alert engine).
//   expiry          — what the TTL does when it fires:
//                       "expire"         the ask lapses undecided
//                       "derive-expired" reads compute expired; no write
//                       "auto-approve"   the work is accepted by default
//                       "default-release" escrow releases by default
//                       "none"           no expiry (ttlMs is null)
//   consequence     — the human-readable cost of inaction, stated once
//                     here so every surface (attention card, overview
//                     consequence line, push) quotes the same sentence.
//
// The expiry sweep in this module is the only job-driven aging: it flips
// access requests past their TTL to `expired` without waiting for a
// read, which is what makes "expired undecided" a real counted state
// instead of a read-time surprise. The transition is guarded on the
// pending statuses, so re-running the sweep is a no-op — idempotent
// under the scheduler's retry semantics without a separate journal.

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const family = (ttlMs, escalateAfterMs, expiry, consequence) =>
  Object.freeze({ ttlMs, escalateAfterMs, expiry, consequence });

export const ASK_AGING = Object.freeze({
  // Join + permission-upgrade asks. The silent-lapse family (E65): the
  // sweep below flips these rows; the requester learns by polling, the
  // owner learns from the expired-undecided count.
  access_request: family(7 * DAY_MS, 3 * DAY_MS, "expire",
    "The request lapses undecided and the requester must ask again"),
  // Peer bond proposals: stored state stays `proposed`; reads derive
  // "expired" past the TTL (server/bonds.mjs BOND_TTL_MS re-exports this).
  bond_proposal: family(7 * DAY_MS, 3 * DAY_MS, "derive-expired",
    "The proposal is treated as expired and must be proposed again"),
  // DM consent asks wait forever by design (consent is directional and
  // a late answer is still meaningful), but they escalate so a pending
  // consent is not invisible forever.
  dm_consent: family(null, 7 * DAY_MS, "none",
    "The member cannot be DM'd until the consent is decided"),
  // Reply requests are conversations, not approvals; they never expire,
  // but an unanswered direct ask escalates after a week.
  reply_request: family(null, 7 * DAY_MS, "none",
    "The asker stays unanswered; the request keeps resurfacing"),
  // Work verification and owner decision gate money and completion; they
  // never auto-resolve (a default verdict would forge the record), so
  // they escalate hardest and earliest of the never-expiring families.
  verification: family(null, 3 * DAY_MS, "none",
    "Completed work cannot settle until a verifier decides"),
  owner_decision: family(null, 3 * DAY_MS, "none",
    "Completed work stays undecided and its escrow stays locked"),
  // Bounty challenge window: accepted work auto-approves when the
  // window closes undisputed (server/bounty-escrow.mjs sweeps it).
  bounty_challenge: family(3 * DAY_MS, 1 * DAY_MS, "auto-approve",
    "Undisputed accepted work auto-approves and pays out"),
  // Small bounties (< 1 credit) use the shorter challenge window.
  bounty_challenge_small: family(1 * DAY_MS, 12 * HOUR_MS, "auto-approve",
    "Undisputed accepted work auto-approves and pays out"),
  // Bounty disputes default to RELEASE (poster loses) at the TTL.
  bounty_dispute: family(14 * DAY_MS, 7 * DAY_MS, "default-release",
    "The dispute defaults to release: escrow pays the worker"),
  // Inbox outbound drafts are in-memory today; they never expire, and
  // escalation is the only doctrine that can apply until they persist.
  inbox_draft: family(null, 3 * DAY_MS, "none",
    "The drafted outbound message stays unsent until a human decides"),
});

export const ASK_FAMILIES = Object.freeze(Object.keys(ASK_AGING));

export function agingFor(familyName) {
  return Object.hasOwn(ASK_AGING, familyName) ? ASK_AGING[familyName] : null;
}

// One classification for every surface. `decided` is the family's own
// terminal fact (approved/denied/answered/settled); this function never
// invents it — it only ages an ask the caller says is still undecided.
export function classifyAsk({ family: familyName, createdAt, now, decided = false } = {}) {
  const doctrine = agingFor(familyName);
  if (!doctrine) throw new TypeError(`unknown ask family: ${familyName}`);
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) {
    throw new TypeError("classifyAsk needs finite createdAt and now");
  }
  const ageMs = Math.max(0, now - createdAt);
  const expiresAt = doctrine.ttlMs == null ? null : createdAt + doctrine.ttlMs;
  const escalatesAt = createdAt + doctrine.escalateAfterMs;
  const state = decided ? "decided"
    : expiresAt != null && now > expiresAt ? "expired_undecided"
    : now >= escalatesAt ? "escalated"
    : "open";
  return Object.freeze({
    family: familyName,
    state,
    ageMs,
    escalatesAt,
    expiresAt,
    msToEscalation: Math.max(0, escalatesAt - now),
    msToExpiry: expiresAt == null ? null : Math.max(0, expiresAt - now),
    expiry: doctrine.expiry,
    consequence: doctrine.consequence,
  });
}

// Counted, visible form of the doctrine: given normalized undecided asks
// ({ family, createdAt, decided? }), return the totals every attention
// surface reports — so "expired undecided" is one number with one
// derivation, not per-surface arithmetic.
export function summarizeAskAging(items, now) {
  const byFamily = {};
  let expiredUndecided = 0;
  let escalated = 0;
  let open = 0;
  for (const item of items ?? []) {
    const verdict = classifyAsk({ family: item.family, createdAt: item.createdAt, now, decided: item.decided === true });
    const bucket = byFamily[verdict.family] ?? { total: 0, expiredUndecided: 0, escalated: 0, open: 0 };
    bucket.total += 1;
    if (verdict.state === "expired_undecided") { bucket.expiredUndecided += 1; expiredUndecided += 1; }
    else if (verdict.state === "escalated") { bucket.escalated += 1; escalated += 1; }
    else if (verdict.state === "open") { bucket.open += 1; open += 1; }
    byFamily[verdict.family] = bucket;
  }
  return Object.freeze({
    total: (items ?? []).length,
    expiredUndecided,
    escalated,
    open,
    byFamily: Object.freeze(byFamily),
  });
}

// "Expired undecided" as stored fact: access_requests rows the sweep (or
// a lazy read) has flipped to `expired`. The window is over created_at,
// matching the lapsed-undecided derivation the #3342 overview's
// Exceptions section uses, so the two surfaces agree by construction.
export function countExpiredUndecided(db, { roomId = null, sinceMs = null, untilMs = null } = {}) {
  if (!db?.prepare) return 0;
  const clauses = ["status='expired'"];
  const params = [];
  if (roomId != null) { clauses.push("room_id=?"); params.push(roomId); }
  if (sinceMs != null) { clauses.push("created_at>?"); params.push(sinceMs); }
  if (untilMs != null) { clauses.push("created_at<=?"); params.push(untilMs); }
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM access_requests WHERE ${clauses.join(" AND ")}`).get(...params);
    return Number(row?.n ?? 0);
  } catch { return 0; }
}

const PENDING_ACCESS_STATUSES = Object.freeze(["pending", "pending_upgrade"]);

// The step-2 expiry job body: flip every access request past the
// doctrine TTL to `expired`, across every room in this store, without
// waiting for a read. Guarded on the pending statuses inside a single
// transaction, so a second run — scheduler retry, Node + Worker both
// ticking, a manual re-run — expires nothing twice. Returns what it
// did, per room, so the job result and the owner surfaces can count it.
export function expireAccessRequests(store, { now = Date.now() } = {}) {
  const db = store?.db;
  if (!db?.prepare) return Object.freeze({ expired: 0, byRoom: Object.freeze({}) });
  const ttlMs = ASK_AGING.access_request.ttlMs;
  const cutoff = now - ttlMs;
  return store.transaction(() => {
    let stale = [];
    try {
      stale = db.prepare(
        `SELECT request_id, room_id FROM access_requests
         WHERE status IN (${PENDING_ACCESS_STATUSES.map(() => "?").join(",")}) AND created_at < ?`
      ).all(...PENDING_ACCESS_STATUSES, cutoff);
    } catch { return Object.freeze({ expired: 0, byRoom: Object.freeze({}) }); }
    if (stale.length === 0) return Object.freeze({ expired: 0, byRoom: Object.freeze({}) });
    const flip = db.prepare(
      "UPDATE access_requests SET status='expired' WHERE request_id=? AND status IN (?,?)");
    const byRoom = {};
    let expired = 0;
    for (const row of stale) {
      const result = flip.run(row.request_id, ...PENDING_ACCESS_STATUSES);
      if (result.changes > 0) {
        expired += 1;
        byRoom[row.room_id] = (byRoom[row.room_id] ?? 0) + 1;
      }
    }
    return Object.freeze({ expired, byRoom: Object.freeze(byRoom) });
  });
}

// Pending access asks that have crossed their escalation age but not yet
// their TTL: the set the decision push class and the owner-alert engine
// act on. Derived at read; nothing is written.
export function escalatedAccessRequests(db, { now = Date.now(), roomId = null } = {}) {
  if (!db?.prepare) return [];
  const { escalateAfterMs, ttlMs } = ASK_AGING.access_request;
  const clauses = ["status IN (?,?)", "created_at <= ?", "created_at >= ?"];
  const params = [...PENDING_ACCESS_STATUSES, now - escalateAfterMs, now - ttlMs];
  if (roomId != null) { clauses.push("room_id=?"); params.push(roomId); }
  try {
    return db.prepare(
      `SELECT request_id, room_id, created_at FROM access_requests WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`
    ).all(...params).map(row => Object.freeze({
      requestId: row.request_id, roomId: row.room_id, createdAt: row.created_at,
      ageMs: Math.max(0, now - row.created_at),
    }));
  } catch { return []; }
}
