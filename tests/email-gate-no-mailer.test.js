// Every email-verification gate follows the agent-invites escape hatch: when no
// mailer is configured a verification code can never be delivered, so the gate
// must not deadlock the account; where a mailer exists it still refuses.
// Store-level cases flip the same predicate the HTTP layer installs
// (!magicMailer.isConfigured()); the HTTP cases drive the real server.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

function unverifiedOwner(t) {
  const directory = mkdtempSync(join(tmpdir(), "email-gate-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons", "owner"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.createAccount("owner-acct", "password-signup");
  store.accountLogins.linkPasswordMethod("owner-acct", { email: "gate@example.com", verifier: "scrypt$v1$test" });
  store.bindHumanAccount("commons", "owner", "owner-acct");
  const key = store.issueAccountAccessKey("owner-acct");
  const slot = store.createAccountSessionSlot();
  const session = store.loginAccountSession(slot.token, key, 0);
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified");
  return { store, token: slot.token, binding: session.sessionBinding };
}
const unachievable = (store, value) => store.accountLogins.setVerificationUnachievable(() => value);

test("assertEmailVerified and emailGateBlocks: refuse with a mailer, pass without", t => {
  const { store } = unverifiedOwner(t);
  unachievable(store, false);
  assert.equal(store.accountLogins.emailGateBlocks("owner-acct"), true);
  assert.throws(() => store.accountLogins.assertEmailVerified("owner-acct"), e => e.code === "email_unverified");
  unachievable(store, true);
  assert.equal(store.accountLogins.emailGateBlocks("owner-acct"), false);
  assert.doesNotThrow(() => store.accountLogins.assertEmailVerified("owner-acct"));
  assert.equal(store.accountLogins.emailStatus("owner-acct"), "unverified", "the account still reads unverified");
});

test("personal invite on the board: blocked with a mailer, minted without", t => {
  const { store, token, binding } = unverifiedOwner(t);
  unachievable(store, false);
  const blocked = store.referrals.board(token, "commons", binding);
  assert.equal(blocked.invite, null);
  assert.equal(blocked.inviteBlocked, "email_unverified");
  unachievable(store, true);
  const open = store.referrals.board(token, "commons", binding);
  assert.equal(typeof open.invite?.token, "string");
  assert.equal("inviteBlocked" in open, false);
});

test("membership invitation issue: refused with a mailer, issued without", t => {
  const { store, token, binding } = unverifiedOwner(t);
  store.createAccount("target-acct");
  const issue = id => store.issueInvitation(token, "commons", {
    requestId: id, token: randomBytes(32).toString("base64url"), intendedAccountId: "target-acct", intendedMemberId: `m-${id}`,
    displayName: "Target", role: "member", expiresAt: Date.now() + 3600000,
    expectedIssuerMemberRevision: store.room("commons").state.members.owner.revision, expectedSessionBinding: binding,
  });
  unachievable(store, false);
  assert.throws(() => issue("gate-a"), e => e.code === "email_unverified");
  unachievable(store, true);
  assert.equal(issue("gate-b").invitation.status, "pending");
});

test("guest invite mint: refused with a mailer, minted without", t => {
  const { store, token, binding } = unverifiedOwner(t);
  const mint = () => store.guestInvites.mint(token, "commons", { requestId: randomUUID(), guestLabel: "Guest project",
    expectedOwnerRevision: store.room("commons").state.members.owner.revision }, binding);
  unachievable(store, false);
  assert.throws(mint, e => e.code === "email_unverified");
  unachievable(store, true);
  assert.ok(mint());
});

async function http(t, mailer) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...(mailer ? { magicLinkMailer: mailer } : {}) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(origin + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(data) });
  const n = String(Date.now() % 1000000);
  const slot = f.store.createAccountSessionSlot();
  const signup = await post("/api/auth/password/signup", { email: `gate-${n}@example.invalid`, password: `gate-password-${n}-long-enough`, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(signup.status, 202);
  const token = /account_session=([^;]+)/.exec(signup.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  const headers = { Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf, "X-Session-Binding": session.sessionBinding };
  const room = id => post("/api/account-rooms", { roomId: `${id}${n}`, title: "Den", purpose: "Gate", kind: "personal", displayName: "Owner" }, headers);
  assert.equal((await room("first")).status, 201);
  return { post, headers, room };
}

test("HTTP: a second room and an identity mint work for an unverified account when no mailer exists", async t => {
  const { post, headers, room } = await http(t);
  assert.equal((await room("second")).status, 201);
  assert.equal((await post("/api/agent-identities", { displayName: "No mailer mint" }, { Cookie: headers.Cookie })).status, 201);
});

test("HTTP: the same second room and identity mint are still refused when a mailer is configured", async t => {
  const { post, headers, room } = await http(t, createMagicLinkMailer({ send: async () => {} }));
  const second = await room("second");
  assert.equal(second.status, 403);
  assert.equal((await post("/api/agent-identities", { displayName: "Mailer mint" }, { Cookie: headers.Cookie })).status, 403);
});
