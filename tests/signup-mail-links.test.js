// Password signup mail (ID-SEC) through the real signup route, the production
// Resend sender and the browser's link classifier. A new account gets an
// email-verify message; an address that already has an account gets the
// sign-in notice. Both must reach the person and both links must open the
// app without the "incomplete or invalid" sign-in error. Fixture addresses
// and a fake Resend endpoint only; nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { resendMagicLinkSend } from "../server/resend-mailer.mjs";
import { classifyAuthLink, createAuthSigninUI } from "../src/auth-signin-ui.js";

const password = "fixture-password-long-enough";

async function start(t) {
  const f = createAcceptanceFixture();
  const delivered = [];
  const send = resendMagicLinkSend({ apiKey: "re_fixture", from: "Room <noreply@example.invalid>",
    fetchFn: async (_url, options) => { delivered.push(JSON.parse(options.body)); return { ok: true, status: 200 }; } });
  const server = createRoomServer({ store: f.store,
    magicLinkMailer: createMagicLinkMailer({ send, baseUrl: "https://room.example.invalid" }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const signup = email => {
    const slot = f.store.createAccountSessionSlot();
    return fetch(`${origin}/api/auth/password/signup`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision }) });
  };
  return { delivered, signup };
}

const linkIn = message => new URL(/https:\/\/room\.example\.invalid\/[^\s"<]*/.exec(message.text)?.[0] ?? "about:blank");

test("a new password account gets a verification email that says so and opens cleanly", async t => {
  const { delivered, signup } = await start(t);
  const reply = await signup("fresh@example.invalid");
  assert.equal(reply.status, 202);
  assert.deepEqual(await reply.json(), { status: "check_email", mailConfigured: true });
  assert.equal(delivered.length, 1, "the verification email is delivered");
  const [mail] = delivered;
  assert.equal(mail.to, "fresh@example.invalid");
  assert.match(mail.subject, /verify/i, "the subject names verification, not a sign-in link");
  assert.doesNotMatch(mail.subject + mail.text + mail.html, /sign-in link|Sign in to Project Room/i);
  const code = /\b(\d{6})\b/.exec(mail.text)?.[1];
  assert.ok(code, "the 6-digit code is in the plaintext body");
  assert.ok(mail.html.includes(code), "and in the html body");
  const link = linkIn(mail);
  assert.equal(link.searchParams.get("verify"), "email");
  assert.notEqual(classifyAuthLink(link.searchParams).kind, "invalid", "the emailed link must not open as an invalid sign-in link");
});

test("signing up again with a registered address delivers the sign-in notice", async t => {
  const { delivered, signup } = await start(t);
  assert.equal((await signup("taken@example.invalid")).status, 202);
  delivered.length = 0;
  const again = await signup("taken@example.invalid");
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: "check_email", mailConfigured: true }, "the reply stays uniform");
  assert.equal(delivered.length, 1, "the UI promises a sign-in link, so the notice must actually be sent");
  const [mail] = delivered;
  assert.equal(mail.to, "taken@example.invalid");
  assert.match(mail.text, /already/i, "the notice says the address already has an account");
  assert.doesNotMatch(mail.text + mail.html, /enter this code|undefined/i, "the notice carries no code");
  const link = linkIn(mail);
  assert.equal(link.searchParams.get("signin"), "1");
  assert.equal(link.searchParams.get("email"), "taken@example.invalid");
  assert.notEqual(classifyAuthLink(link.searchParams).kind, "invalid", "the emailed link must not open as an invalid sign-in link");
});

function fakeContainer() {
  const status = { textContent: "", classList: { toggle() {} } };
  return { status, innerHTML: "", addEventListener() {}, setAttribute() {}, querySelectorAll() { return []; },
    contains() { return true; }, querySelector(selector) { return selector === "[data-signin-status]" ? status : null; } };
}

for (const [label, search, wantEmail] of [
  ["sign-in notice", "?signin=1&email=taken%40example.invalid&room=studio", true],
  ["email verification", "?verify=email&email=fresh%40example.invalid&room=studio", false],
]) {
  test(`opening the ${label} link scrubs it and shows no link error`, async () => {
    const previousWindow = globalThis.window;
    const cleaned = [], failures = [];
    globalThis.window = { location: { search, pathname: "/", hash: "#invite/" + "A".repeat(43) },
      history: { replaceState: (_state, _title, url) => cleaned.push(url) } };
    try {
      const calls = [];
      const accountClient = { generation: 0, session: { authenticated: false }, currentSession() { return this.session; },
        owns: () => true, restore: async () => ({ authenticated: false }), request: async path => { calls.push(path); return {}; } };
      const ui = createAuthSigninUI({ accountClient, ensureAccountSession: async () => {}, onMagicLinkFailure: message => failures.push(message) });
      const container = fakeContainer();
      await ui.mount(container);
      assert.deepEqual(failures, [], "no invalid-link failure reaches the host");
      assert.equal(container.status.textContent, "");
      assert.equal(calls.length, 0, "opening the link redeems nothing");
      assert.deepEqual(cleaned, ["/?room=studio#invite/" + "A".repeat(43)], "the address leaves the URL; room and invitation stay");
      if (wantEmail) assert.match(container.innerHTML, /taken@example\.invalid/, "sign-in opens with the address filled in");
    } finally { globalThis.window = previousWindow; }
  });
}
