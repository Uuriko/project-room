// Abuse rate-limit buckets that must survive Durable Object eviction.
// Created on first use, not in the constructor. A room that has never
// tripped one of these limits has no table.
//
// The in-memory map in server/http.mjs stays the hot path. A bucket is
// written here every quarter of its allowance, and again when the allowance
// is exhausted, so a restart cannot hand the caller a fresh budget. A flood
// of single attempts does not write a row.

export const ABUSE_RATE_TABLES = Object.freeze(["abuse_rate_buckets"]);

// Families whose reset on eviction is an abuse hole. `write` is the shared
// room-write bucket, so claim creation and message posts are both covered.
export const ABUSE_RATE_FAMILIES = Object.freeze(new Set([
  "login",
  "password-login",
  "password-login-ip",
  "account-login",
  "magic-consume",
  "passkey-auth-finish",
  "password-signup",
  "identity-create",
  "invite-redeem",
  "referral-invite-mint",
  "referral-invite-redeem",
  "guest-invite-redeem",
  "guest-invite-redeem-code",
  "guest-invite-mint",
  "guest-invite-request",
  "invitation-accept",
  "link-join",
  "agent-webhook-subscribe",
  "guest-post",
  "write"
]));

const FAMILY_CAP = 2000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS abuse_rate_buckets (
    id TEXT PRIMARY KEY,
    family TEXT NOT NULL,
    n INTEGER NOT NULL,
    until_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS abuse_rate_buckets_until ON abuse_rate_buckets(until_ms);
  CREATE INDEX IF NOT EXISTS abuse_rate_buckets_family_n ON abuse_rate_buckets(family, n);
`;

const ready = new WeakSet();

export function abuseRateTablesPresent(db) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='abuse_rate_buckets'"
  ).get());
}

export function ensureAbuseRateSchema(db) {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  ready.add(db);
}

const familyOf = id => {
  const colon = id.indexOf(":");
  if (colon <= 0) throw new TypeError("abuse rate id needs a family");
  return id.slice(0, colon);
};

export function loadAbuseRateBucket(db, id, now) {
  if (!abuseRateTablesPresent(db)) return null;
  const row = db.prepare("SELECT n, until_ms FROM abuse_rate_buckets WHERE id=?").get(id);
  if (!row || row.until_ms <= now) return null;
  return { n: row.n, until: row.until_ms, persistedN: row.n };
}

export function saveAbuseRateBucket(db, id, entry) {
  ensureAbuseRateSchema(db);
  const family = familyOf(id);
  const existing = db.prepare("SELECT 1 AS hit FROM abuse_rate_buckets WHERE id=?").get(id);
  if (!existing) {
    const count = db.prepare("SELECT count(*) AS n FROM abuse_rate_buckets WHERE family=?").get(family).n;
    if (count >= FAMILY_CAP) {
      db.prepare(
        `DELETE FROM abuse_rate_buckets WHERE id = (
          SELECT id FROM abuse_rate_buckets WHERE family=? ORDER BY n ASC, until_ms ASC LIMIT 1
        )`
      ).run(family);
    }
  }
  db.prepare(
    `INSERT INTO abuse_rate_buckets(id, family, n, until_ms) VALUES(?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET n=excluded.n, until_ms=excluded.until_ms`
  ).run(id, family, entry.n, entry.until);
  entry.persistedN = entry.n;
}

// Bounded delete of expired rows. Does not create the table: a cron tick
// on a room that has never persisted a bucket stays a no-op.
export function pruneAbuseRateBuckets(db, { now, limit = 100 } = {}) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("pruneAbuseRateBuckets requires a timestamp and a positive limit");
  }
  if (!abuseRateTablesPresent(db)) return { pruned: 0 };
  const result = db.prepare(
    `DELETE FROM abuse_rate_buckets WHERE id IN (
      SELECT id FROM abuse_rate_buckets WHERE until_ms <= ? LIMIT ?
    )`
  ).run(now, limit);
  return { pruned: result.changes ?? 0 };
}
