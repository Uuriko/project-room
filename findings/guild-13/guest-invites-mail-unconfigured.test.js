// Fail-first regression test for the guest-invite funnel deadlock.
//
// Bug: GuestInvites.mint (server/guest-invites.mjs) carries the f520ca69
// email-verification gate WITHOUT the emailVerificationUnachievable bypass
// that AgentInvites.create got (see
// tests/agent-invites-mail-unconfigured.test.js). On a deployment whose
// mailer is unconfigured, an unverified owner can never verify, so guest
// invite mint is a permanent 403 — the same funnel deadlock class, one path
// over.
//
// Desired: unverified owner mints a guest invite (201) when verification is
// unachievable. Fails on current code with 403 email_unverified.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

const { RoomStore } = await import(join(REPO, "server/store.mjs"));
const { initialRoom } = await import(join(REPO, "server/bootstrap.mjs"));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "g13-guest-funnel-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("FUNNEL: unverified owner mints a guest invite when mail is unconfigured", t => {
  const store = fixture(t);
  const accountId = "acct-guest-funnel-1";
  store.createAccount(accountId);
  // Unverified email login method, like password signup creates.
  store.db.prepare(`INSERT INTO account_login_methods(id,account_id,type,label,email,email_hash,verifier,created_at,disabled)
    VALUES(?,?,?,?,?,?,?,?,0)`)
    .run("lm-gf-1", accountId, "password", "funnel", "funnel@example.com", "h", "v", Date.now());
  assert.equal(store.accountLogins.emailStatus(accountId), "unverified");
  // Bind the account to the owner member, as an account-room does.
  store.db.prepare("INSERT OR IGNORE INTO member_accounts(room_id,member_id,account_id,origin) VALUES(?,?,?,?)")
    .run("commons", "owner", accountId, "test");
  const key = store.issueAccessKey("commons", "owner");
  assert.equal(store.authenticate(key, "commons").account?.id, accountId);
  // No mailer is configured in this fixture: verification is unachievable,
  // so the gate must not bite (same contract as agent-invite mint).
  const minted = store.guestInvites.mint(key, "commons", {
    requestId: randomUUID(), guestLabel: "funnel", expectedOwnerRevision: 0,
  });
  assert.match(minted.code, /^GX-/);
});
