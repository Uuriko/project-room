// Same deadlock class as agent-invites-mail-unconfigured: share-link creation
// answered 403 email_unverified for an unverified account on a deployment with
// no mailer, where verification can never complete. The gate stays where mail
// is configured.
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

async function start(t, mailer) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, ...(mailer ? { magicLinkMailer: mailer } : {}) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return { f, origin: `http://127.0.0.1:${server.address().port}` };
}

const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...headers },
  body: JSON.stringify(data),
});

async function createLink(t, mailer) {
  const { f, origin } = await start(t, mailer);
  const n = String(Date.now() % 1000000);
  const slot = f.store.createAccountSessionSlot();
  const signup = await post(origin, "/api/auth/password/signup", {
    email: `share-${n}@example.com`, password: `share-password-${n}-long-enough`,
    sessionToken: slot.token, sessionRevision: slot.session.sessionRevision,
  });
  assert.equal(signup.status, 202);
  const token = /account_session=([^;]+)/.exec(signup.headers.get("set-cookie") || "")?.[1];
  const session = f.store.authenticateAccountSession(token);
  assert.equal(f.store.accountLogins.emailStatus(session.account.id), "unverified");
  const headers = { Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf, "X-Session-Binding": session.sessionBinding, "X-Project-Room-Auth": "account" };
  const roomId = `share${n}`;
  assert.equal((await post(origin, "/api/account-rooms", { roomId, title: "Share", purpose: "Links", kind: "personal", displayName: "Owner" }, headers)).status, 201);
  const member = f.store.room(roomId).state.members;
  const owner = Object.values(member).find(m => m.kind === "human");
  return post(origin, `/api/rooms/${roomId}/share-links`, {
    requestId: `req-${n}`, linkToken: randomBytes(32).toString("base64url"),
    expiresAt: Date.now() + 3600000, maxJoins: 2, expectedMemberRevision: owner.revision,
  }, headers);
}

test("unverified owner can create a share link when mail is unconfigured", async t => {
  const res = await createLink(t);
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body).slice(0, 200));
  assert.equal(body.link.status, "active");
});

test("unverified owner is still refused when a mailer is configured", async t => {
  const res = await createLink(t, createMagicLinkMailer({ send: async () => {} }));
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code ?? body.error?.code ?? body.error, "email_unverified", JSON.stringify(body).slice(0, 160));
});
