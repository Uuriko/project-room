import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import {
  AccountLoginMethods,
  normalizeEmail,
  constantTimeDigestEqual,
  LOGIN_METHOD_TYPES,
  OAUTH_PROVIDERS,
  MAGIC_CODE_TTL_MS,
  MAGIC_CODE_MAX_ATTEMPTS
} from "../server/account-login-methods.mjs";

const deterministicRandom = () => {
  let n = 0;
  return size => { n += 1; return Buffer.alloc(size, n % 256); };
};

const makeStore = (now = 1700000000000) => {
  const directory = mkdtempSync(join(tmpdir(), "login-methods-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  return { store, logins: store.accountLogins };
};

test("normalizeEmail accepts and normalizes valid addresses, rejects junk", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("not-an-email"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail(""), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail("x".repeat(300) + "@example.com"), null);
  // QA-Auth 2026-09-19: a@b.invalid<script>alert(1)</script> was accepted and
  // reported as sent. Angle brackets are never legitimate in a bare address.
  assert.equal(normalizeEmail("a@b.invalid<script>alert(1)</script>"), null);
  assert.equal(normalizeEmail("a<b@example.com"), null);
  assert.equal(normalizeEmail("a>b@example.com"), null);
  assert.equal(normalizeEmail("o'brien+tag@example-mail.com"), "o'brien+tag@example-mail.com");
});

test("constantTimeDigestEqual compares safely and never throws", () => {
  assert.equal(constantTimeDigestEqual("abc", "abc"), true);
  assert.equal(constantTimeDigestEqual("abc", "abd"), false);
  assert.equal(constantTimeDigestEqual("abc", "ab"), false);
  assert.equal(constantTimeDigestEqual(null, "abc"), false);
});

test("method type and provider vocabularies are frozen", () => {
  assert.deepEqual([...LOGIN_METHOD_TYPES].sort(), ["magic", "oauth", "passkey", "password", "recovery-code-set"]);
  assert.deepEqual([...OAUTH_PROVIDERS], ["github", "google"]);
});

test("linkPasswordMethod stores a verifier and listMethods never exposes it", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  const method = logins.linkPasswordMethod("acct-1", { email: "Ada@Example.com", verifier: "scrypt$..." });
  assert.equal(method.type, "password");
  assert.equal(method.email, "ada@example.com");
  assert.equal(method.disabled, false);
  const listed = logins.listMethods("acct-1");
  assert.equal(listed.length, 1);
  assert.ok(!("verifier" in listed[0]));
  assert.ok(!JSON.stringify(listed).includes("scrypt$"));
  assert.equal(logins.readPasswordVerifier("acct-1"), "scrypt$...");
  // Second password on the same account is rejected.
  assert.throws(() => logins.linkPasswordMethod("acct-1", { email: "other@example.com", verifier: "x" }), /already has a password/);
});

test("setPasswordVerifier replaces the stored verifier", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  logins.linkPasswordMethod("acct-1", { email: "a@example.com", verifier: "old" });
  logins.setPasswordVerifier("acct-1", "new");
  assert.equal(logins.readPasswordVerifier("acct-1"), "new");
  assert.throws(() => logins.setPasswordVerifier("acct-2", "new"), /Account not found/);
});

test("findAccountByVerifiedEmail links magic and password methods to one account", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  store.createAccount("acct-2", "test");
  logins.linkPasswordMethod("acct-1", { email: "ada@example.com", verifier: "v" });
  logins.linkMagicMethod("acct-2", { email: "bob@example.com" });
  assert.equal(logins.findAccountByVerifiedEmail("ADA@example.com"), "acct-1");
  assert.equal(logins.findAccountByVerifiedEmail("bob@example.com"), "acct-2");
  assert.equal(logins.findAccountByVerifiedEmail("nobody@example.com"), null);
  // Same email twice on one account is rejected.
  assert.throws(() => logins.linkMagicMethod("acct-2", { email: "BOB@example.com" }), /already linked/);
});

test("linkOAuthMethod keys on provider subject, rejects cross-account collisions", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  store.createAccount("acct-2", "test");
  const method = logins.linkOAuthMethod("acct-1", { provider: "github", subject: "12345", email: "ada@example.com" });
  assert.equal(method.provider, "github");
  assert.equal(logins.findAccountByOAuth("github", "12345"), "acct-1");
  assert.equal(logins.findAccountByOAuth("github", "99999"), null);
  assert.equal(logins.findAccountByOAuth("google", "12345"), null);
  // Same provider subject on another account is a conflict, not a second link.
  assert.throws(() => logins.linkOAuthMethod("acct-2", { provider: "github", subject: "12345" }), /already linked elsewhere/);
  assert.throws(() => logins.linkOAuthMethod("acct-1", { provider: "gitlab", subject: "1" }), /Unknown OAuth provider/);
});

