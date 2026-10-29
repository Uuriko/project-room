import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentErrorAx } from "../src/agent-error.mjs";
import { invitationManagementFailureMessage } from "../src/share-links.js";

// #3960: a first-session founder creating their first share link hit two
// misdiagnoses — (1) one bundled 422 naming the join limit and the
// membership when the malformed field was the link token, and (2) a 403
// email_unverified whose next[] told the OWNER to run room_check_access
// and "Ask the owner to mint a guest invite or Add agent", naming no
// verify/resend remedy. These tests pin the per-field 422s, the AX
// envelope, and the dialog copy.

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "share-3960-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createAccount("owner-acct", "password-signup");
  store.accountLogins.linkPasswordMethod("owner-acct", { email: "founder@example.com", verifier: "scrypt$v1$test" });
  const issued = store.accountLogins.issueEmailVerifyCode({ accountId: "owner-acct", email: "founder@example.com" });
  store.accountLogins.consumeEmailVerifyCode({ accountId: "owner-acct", code: issued.code });
  store.bindHumanAccount("commons", "owner", "owner-acct");
  const key = store.issueAccountAccessKey("owner-acct");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  return { store, token: slot.token, binding: session.sessionBinding };
}

const details = (overrides = {}) => ({
  requestId: randomUUID(),
  linkToken: randomBytes(32).toString("base64url"),
  expiresAt: Date.now() + 3600000,
  maxJoins: 5,
  expectedMemberRevision: 0,
  ...overrides,
});

test("422 names the malformed link token, not the join limit or membership", t => {
  const { store, token, binding } = fixture(t);
  assert.throws(
    () => store.shareLinks.create(token, "commons", details({ linkToken: "not-a-token" }), binding),
    err => err.status === 422 && err.code === "invalid_link"
      && /link token is malformed/.test(err.message)
      && !/join limit/.test(err.message) && !/membership/.test(err.message),
  );
});

test("422 names the join limit only when the join limit is the failing field", t => {
  const { store, token, binding } = fixture(t);
  assert.throws(
    () => store.shareLinks.create(token, "commons", details({ maxJoins: 26 }), binding),
    err => err.status === 422 && err.code === "invalid_link"
      && /join limit between 1 and 25/.test(err.message)
      && !/link token/.test(err.message) && !/membership/.test(err.message),
  );
});

test("422 names the stale membership view only when the revision is the failing field", t => {
  const { store, token, binding } = fixture(t);
  assert.throws(
    () => store.shareLinks.create(token, "commons", details({ expectedMemberRevision: -1 }), binding),
    err => err.status === 422 && err.code === "invalid_link"
      && /membership/.test(err.message) && !/join limit/.test(err.message),
  );
});

test("a well-formed create still succeeds (validation split is not a new gate)", t => {
  const { store, token, binding } = fixture(t);
  const result = store.shareLinks.create(token, "commons", details(), binding);
  assert.equal(result.link.status, "active");
});

test("email_unverified AX envelope names the verify/resend remedy, never the owner self-loop", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "email_unverified", message: "Verify your email before this action" });
  assert.equal(ax.reason, "email_unverified");
  assert.match(ax.hint, /verified email/);
  const nextText = JSON.stringify(ax.next);
  assert.match(nextText, /email\/verify\/resend/);
  assert.doesNotMatch(`${ax.hint} ${nextText}`, /Ask the owner to mint|room_check_access/);
});

test("share-link dialog copy for email_unverified names Sign-in & security resend and kept settings", () => {
  const message = invitationManagementFailureMessage({ code: "email_unverified", status: 403, message: "Verify your email before this action" }, "create");
  assert.match(message, /Sign-in & security/);
  assert.match(message, /resend the verification email/);
  assert.match(message, /settings are kept/);
});
