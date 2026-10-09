// An unverified owner gets no personal invite link (share-links email gate).
// The referral board says why, so the Invite dialog is not an empty dead end.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function board(t, { verified }) {
  const directory = mkdtempSync(join(tmpdir(), "invite-notice-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createAccount("owner-acct", "password-signup");
  store.accountLogins.linkPasswordMethod("owner-acct", { email: "notice@example.com", verifier: "scrypt$v1$test" });
  if (verified) {
    const issued = store.accountLogins.issueEmailVerifyCode({ accountId: "owner-acct", email: "notice@example.com" });
    store.accountLogins.consumeEmailVerifyCode({ accountId: "owner-acct", code: issued.code });
  }
  store.bindHumanAccount("commons", "owner", "owner-acct");
  const key = store.issueAccountAccessKey("owner-acct");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return store.referrals.board(slot.token, "commons", session.sessionBinding);
}

test("an unverified owner's board has no invite and says email_unverified", t => {
  const result = board(t, { verified: false });
  assert.equal(result.invite, null);
  assert.equal(result.inviteBlocked, "email_unverified");
});

test("a verified owner's board has the invite and no blocked reason", t => {
  const result = board(t, { verified: true });
  assert.equal(typeof result.invite?.token, "string");
  assert.equal("inviteBlocked" in result, false);
});
