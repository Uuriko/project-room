// Signup verification continuation (Jill-Dot probe, A20): submitting signup
// while an invitation is pending must put that continuation in the ACTUALLY
// EMITTED verification-mail URL. Existing signup-mail-links tests supply a
// prebuilt room/hash to the classifier, while the browser fresh-tab
// invitation test uses magic-link login, not signup. The DOM shell below only
// dispatches the real submit handler; the real route, mailer and Resend
// formatting produce the URL. Fixture addresses and a fake Resend endpoint
// only; nothing leaves the process.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { resendMagicLinkSend } from "../server/resend-mailer.mjs";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

test("signup emits verification mail that carries the pending invitation into a fresh tab", async t => {
  const fixture = createAcceptanceFixture();
  const delivered = [];
  const send = resendMagicLinkSend({
    apiKey: "re_fixture", from: "Room <noreply@example.invalid>",
    fetchFn: async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(options.method, "POST");
      delivered.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    }
  });
  const server = createRoomServer({ store: fixture.store,
    magicLinkMailer: createMagicLinkMailer({ send, baseUrl: "https://room.example.invalid" }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const slot = fixture.store.createAccountSessionSlot();
  const intended = "/?room=studio#invite/" + "A".repeat(43);
  const previousWindow = globalThis.window;
  globalThis.window = { location: {
    search: "?room=studio", pathname: "/", hash: "#invite/" + "A".repeat(43)
  } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  let cookie = null, requests = 0;
  // A strict transport adapter, not a simulated auth outcome: requests and
  // session restoration use the real isolated server and fixture store.
  const accountClient = {
    generation: 0,
    currentSession: () => slot.session,
    async request(path, { method, data }) {
      assert.equal(path, "/api/auth/password/signup");
      assert.equal(method, "POST");
      requests++;
      const response = await fetch(origin + path, { method,
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, sessionToken: slot.token }) });
      const reply = await response.json();
      assert.equal(response.status, 202, JSON.stringify(reply));
      cookie = /account_session=([^;]+)/.exec(response.headers.get("set-cookie"))?.[1];
      assert.ok(cookie, "the real route authenticated the synthetic new account");
      return reply;
    },
    async restore() {
      assert.ok(cookie);
      const response = await fetch(origin + "/api/account-session", {
        headers: { Cookie: `account_session=${cookie}` }
      });
      assert.equal(response.status, 200);
      return response.json();
    }
  };
  const listeners = new Map();
  const status = { textContent: "", classList: { toggle() {} } };
  const container = {
    innerHTML: "", setAttribute() {}, contains: () => true,
    querySelectorAll: () => [],
    querySelector: selector => selector === "[data-signin-status]" ? status : null,
    addEventListener: (name, handler) => listeners.set(name, handler)
  };
  let signedIn = false;
  const ui = createAuthSigninUI({ accountClient, ensureAccountSession: async () => {},
    onMagicLinkRequest: () => intended,
    onSignedIn: async session => { assert.equal(session.authenticated, true); signedIn = true; }
  });
  await ui.mount(container);
  ui.showPassword("signup");
  const form = { dataset: { signinForm: "password" }, querySelectorAll: () => [
    { name: "email", value: "continuation@example.invalid" },
    { name: "password", value: "synthetic-password-long-enough" }
  ] };
  await listeners.get("submit")({ preventDefault() {}, target: { closest: () => form } });
  assert.equal(requests, 1);
  assert.equal(signedIn, true, status.textContent);
  assert.equal(delivered.length, 1);
  const mail = delivered[0];
  assert.match(mail.subject, /verify/i);
  const href = mail.text.match(/https:\/\/room\.example\.invalid\/[^\s"<]*/)?.[0];
  assert.ok(href, "inspect the actual emitted email, not a hand-constructed link");
  const link = new URL(href);
  assert.equal(link.searchParams.get("verify"), "email");
  assert.equal(link.searchParams.get("email"), "continuation@example.invalid");
  assert.equal(link.origin, "https://room.example.invalid");
  t.diagnostic(`Actual emitted synthetic verification URL: ${href}`);
  assert.equal(`${link.pathname}?room=${link.searchParams.get("room")}${link.hash}`, intended,
    "the emitted verification link must retain the originating room and invitation");
});
