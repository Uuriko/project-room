// Password signup from an invitation keeps the invitation in the signup mail.
// An invitee on a #join/ or #invite/ link who picks "Create account" gets an
// email (the verify mail, or the already-registered notice when the address
// has an account). The link in that mail must lead back to the invitation the
// same way a magic sign-in link does; a bare root drops the invite. Real
// signup route, the real mailer link builder, and the real sign-in module.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

const password = "fixture-password-long-enough";
const join = "#join/" + "J".repeat(43);
const invite = "#invite/" + "I".repeat(43);

async function start(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({ store: f.store,
    magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); }, baseUrl: "https://room.example.invalid" }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const signup = (email, extra = {}) => {
    const slot = f.store.createAccountSessionSlot();
    return fetch(`${origin}/api/auth/password/signup`, { method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({ email, password, sessionToken: slot.token, sessionRevision: slot.session.sessionRevision, ...extra }) });
  };
  return { sent, signup };
}

test("a new account's verify mail links back to the join link it signed up from", async t => {
  const { sent, signup } = await start(t);
  const reply = await signup("fresh@example.invalid", { returnTo: `/${join}` });
  assert.equal(reply.status, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].purpose, "email-verify");
  const link = new URL(sent[0].link);
  assert.equal(link.hash, join, "the verify link keeps the #join/ invitation");
  assert.equal(link.searchParams.get("verify"), "email");
});

test("the already-registered notice links back to the invitation", async t => {
  const { sent, signup } = await start(t);
  assert.equal((await signup("taken@example.invalid")).status, 202);
  sent.length = 0;
  const again = await signup("taken@example.invalid", { returnTo: `/?room=studio${invite}` });
  assert.equal(again.status, 202);
  assert.deepEqual(await again.json(), { status: "check_email", mailConfigured: true }, "the reply stays uniform");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].purpose, "signup-notice");
  const link = new URL(sent[0].link);
  assert.equal(link.hash, invite, "an existing member keeps the invitation they were signing up from");
  assert.equal(link.searchParams.get("room"), "studio");
  assert.equal(link.searchParams.get("signin"), "1");
});

test("signup refuses a return target that leaves the app, before any mail", async t => {
  const { sent, signup } = await start(t);
  for (const returnTo of ["https://evil.example/", "//evil.example/", "/settings", "/?next=x"]) {
    const reply = await signup("fresh@example.invalid", { returnTo });
    assert.equal(reply.status, 422, returnTo);
    assert.equal((await reply.json()).error?.code, "invalid_return_target", returnTo);
  }
  assert.equal(sent.length, 0);
  assert.equal((await signup("plain@example.invalid")).status, 202, "returnTo stays optional");
});

test("the signup form sends the same return target as the magic-link form", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: "", pathname: "/", hash: join }, history: { replaceState() {} } };
  try {
    const calls = [];
    const session = { authenticated: false, sessionRevision: 3 };
    const accountClient = { generation: 0, session, currentSession() { return session; }, owns: () => true,
      restore: async () => ({ authenticated: false }),
      request: async (path, options) => { calls.push({ path, data: options?.data }); return { status: "check_email", mailConfigured: true }; } };
    const ui = createAuthSigninUI({ accountClient, ensureAccountSession: async () => {}, onMagicLinkRequest: () => `/${join}` });
    let submit = null;
    const status = { textContent: "", classList: { toggle() {} } };
    const container = { innerHTML: "", setAttribute() {}, querySelectorAll() { return []; }, contains() { return true; },
      querySelector(selector) { return selector === "[data-signin-status]" ? status : null; },
      addEventListener(type, fn) { if (type === "submit") submit = fn; } };
    await ui.mount(container);
    ui.showPassword("signup");
    const form = { dataset: { signinForm: "password" },
      querySelectorAll: () => [{ name: "email", value: "fresh@example.invalid" }, { name: "password", value: password }] };
    await submit({ target: { closest: () => form }, preventDefault() {} });
    const signupCall = calls.find(call => call.path === "/api/auth/password/signup");
    assert.ok(signupCall, "the signup request was sent");
    assert.equal(signupCall.data.returnTo, `/${join}`, "the signup mail can lead back to the open invitation");
  } finally { globalThis.window = previousWindow; }
});
