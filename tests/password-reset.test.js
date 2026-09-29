import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { hashPassword, verifyPassword } from "../src/password-auth.mjs";

function fixture(t) {
  let now = 1700000000000;
  const store = new RoomStore(":memory:", { now: () => now });
  t.after(() => store.close());
  store.initialize(initialRoom());
  store.createAccount("reset-owner");
  store.accountLogins.linkPasswordMethod("reset-owner", { email: "owner@example.com", verifier: hashPassword("original-password") });
  return { store, model: store.accountLogins, tick: amount => { now += amount; } };
}
const invalid = fn => assert.throws(fn, error => error.code === "invalid_password_reset");
const nextVerifier = () => hashPassword("replacement-password");

test("reset and sign-in proofs are purpose-separated without burning the other purpose", t => {
  const { model } = fixture(t);
  const reset = model.issuePasswordResetCode({ email: "owner@example.com" });
  const magic = model.issueMagicCode({ email: "owner@example.com" });
  assert.throws(() => model.consumeMagicCode({ email: reset.email, code: reset.code }), error => error.code === "invalid_magic_code");
  invalid(() => model.resetPassword({ email: magic.email, code: magic.code, verifier: nextVerifier() }));
  assert.equal(model.consumeMagicCode(magic).email, magic.email);
  assert.equal(model.resetPassword({ ...reset, verifier: nextVerifier() }).accountId, "reset-owner");
  assert.equal(verifyPassword("replacement-password", model.readPasswordVerifier("reset-owner")), true);
  invalid(() => model.resetPassword({ ...reset, verifier: nextVerifier() }));
});

test("reset proof expires, is email-bound, and a new reset burns only its preceding reset", t => {
  const { model, tick } = fixture(t);
  const first = model.issuePasswordResetCode({ email: "owner@example.com" });
  const second = model.issuePasswordResetCode({ email: first.email });
  invalid(() => model.resetPassword({ ...first, verifier: nextVerifier() }));
  invalid(() => model.resetPassword({ ...second, email: "other@example.com", verifier: nextVerifier() }));
  tick(15 * 60000);
  invalid(() => model.resetPassword({ ...second, verifier: nextVerifier() }));
});

for (const change of ["password", "disabled-method", "account", "epoch", "revoked-reactivated"]) test(`old reset proof fails after ${change} changes`, t => {
  const { model, store } = fixture(t);
  const reset = model.issuePasswordResetCode({ email: "owner@example.com" });
  if (change === "password") model.setPasswordVerifier("reset-owner", nextVerifier());
  if (change === "disabled-method") store.db.prepare("UPDATE account_login_methods SET disabled=1 WHERE account_id=?").run("reset-owner");
  if (change === "account") store.db.prepare("UPDATE accounts SET active=0 WHERE id=?").run("reset-owner");
  if (change === "revoked-reactivated") {
    model.store.changeAccountAccess("reset-owner", { expectedRevision: 0, active: false, reason: "Synthetic revoke" });
    model.store.changeAccountAccess("reset-owner", { expectedRevision: 1, active: true, reason: "Synthetic restore" });
  }
  if (change === "epoch") store.db.prepare("UPDATE accounts SET auth_epoch=auth_epoch+1 WHERE id=?").run("reset-owner");
  invalid(() => model.resetPassword({ ...reset, verifier: nextVerifier() }));
});

test("unknown email cannot create an account and wrong attempts burn the reset window", t => {
  const { model, store } = fixture(t);
  const count = store.db.prepare("SELECT count(*) AS n FROM accounts").get().n;
  const unknown = model.issuePasswordResetCode({ email: "unknown@example.com" });
  invalid(() => model.resetPassword({ ...unknown, verifier: nextVerifier() }));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM accounts").get().n, count);
  const reset = model.issuePasswordResetCode({ email: "owner@example.com" });
  for (let attempt = 0; attempt < 5; attempt++) invalid(() => model.resetPassword({ ...reset, code: "wrong-proof", verifier: nextVerifier() }));
  invalid(() => model.resetPassword({ ...reset, verifier: nextVerifier() }));
});

test("password update failure rolls back proof use and credential revocation", t => {
  const { model, store } = fixture(t);
  const reset = model.issuePasswordResetCode({ email: "owner@example.com" });
  const key = store.issueAccountAccessKey("reset-owner");
  store.db.exec("CREATE TRIGGER deny_reset BEFORE UPDATE OF verifier ON account_login_methods BEGIN SELECT RAISE(ABORT,'test reset failure'); END;");
  assert.throws(() => model.resetPassword({ ...reset, verifier: nextVerifier() }), /test reset failure/);
  assert.equal(store.authenticateAccountAccessKey(key).account.id, "reset-owner");
  store.db.exec("DROP TRIGGER deny_reset");
  model.resetPassword({ ...reset, verifier: nextVerifier() });
  assert.throws(() => store.authenticateAccountAccessKey(key), error => error.status === 401);
});