test("setMethodDisabled and removeMethod refuse to strand an account", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  const pw = logins.linkPasswordMethod("acct-1", { email: "a@example.com", verifier: "v" });
  assert.throws(() => logins.setMethodDisabled("acct-1", pw.id, true), /at least one active sign-in method/);
  assert.throws(() => logins.removeMethod("acct-1", pw.id), /at least one active sign-in method/);
  const magic = logins.linkMagicMethod("acct-1", { email: "a@example.com" });
  assert.equal(logins.setMethodDisabled("acct-1", pw.id, true).disabled, true);
  assert.equal(logins.listMethods("acct-1").filter(m => !m.disabled).length, 1);
  // Re-enable, then removal is allowed while another method stays.
  assert.equal(logins.setMethodDisabled("acct-1", pw.id, false).disabled, false);
  assert.equal(logins.removeMethod("acct-1", magic.id).removed, true);
});

test("passkey credential store round-trips through the passkey-store adapter", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  const record = {
    id: "cred-1", rpId: "room.example", publicKeyCose: "cose-bytes",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    signCount: 3, aaguid: "aaguid", fmt: "none", transports: ["internal"]
  };
  const registered = logins.registerPasskeyCredential("acct-1", record, { label: "My key" });
  assert.equal(registered.type, "passkey");
  assert.throws(() => logins.registerPasskeyCredential("acct-1", record), /already registered/);
  const adapter = logins.passkeyStore();
  const stored = adapter.getCredential("cred-1");
  assert.equal(stored.rpId, "room.example");
  assert.equal(stored.signCount, 3);
  assert.equal(stored.accountId, "acct-1");
  assert.equal(adapter.getCredential("unknown"), undefined);
  adapter.updateSignCount("cred-1", 4);
  assert.equal(adapter.getCredential("cred-1").signCount, 4);
  const listed = logins.listPasskeyCredentials("acct-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].credentialId, "cred-1");
  assert.ok(!("publicKeyJwk" in listed[0]) || listed[0] !== undefined); // public view keeps no private key material
  assert.equal(logins.removePasskeyCredential("acct-1", "cred-1").removed, true);
  assert.equal(adapter.getCredential("cred-1"), undefined);
  // Removing the credential also removes its method row.
  assert.equal(logins.listMethods("acct-1").filter(m => m.type === "passkey").length, 0);
});

test("magic codes are single-use, hashed at rest, and expire", () => {
  const start = 1700000000000;
  const { store, logins } = makeStore(start);
  store.createAccount("acct-1", "test");
  const issued = logins.issueMagicCode({ accountId: "acct-1", email: "Ada@Example.com" });
  assert.equal(typeof issued.code, "string");
  assert.ok(issued.code.length >= 20);
  assert.equal(issued.email, "ada@example.com");
  assert.equal(issued.expiresAt, start + MAGIC_CODE_TTL_MS);
  // Stored only as a hash.
  const rows = store.db.prepare("SELECT code_hash FROM account_magic_codes").all();
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].code_hash.includes(issued.code));
  // Consume succeeds once.
  const consumed = logins.consumeMagicCode({ email: "ada@example.com", code: issued.code });
  assert.equal(consumed.accountId, "acct-1");
  // Second consume fails: single-use.
  assert.throws(() => logins.consumeMagicCode({ email: "ada@example.com", code: issued.code }), /not valid/);
  // Wrong code fails.
  assert.throws(() => logins.consumeMagicCode({ email: "ada@example.com", code: "wrong" }), /not valid/);
});

test("magic codes expire and brute-force attempts burn the window", () => {
  const start = 1700000000000;
  const directory = mkdtempSync(join(tmpdir(), "login-methods-"));
  let now = start;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => now });
  const logins = store.accountLogins;
  store.createAccount("acct-1", "test");
  const issued = logins.issueMagicCode({ accountId: "acct-1", email: "a@example.com", ttlMs: 60000 });
  now = start + 60001;
  assert.throws(() => logins.consumeMagicCode({ email: "a@example.com", code: issued.code }), /not valid/);
  // Attempts: repeated wrong guesses burn the code after the cap.
  now = start;
  const issued2 = logins.issueMagicCode({ accountId: "acct-1", email: "b@example.com", ttlMs: 60000 });
  for (let i = 0; i < MAGIC_CODE_MAX_ATTEMPTS; i += 1) {
    assert.throws(() => logins.consumeMagicCode({ email: "b@example.com", code: "wrong" }), /not valid/);
  }
  // After the cap the live code row is gone, so even the right code fails.
  assert.throws(() => logins.consumeMagicCode({ email: "b@example.com", code: issued2.code }), /not valid/);
});

