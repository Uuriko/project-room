// #2318 follow-up (auth audit A20): a resent verification code keeps the
// pending invitation in its link, with the same strict returnTo validation as
// signup and magic sign-in. Without returnTo the resend behaves as before.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const EMAIL = "resend-invite@example.invalid";
const JOIN = `#join/${"a".repeat(43)}`;

async function signedUp(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({ store: f.store,
    magicLinkMailer: createMagicLinkMailer({ baseUrl: "https://room.example.invalid", send: async m => { sent.push(m); } }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(`${origin}/api/auth/password/signup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ email: EMAIL, password: "fixture-password-resend", sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }) });
  assert.equal(res.status, 202);
  const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")[1];
  const csrf = f.store.authenticateAccountSession(token).csrf;
  const resend = data => fetch(`${origin}/api/auth/email/verify/resend`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: `account_session=${token}`, "X-CSRF-Token": csrf }, body: JSON.stringify(data) });
  const lastLink = () => sent.filter(m => m.to === EMAIL && m.purpose === "email-verify").at(-1)?.link;
  return { resend, lastLink };
}

test("a resent code's link keeps the invitation it was asked from", async t => {
  const { resend, lastLink } = await signedUp(t);
  const res = await resend({ returnTo: `/${JOIN}` });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "resent");
  assert.ok(lastLink().endsWith(JOIN), lastLink());
});

test("without returnTo the resend is unchanged, and a foreign returnTo is refused", async t => {
  const { resend, lastLink } = await signedUp(t);
  assert.equal((await resend({})).status, 200);
  assert.ok(!lastLink().includes("#join/"));
  const bad = await resend({ returnTo: "https://evil.example/#join/x" });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_return_target");
});
