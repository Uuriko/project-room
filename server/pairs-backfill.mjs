// One-time data backfill for the pairs table: rewrite credential values
// stored in plaintext by pre-fix rows to the scrypt-hash form the
// hash-on-write fix (PR 5517, T2-L10c-C1) writes and dual-reads.
//
// Field rules, per value found in a row:
//  - user_code: a legacy "XXXX-XXXX" code is replaced by user_code_hash
//    (the digest readers already authenticate against). Safe in every
//    row: nothing reads the plaintext copy except the legacy #view,
//    which falls back to the presented code.
//  - hold_secret: a legacy raw device secret is replaced by its scrypt
//    digest, which equals device_secret_hash for a well-formed row -
//    the exact shape 5517's pollHeld branches on. Run this migration
//    only once 5517 is deployed; the pre-5517 pollHeld presents the
//    stored value itself as the secret.
//  - issued_token / identity_secret: hashed only once the row can no
//    longer serve them - an approved row past replay_until, or any
//    non-approved row (which never legitimately holds live copies). A
//    live approved row keeps its plaintext copies so dual-read poll
//    delivery keeps working; the row is reported in deferredLive and a
//    later run, after the window passes, completes it. The real
//    credentials live in the authoritative credentials /
//    agent_identities stores and are never touched here.
//
// Safety: a row whose stored value matches neither the hash shape nor
// its authoritative digest is malformed - it is logged and skipped by
// id with no writes, and never denies the rest of the migration
// (one-bad-row shape). The migration only ever rewrites the four
// credential columns above, never adds or removes rows, and is
// idempotent: hashed values are recognised and left alone, so a second
// run is a no-op. The report carries pair ids and counts only - never
// a credential value.
import { scryptSync, timingSafeEqual } from "node:crypto";

// These salts and scrypt parameters must stay identical to
// server/pairing.mjs; the digests produced here are verified against
// the authoritative *_hash columns before any write, so a drift would
// surface as skipped rows, never as corrupted credentials.
const SCRYPT = { N: 16384, r: 8, p: 1 };
const CODE_SALT = "project-room-pair-code-v1";
const DEVICE_SALT = "project-room-pair-device-v1";
const TOKEN_SALT = "project-room-pair-token-v1";
const IDENTITY_SALT = "project-room-pair-identity-v1";

const HASH_HEX = /^[0-9a-f]{64}$/;
const CODE_FORMAT = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const isHashHex = value => typeof value === "string" && HASH_HEX.test(value);

const digestHex = (value, salt) => scryptSync(String(value), salt, 32, SCRYPT).toString("hex");
const digestMatches = (value, salt, hex) => {
  if (!isHashHex(hex)) return false;
  const got = scryptSync(String(value), salt, 32, SCRYPT);
  const want = Buffer.from(hex, "hex");
  return want.length === got.length && timingSafeEqual(got, want);
};

class MalformedRow extends Error {}

function planRow(row, now) {
  const updates = {};
  let deferred = false;

  if (!isHashHex(row.user_code)) {
    if (typeof row.user_code !== "string" || !CODE_FORMAT.test(row.user_code)) {
      throw new MalformedRow("user_code is neither a hash nor a legacy code");
    }
    if (!digestMatches(row.user_code.replace("-", ""), CODE_SALT, row.user_code_hash)) {
      throw new MalformedRow("user_code does not match user_code_hash");
    }
    updates.user_code = row.user_code_hash;
  }

  if (row.hold_secret != null && !isHashHex(row.hold_secret)) {
    if (!digestMatches(row.hold_secret, DEVICE_SALT, row.device_secret_hash)) {
      throw new MalformedRow("hold_secret does not match device_secret_hash");
    }
    updates.hold_secret = row.device_secret_hash;
  }

  const liveWindow = row.status === "approved" && row.replay_until != null && now <= row.replay_until;
  for (const [field, salt] of [["issued_token", TOKEN_SALT], ["identity_secret", IDENTITY_SALT]]) {
    const value = row[field];
    if (value == null || isHashHex(value)) continue;
    if (liveWindow) { deferred = true; continue; }
    updates[field] = digestHex(value, salt);
  }
  return { updates, deferred };
}

export function migratePairsPlaintext(db, { now = Date.now(), log = () => {} } = {}) {
  const report = {
    scanned: 0,
    migratedRows: 0,
    fieldsHashed: { user_code: 0, hold_secret: 0, issued_token: 0, identity_secret: 0 },
    deferredLive: [],
    skipped: []
  };
  const rows = db.prepare("SELECT * FROM pairs ORDER BY pair_id").all();
  report.scanned = rows.length;
  for (const row of rows) {
    let plan;
    try {
      plan = planRow(row, now);
    } catch (error) {
      if (!(error instanceof MalformedRow)) throw error;
      const entry = { pairId: row.pair_id, reason: error.message };
      report.skipped.push(entry);
      log(entry);
      continue;
    }
    if (plan.deferred) report.deferredLive.push(row.pair_id);
    const fields = Object.keys(plan.updates);
    if (!fields.length) continue;
    const assignments = fields.map(field => `${field}=?`).join(", ");
    db.prepare(`UPDATE pairs SET ${assignments} WHERE pair_id=?`)
      .run(...fields.map(field => plan.updates[field]), row.pair_id);
    report.migratedRows += 1;
    for (const field of fields) report.fieldsHashed[field] += 1;
  }
  return report;
}
