// Verification mail: failed sends are logged (redacted) and reported honestly,
// and the verify email says "verify", not "sign in".
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer, describeMailFailure, attemptMailDelivery } from "../server/magic-links.mjs";
import { resendMagicLinkSend } from "../server/resend-mailer.mjs";

const email = "verify-delivery@example.invalid", password = "fixture-password-verify-long-enough";
const post = (origin, path, data, headers = {}) => fetch(origin + path, {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(data)
});

test("describeMailFailure keeps the provider reason and drops addresses, links and tokens", () => {
  const text = describeMailFailure(new Error(
    "magic link email failed to send (HTTP 403): The trydemigod.com domain is not verified. Sent to a@b.example https://x.example/?magic=abc and abcdefghijklmnopqrstuvwxyz0123"));
  assert.match(text, /HTTP 403/); assert.match(text, /domain is not verified/);
  assert.doesNotMatch(text, /a@b\.example|https?:|abcdefghijklmnopqrstuvwxyz0123/);
  assert.ok(describeMailFailure("x".repeat(1000)).length <= 240);
});

test("attemptMailDelivery reports false and warns once on failure, true otherwise", async () => {
  const warnings = [];
  assert.equal(await attemptMailDelivery(async () => { throw new Error("boom to u@v.example"); }, "kind", m => warnings.push(m)), false);
  assert.deepEqual(warnings, ["mail delivery failed (kind): boom to [email]"]);
  assert.equal(await attemptMailDelivery(async () => {}, "kind", m => warnings.push(m)), true);
  assert.equal(warnings.length, 1);
});

test("the verification email says verify, not sign in", async () => {
  const bodies = [];
  const send = resendMagicLinkSend({ apiKey: "re_test", from: "Room <noreply@example.com>",
    fetchFn: async (_url, options) => { bodies.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } });
  await send({ to: "u@example.com", code: "123456", baseUrl: "https://room.example", purpose: "email-verify" });
  await send({ to: "u@example.com", code: "123456", purpose: "email-verify" });
  for (const body of bodies) {
    assert.equal(body.subject, "Verify your Project Room email");
    assert.doesNotMatch(body.subject + body.text + body.html, /sign-in|Sign in/);
    assert.match(body.text, /123456/);
  }
});

test("resend answers not_delivered (not resent) when the provider refuses, and logs why", async t => {
  const f = createAcceptanceFixture(), warnings = [];
  let fail = false;
  const mailer = createMagicLinkMailer({ send: async () => { if (fail) throw new Error("email failed to send (HTTP 403): domain is not verified"); } });
  const original = console.warn; console.warn = m => warnings.push(String(m)); t.after(() => { console.warn = original; });
  const server = createRoomServer({ store: f.store, magicLinkMailer: mailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const slotRes = await fetch(`${origin}/api/account-session`);
  const view = await slotRes.json();
  const slot = /account_session=([^;]+)/.exec(slotRes.headers.get("set-cookie"))[1];
  const signed = await post(origin, "/api/auth/password/signup", { email, password, sessionToken: slot, sessionRevision: view.sessionRevision });
  assert.equal(signed.status, 202);
  const token = /account_session=([^;]+)/.exec(signed.headers.get("set-cookie"))[1];
  const session = f.store.authenticateAccountSession(token);
  const headers = { Cookie: `account_session=${token}`, "X-CSRF-Token": session.csrf, "X-Session-Binding": session.sessionBinding };
  const ok = await post(origin, "/api/auth/email/verify/resend", {}, headers);
  assert.equal((await ok.json()).status, "resent");
  fail = true;
  const refused = await post(origin, "/api/auth/email/verify/resend", {}, headers);
  assert.equal(refused.status, 200);
  assert.equal((await refused.json()).status, "not_delivered");
  const logged = warnings.filter(m => m.startsWith("mail delivery failed (email-verify resend)"));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /HTTP 403\): domain is not verified/);
  assert.doesNotMatch(logged[0], new RegExp(email));
});