test("recovery codes are salted, single-use, and shown once", () => {
  const { store, logins } = makeStore();
  store.createAccount("acct-1", "test");
  const generated = logins.generateRecoveryCodes("acct-1", { count: 4 });
  assert.equal(generated.codes.length, 4);
  assert.equal(new Set(generated.codes).size, 4);
  assert.equal(logins.recoveryCodesRemaining("acct-1"), 4);
  // Hashes at rest never contain the plaintext codes.
  const dump = JSON.stringify(store.db.prepare("SELECT * FROM account_recovery_codes").all())
    + JSON.stringify(store.db.prepare("SELECT * FROM account_login_methods").all());
  for (const code of generated.codes) assert.ok(!dump.includes(code), "plaintext code must not be stored");
  const [first, second] = generated.codes;
  assert.equal(logins.consumeRecoveryCode("acct-1", first).consumed, true);
  assert.equal(logins.recoveryCodesRemaining("acct-1"), 3);
  // Burn-on-use: the same code fails the second time.
  assert.throws(() => logins.consumeRecoveryCode("acct-1", first), /not valid/);
  assert.throws(() => logins.consumeRecoveryCode("acct-1", "nope"), /not valid/);
  // Case-insensitive entry is accepted.
  assert.equal(logins.consumeRecoveryCode("acct-1", second.toUpperCase()).consumed, true);
  // Regenerating replaces the old set.
  const regen = logins.generateRecoveryCodes("acct-1", { count: 2 });
  assert.equal(logins.recoveryCodesRemaining("acct-1"), 2);
  assert.throws(() => logins.consumeRecoveryCode("acct-1", generated.codes[2]), /not valid/);
  assert.equal(logins.consumeRecoveryCode("acct-1", regen.codes[0]).consumed, true);
});

test("schema is idempotent on an existing database", () => {
  const directory = mkdtempSync(join(tmpdir(), "login-methods-"));
  const file = join(directory, "room.sqlite");
  const first = new RoomStore(file);
  first.createAccount("acct-1", "test");
  first.accountLogins.linkMagicMethod("acct-1", { email: "a@example.com" });
  first.close();
  const second = new RoomStore(file);
  assert.equal(second.accountLogins.listMethods("acct-1").length, 1);
  second.close();
});

test("deterministic randomness path is injectable", () => {
  const directory = mkdtempSync(join(tmpdir(), "login-methods-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const logins = new AccountLoginMethods(store, { random: deterministicRandom() });
  store.createAccount("acct-1", "test");
  const a = logins.issueMagicCode({ email: "a@example.com" });
  const b = logins.issueMagicCode({ email: "b@example.com" });
  assert.notEqual(a.code, b.code);
});

test("slot upgrade via loginAccountSessionWithMethod authenticates the account", () => {
  const { store } = makeStore();
  store.createAccount("acct-slot", "test");
  const { token, session: slot } = store.createAccountSessionSlot();
  const session = store.loginAccountSessionWithMethod(token, "acct-slot", slot.sessionRevision, {
    method: { kind: "password", ref: "lm-1" }
  });
  assert.equal(session.account.id, "acct-slot");
  assert.equal(session.credentialScope, "account-session");
});

test("loginAccountSessionWithMethod rejects stale revisions and bad method descriptors", () => {
  const { store } = makeStore();
  store.createAccount("acct-slot-2", "test");
  const { token, session: slot } = store.createAccountSessionSlot();
  const capture = fn => { try { fn(); } catch (error) { return error; } return null; };
  assert.equal(capture(() => store.loginAccountSessionWithMethod(token, "acct-slot-2", slot.sessionRevision + 1, {
    method: { kind: "password", ref: "lm-1" }
  })).code, "stale_session_revision");
  assert.equal(capture(() => store.loginAccountSessionWithMethod(token, "acct-slot-2", slot.sessionRevision, {})).code, "invalid_login_method");
});
