import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// Sibling of the PR #1692 email-verification bypass class: the f520ca69
// gates ("unverified accounts get 403 email_unverified on invite") were
// applied to agent-invites.create and membership-invitation issue, but
// share-link issuance never got the gate. An unverified account that owns
// its first room (room-lifecycle's zero-membership exemption) can mint
// share links and recruit strangers, while the sibling invite paths 403.
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "share-email-gate-"));
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

const details = () => ({
  requestId: randomUUID(),
  linkToken: randomBytes(32).toString("base64url"),
  expiresAt: Date.now() + 3600000,
  maxJoins: 2,
  expectedMemberRevision: 0,
});

test("EXPLOIT: unverified account owner mints share links — email gate missing", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: false });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified");
  // Sibling issuance paths 403 here: agent-invites.create and the
  // membership-invitation issue path both call assertEmailVerified.
  assert.throws(
    () => store.shareLinks.create(token, "commons", details(), binding),
    err => err.code === "email_unverified",
    "shareLinks.create must refuse unverified accounts like its sibling invite paths",
  );
});

test("verified account owner can still mint share links (no regression)", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: true });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "verified");
  const created = store.shareLinks.create(token, "commons", details(), binding);
  assert.equal(created.link.status, "active");
});

test("accountless owner bearer still mints (no account to verify)", t => {
  const store = fixture(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const created = store.shareLinks.create(ownerKey, "commons", details(), null);
  assert.equal(created.link.status, "active");
});

// Same gate class on the GX guest-invite mint: ownerGate requires an
// account session but never checked verification, so an unverified owner
// could mint single-use guest codes while agent-invites 403 them.
const gxDetails = () => ({ requestId: randomUUID(), guestLabel: "Synapse visit", expectedOwnerRevision: 0 });

test("EXPLOIT: unverified account owner mints GX guest invites — email gate missing", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: false });
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified");
  assert.throws(
    () => store.guestInvites.mint(token, "commons", gxDetails(), binding),
    err => err.code === "email_unverified",
    "guestInvites.mint must refuse unverified accounts like its sibling invite paths",
  );
});

test("verified account owner can still mint GX guest invites (no regression)", t => {
  const store = fixture(t);
  const { token, binding } = ownerAccountSession(store, { verified: true });
  const minted = store.guestInvites.mint(token, "commons", gxDetails(), binding);
  assert.equal(minted.duplicate, false);
  assert.match(minted.code, /^GX-/);
});
