// R23-1: POST /api/auth/email/verify/resend documents an optional body
// (docs/openapi.yaml, requestBody required: false) and answered a body-less
// request before #2470. A body-less resend still mints and mails a fresh code;
// a body that is present keeps the strict JSON and returnTo checks.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const EMAIL = "resend-no-body@example.invalid";

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
  const resend = (contentType, body) => fetch(`${origin}/api/auth/email/verify/resend`, { method: "POST",
    headers: { ...(contentType ? { "Content-Type": contentType } : {}), Origin: origin, Cookie: `account_session=${token}`, "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body }) });
  const mails = () => sent.filter(m => m.to === EMAIL && m.purpose === "email-verify");
  return { resend, mails };
}

test("a body-less resend mints and mails a fresh code, with or without a JSON content type", async t => {
  const { resend, mails } = await signedUp(t);
  const before = mails().length;
  for (const contentType of [null, "application/json"]) {
    const res = await resend(contentType);
    const reply = await res.json();
    assert.equal(res.status, 200, `content type ${contentType}: ${JSON.stringify(reply)}`);
    assert.equal(reply.status, "resent");
    assert.equal(reply.email, EMAIL);
  }
  assert.equal(mails().length, before + 2);
  assert.equal(mails().at(-1).link.includes("#join/"), false);
});

test("a resend body that is present keeps its JSON and returnTo checks", async t => {
  const { resend } = await signedUp(t);
  const code = async res => [res.status, (await res.json()).error?.code];
  assert.deepEqual(await code(await resend("text/plain", "returnTo=/")), [415, "json_required"]);
  assert.deepEqual(await code(await resend("application/json", "{")), [400, "invalid_json"]);
  assert.deepEqual(await code(await resend("application/json", JSON.stringify({ returnTo: "//evil.example/#join/x" }))), [422, "invalid_return_target"]);
});
