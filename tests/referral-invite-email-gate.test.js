import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Sibling of the share-links (share-links-email-gate.test.js) and GX
// guest-invite email-verification bypass class: the f520ca69 gates
// ("unverified accounts get 403 email_unverified on invite issuance")
// were applied to agent-invites.create, guest-invites.mint, share-link
// issuance, and membership-invitation issue, but referral-invites.mint
// never got the gate. An unverified account that owns its first room
// (room-lifecycle's zero-membership exemption) can mint signed referral
// tokens and recruit strangers, while every sibling invite path 403s.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "referral-email-gate-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

function ownerAccountSession(store, { verified }) {
  store.createAccount("owner-acct", "password-signup");
  store.accountLogins.linkPasswordMethod("owner-acct", { email: "unverified@example.com", verifier: "scrypt$v1$test" });
  if (verified) {
    const issued = store.accountLogins.issueEmailVerifyCode({ accountId: "owner-acct", email: "unverified@example.com" });
    store.accountLogins.consumeEmailVerifyCode({ accountId: "owner-acct", code: issued.code });
  }
  store.bindHumanAccount("commons", "owner", "owner-acct");
  const key = store.issueAccountAccessKey("owner-acct");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { token: slot.token, binding: session.sessionBinding };
}

test("EXPLOIT: unverified account owner mints referral invites — email gate missing", t => {
  const store = fixture(t);
  const { token } = ownerAccountSession(store, { verified: false });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified");
  // Sibling issuance paths 403 here: agent-invites.create, guest-invites.mint,
  // share-links.create, and membership-invitation issue all call
  // assertEmailVerified for account-based issuers.
  assert.throws(
    () => store.referralInvites.mint(token, "commons", {}),
    err => err.code === "email_unverified",
    "referralInvites.mint must refuse unverified accounts like its sibling invite paths",
  );
});

test("verified account owner can still mint referral invites (no regression)", t => {
  const store = fixture(t);
  const { token } = ownerAccountSession(store, { verified: true });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "verified");
  const minted = store.referralInvites.mint(token, "commons", {});
  assert.match(minted.token, /^ref1\./);
  assert.equal(minted.roomId, "commons");
});

test("accountless owner Bearer <redacted> mints (no account to verify)", t => {
  const store = fixture(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const minted = store.referralInvites.mint(ownerKey, "commons", {});
  assert.match(minted.token, /^ref1\./);
});
