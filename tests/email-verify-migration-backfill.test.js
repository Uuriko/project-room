// Regression sweep 2026-10-08 (QA200-REG-06): the one-time
// ensureVerifiedEmailSchema backfill from f520ca69a ("Verify email before it
// proves an account, and issue room-scoped MCP tokens") had no behavioral
// coverage — only the source-stamp pin in schema-stamp-coverage.test.js.
//
// The backfill classifies pre-verified_at databases:
//   - oauth rows with an email        -> verified (provider attested the email)
//   - magic rows with an email        -> verified, UNLESS the account's origin
//                                        is 'password-signup' (those came from
//                                        an unverified password signup and
//                                        must stay unverified)
//   - password rows                   -> never touched
//
// Security contract: if the password-signup exclusion regresses (e.g. someone
// "simplifies" the backfill to mark every magic row verified), accounts that
// never proved their email would flip emailStatus() from "unverified" to
// "verified" and sail through assertEmailVerified(). This test fails first on
// that regression.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureVerifiedEmailSchema } from "../server/account-login-methods.mjs";

// The pre-f520ca69 schema: account_login_methods WITHOUT verified_at, and
// accounts WITHOUT password_reset_required.
function openLegacyDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      active INTEGER NOT NULL CHECK(active IN (0,1)),
      revision INTEGER NOT NULL,
      auth_epoch INTEGER NOT NULL,
      origin TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE account_login_methods (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id),
      type TEXT NOT NULL CHECK(type IN ('password','magic','oauth','passkey','recovery-code-set')),
      provider TEXT,
      label TEXT NOT NULL,
      email TEXT,
      email_hash TEXT,
      verifier TEXT,
      external_subject TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1))
    );
  `);
  return db;
}

const T = 1700000000000;
const insertAccount = (db, id, origin) =>
  db.prepare("INSERT INTO accounts(id,active,revision,auth_epoch,origin,created_at) VALUES(?,1,0,0,?,?)")
    .run(id, origin, T);
const insertMethod = (db, { id, accountId, type, provider = null, email = null, createdAt = T }) =>
  db.prepare(`INSERT INTO account_login_methods(id,account_id,type,provider,label,email,email_hash,verifier,external_subject,created_at,last_used_at,disabled)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`)
    .run(id, accountId, type, provider, `${type} label`, email, email ? `hash:${email}` : null,
      null, null, createdAt, null);
const verifiedAt = (db, id) =>
  db.prepare("SELECT verified_at FROM account_login_methods WHERE id=?").get(id).verified_at;

test("email backfill: oauth and non-password-signup magic rows verify; password-signup magic stays unverified", () => {
  const db = openLegacyDb();
  insertAccount(db, "acct-pwsignup", "password-signup");
  insertAccount(db, "acct-oauth", "github");
  insertAccount(db, "acct-other", "magic-link");

  insertMethod(db, { id: "m-oauth", accountId: "acct-oauth", type: "oauth", provider: "github", email: "ada@example.com" });
  insertMethod(db, { id: "m-oauth-noemail", accountId: "acct-oauth", type: "oauth", provider: "github" });
  insertMethod(db, { id: "m-magic-other", accountId: "acct-other", type: "magic", email: "bob@example.com" });
  insertMethod(db, { id: "m-magic-pwsignup", accountId: "acct-pwsignup", type: "magic", email: "unproven@example.com" });
  insertMethod(db, { id: "m-password", accountId: "acct-pwsignup", type: "password", email: "unproven@example.com" });

  ensureVerifiedEmailSchema(db);

  // verified_at = created_at for provider-attested and non-password-signup magic rows
  assert.equal(verifiedAt(db, "m-oauth"), T);
  assert.equal(verifiedAt(db, "m-magic-other"), T);
  // oauth rows without an email prove nothing
  assert.equal(verifiedAt(db, "m-oauth-noemail"), null);
  // THE security case: magic rows on password-signup-origin accounts were
  // created by an unverified password signup — they must stay unverified
  assert.equal(verifiedAt(db, "m-magic-pwsignup"), null);
  // password rows are never backfilled
  assert.equal(verifiedAt(db, "m-password"), null);

  db.close();
});

test("email backfill: additive columns and security-event journal are created, rerun is a no-op", () => {
  const db = openLegacyDb();
  insertAccount(db, "acct-1", "password-signup");
  insertMethod(db, { id: "m1", accountId: "acct-1", type: "magic", email: "unproven@example.com" });

  ensureVerifiedEmailSchema(db);

  const cols = new Set(db.prepare("PRAGMA table_info(account_login_methods)").all().map(c => c.name));
  assert.ok(cols.has("verified_at"), "verified_at column added");
  const acctCols = new Set(db.prepare("PRAGMA table_info(accounts)").all().map(c => c.name));
  assert.ok(acctCols.has("password_reset_required"), "password_reset_required column added");
  assert.equal(db.prepare("SELECT password_reset_required FROM accounts WHERE id=?").get("acct-1").password_reset_required, 0);
  const journal = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account_security_events'").get();
  assert.ok(journal, "account_security_events journal created");
  const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='account_security_event_account'").get();
  assert.ok(index, "account_security_events index created");

  // Idempotent: a second run must not rewrite anything (the WHERE
  // verified_at IS NULL guard) and must not throw on the ALTER.
  const before = db.prepare("SELECT id, verified_at FROM account_login_methods ORDER BY id").all();
  ensureVerifiedEmailSchema(db);
  const after = db.prepare("SELECT id, verified_at FROM account_login_methods ORDER BY id").all();
  assert.deepEqual(after, before);

  db.close();
});
