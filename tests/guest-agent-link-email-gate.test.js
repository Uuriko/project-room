import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Sibling of the share-links-email-gate and GX guest-invite email-gate
// class (commit 802b2301a, PR #1797's referral-invite gate): the f520ca69
// gates ("unverified accounts get 403 email_unverified on invite issuance")
// were applied to agent-invites.create, share-links.create,
// guest-invites.mint, and membership-invitation issue, but the legacy ga1.
// guest-agent-link mint never got the gate. An unverified account that owns
// its first room (room-lifecycle's zero-membership exemption) can mint ga1.
// guest-agent tokens (2h read+chat credentials, 10 concurrent joins) and
// recruit strangers, while every sibling invite path 403s.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "ga1-email-gate-"));
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

const details = () => ({ requestId: randomUUID(), expectedOwnerRevision: 0 });

test("EXPLOIT: unverified account owner mints ga1. guest-agent links — email gate missing", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: false });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified");
  // Sibling issuance paths 403 here: agent-invites.create, share-links.create,
  // guest-invites.mint, and membership-invitation issue all call
  // assertEmailVerified for account-based issuers.
  assert.throws(
    () => store.guestAgentLinks.mint(token, "commons", details(), binding),
    err => err.code === "email_unverified",
    "guestAgentLinks.mint must refuse unverified accounts like its sibling invite paths",
  );
});

test("verified account owner can still mint ga1. guest-agent links (no regression)", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: true });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "verified");
  const minted = store.guestAgentLinks.mint(token, "commons", details(), binding);
  assert.equal(minted.duplicate, false);
  assert.match(minted.token, /^ga1\./);
});
