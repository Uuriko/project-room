// Auth audit 2026-10-09, path 13: a guest who joined from a link could not keep
// the account (Set a password needs an email; there was no way to add one).
// POST /api/auth/guest/upgrade then /confirm adds a verified email and a
// password to the same account, keeping its rooms, without revealing whether
// another account already uses the email.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const PASSWORD = "guest-upgrade-fixture-pw";

async function start(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({ store: f.store,
    magicLinkMailer: createMagicLinkMailer({ baseUrl: "https://room.example.invalid", send: async m => { sent.push(m); } }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, creds) => fetch(origin + path, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(creds ? { Cookie: creds.cookie, "X-CSRF-Token": creds.csrf } : {}) },
    body: JSON.stringify(data) });
  const guest = () => {
    const slot = f.store.createAccountSessionSlot();
    const joined = f.store.shareLinks.join(slot.token, f.links.valid, { displayName: "Gus", redemptionId: randomUUID(),
      expectedSessionRevision: slot.session.sessionRevision, expectedSessionBinding: slot.session.sessionBinding });
    const session = f.store.authenticateAccountSession(slot.token);
    assert.match(session.account.id, /^guest-/);
    return { cookie: `account_session=${slot.token}`, csrf: session.csrf, accountId: session.account.id, roomId: joined.roomId ?? joined.room?.id };
  };
  const roomsOf = accountId => f.store.db.prepare("SELECT room_id FROM member_accounts WHERE account_id=?").all(accountId).map(r => r.room_id);
  const codeFor = email => sent.filter(m => m.to === email && m.purpose === "email-verify").at(-1)?.code;
  return { f, sent, post, guest, roomsOf, codeFor, origin };
}

test("a guest adds an email, confirms the code with a password, and keeps the same account and rooms", async t => {
  const { f, post, guest, roomsOf, codeFor } = await start(t);
  const g = guest();
  const roomsBefore = roomsOf(g.accountId);
  assert.ok(roomsBefore.length > 0, "the guest is in the invited room");
  const email = "gus@example.invalid";
  const asked = await post("/api/auth/guest/upgrade", { email }, g);
  assert.equal(asked.status, 202);
  assert.equal((await asked.json()).status, "check_email");
  assert.equal(f.store.accountLogins.listMethods(g.accountId).length, 0, "nothing is linked before the code proves the inbox");
  const code = codeFor(email);
  assert.ok(code, "a verify code was mailed");
  const wrong = await post("/api/auth/guest/upgrade/confirm", { email, code: code === "000000" ? "111111" : "000000", password: PASSWORD }, g);
  assert.equal(wrong.status, 401);
  const done = await post("/api/auth/guest/upgrade/confirm", { email, code, password: PASSWORD }, g);
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal(f.store.accountLogins.emailVerification(g.accountId).status, "verified");
  assert.deepEqual(roomsOf(g.accountId), roomsBefore, "same account, same rooms");
  const slot = f.store.createAccountSessionSlot();
  const login = await post("/api/auth/password/login", { email, password: PASSWORD, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(login.status, 200, "the guest can sign in with the new password later");
  const token = /account_session=([^;]+)/.exec(login.headers.get("set-cookie") || "")?.[1];
  assert.equal(f.store.authenticateAccountSession(token).account.id, g.accountId, "signs in to the upgraded guest account");
  const again = await post("/api/auth/guest/upgrade", { email: "other@example.invalid" }, g);
  assert.equal(again.status, 409, "an account with an email can't run the guest upgrade again");
});

test("an email another account holds gets the same reply, a notice instead of a code, and can't be confirmed", async t => {
  const { f, post, guest, sent, codeFor } = await start(t);
  const email = "taken@example.invalid";
  const s = f.store.createAccountSessionSlot();
  assert.equal((await post("/api/auth/password/signup", { email, password: PASSWORD, sessionToken: s.token, sessionRevision: s.session.sessionRevision })).status, 202);
  sent.length = 0;
  const g = guest();
  const asked = await post("/api/auth/guest/upgrade", { email }, g);
  assert.equal(asked.status, 202);
  assert.deepEqual(await asked.json(), { status: "check_email", mailConfigured: true }, "same body as a free address");
  assert.equal(codeFor(email), undefined, "no code for a held address");
  assert.equal(sent.filter(m => m.to === email && m.purpose === "signup-notice").length, 1, "the holder is told instead");
  const confirm = await post("/api/auth/guest/upgrade/confirm", { email, code: "123456", password: PASSWORD }, g);
  assert.equal(confirm.status, 401);
  assert.equal((await confirm.json()).error.code, "invalid_email_code", "same answer as a wrong code");
  assert.equal(f.store.accountLogins.listMethods(g.accountId).length, 0);
});

test("the guest upgrade needs the guest's own session and CSRF token", async t => {
  const { post, guest } = await start(t);
  assert.equal((await post("/api/auth/guest/upgrade", { email: "x@example.invalid" })).status, 401);
  const g = guest();
  assert.equal((await post("/api/auth/guest/upgrade", { email: "x@example.invalid" }, { ...g, csrf: "nope" })).status, 403);
  assert.equal((await post("/api/auth/guest/upgrade", { email: "not-an-email" }, g)).status, 422);
  assert.equal((await post("/api/auth/guest/upgrade/confirm", { email: "x@example.invalid", code: "123456", password: "short" }, g)).status, 422);
});
