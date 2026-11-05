// Per-member attention lease for room_needs_me (Linear-style).
// Two concurrent handlers for the same identity (wake + check-in) used to
// each see the same items and each reply. Claiming on read suppresses the
// item for claimSec seconds so only the first handler answers. Durable in
// sqlite so it holds across Worker isolates that share the room DB.
// Lease expiry (not reply) is the only release: a crashed first handler
// recovers when the lease ends; a successful reply retires the item via
// retiredNeedsMeKeys the usual way.

export const DEFAULT_CLAIM_SEC = 45;
export const MAX_CLAIM_SEC = 300;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS needs_me_claims (
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, member_id, kind, item_id)
);
CREATE INDEX IF NOT EXISTS needs_me_claims_expires ON needs_me_claims(expires_at);
`;

export function ensureNeedsMeClaims(db) {
  db.exec(SCHEMA);
}

export function clampClaimSec(claimSec) {
  if (claimSec == null || claimSec === false) return 0;
  const n = Number(claimSec);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_CLAIM_SEC, Math.max(1, Math.floor(n)));
}

function withImmediate(db, fn) {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

// Filter items through a per-(room,member,kind,id) lease. First caller wins
// for claimSec seconds; later callers in that window omit the item. Mutates
// nothing about cursor/retirement. Returns { items, leased, suppressed, leaseSec }.
export function filterClaimedNeedsMe(db, { items, memberByRoom, claimSec, now = Date.now() } = {}) {
  const leaseSec = clampClaimSec(claimSec);
  if (!leaseSec || !Array.isArray(items) || items.length === 0) {
    return { items: items ?? [], leased: 0, suppressed: 0, leaseSec: 0 };
  }
  ensureNeedsMeClaims(db);
  const expiresAt = now + leaseSec * 1000;
  return withImmediate(db, () => {
    db.prepare("DELETE FROM needs_me_claims WHERE expires_at < ?").run(now);
    const get = db.prepare(
      "SELECT expires_at AS expiresAt FROM needs_me_claims WHERE room_id=? AND member_id=? AND kind=? AND item_id=?");
    const put = db.prepare(
      `INSERT INTO needs_me_claims(room_id, member_id, kind, item_id, claimed_at, expires_at)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(room_id, member_id, kind, item_id) DO UPDATE SET
         claimed_at=excluded.claimed_at,
         expires_at=excluded.expires_at
       WHERE needs_me_claims.expires_at < excluded.claimed_at`);
    let leased = 0;
    let suppressed = 0;
    const kept = [];
    for (const item of items) {
      const memberId = memberByRoom?.get?.(item.roomId);
      if (!memberId || typeof item.kind !== "string" || item.id == null) {
        kept.push(item);
        continue;
      }
      const itemId = String(item.id);
      const row = get.get(item.roomId, memberId, item.kind, itemId);
      if (row && row.expiresAt >= now) {
        suppressed += 1;
        continue;
      }
      put.run(item.roomId, memberId, item.kind, itemId, now, expiresAt);
      kept.push({ ...item, claimedUntil: new Date(expiresAt).toISOString() });
      leased += 1;
    }
    return { items: kept, leased, suppressed, leaseSec };
  });
}
