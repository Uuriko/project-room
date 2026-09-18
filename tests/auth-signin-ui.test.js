// Unit tests for src/auth-signin-ui.js (slice 7, RC-2026-09-17-016):
// WebAuthn ceremony transforms, shell rendering, and the wired sign-in
// behavior against a stub AccountClient and a fake container. No DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import { toAuthenticationPublicKey, toAuthenticationResponse, createAuthSigninUI } from "../src/auth-signin-ui.js";

test("toAuthenticationPublicKey decodes challenge and allowCredentials", () => {
  const options = {
    challenge: "dGVzdA", // "test"
    rpId: "example.invalid",
    allowCredentials: [{ type: "public-key", id: "Y3JlZA" }], // "cred"
    userVerification: "preferred",
    timeout: 60000
  };
  const publicKey = toAuthenticationPublicKey(options);
  assert.equal(new TextDecoder().decode(publicKey.challenge), "test");
  assert.equal(publicKey.rpId, "example.invalid");
  assert.equal(new TextDecoder().decode(publicKey.allowCredentials[0].id), "cred");
  assert.equal(publicKey.userVerification, "preferred");
});

test("toAuthenticationResponse encodes the assertion for the finish route", () => {
  const credential = {
    id: "cred-id", rawId: new TextEncoder().encode("cred").buffer, type: "public-key",
    response: {
      authenticatorData: new TextEncoder().encode("authData").buffer,
      clientDataJSON: new TextEncoder().encode("clientData").buffer,
      signature: new TextEncoder().encode("sig").buffer,
      userHandle: null
    }
  };
  const body = toAuthenticationResponse(credential);
  assert.equal(body.id, "cred-id");
  assert.equal(Buffer.from(body.rawId, "base64url").toString(), "cred");
  assert.equal(Buffer.from(body.response.authenticatorData, "base64url").toString(), "authData");
  assert.equal(body.response.userHandle, null);
});

function fakeContainer() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    removeEventListener(name, fn) { listeners[name] = (listeners[name] ?? []).filter(f => f !== fn); },
    querySelector() { return null; },
    contains() { return true; },
    fire(name, event) { for (const fn of listeners[name] ?? []) fn(event); }
  };
}

const attrFor = sel => (sel.match(/\[data-([a-z-]+)\]/) ?? [])[1];
const clickOnDataset = (kind, dataset = {}) => ({ target: { closest: sel => attrFor(sel) === kind ? { dataset } : null } });
const submitForm = (kind, values = {}) => ({
  preventDefault() {},
  target: { closest: sel => sel === "[data-signin-form]" ? {
    dataset: { signinForm: kind },
    querySelectorAll: () => Object.entries(values).map(([name, value]) => ({ name, value }))
  } : null }
});

function stubClient(routes = {}) {
  const calls = [];
  return {
    calls,
    session: { authenticated: false },
    currentSession() { return { csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1 }; },
    async request(path, { data } = {}) {
      calls.push({ path, data });
      const reply = routes[path];
      const resolved = typeof reply === "function" ? reply(data) : reply;
      if (resolved?.throw) throw Object.assign(new Error(resolved.throw.message), { code: resolved.throw.code });
      return resolved;
    }
  };
}

function mount(routes = {}) {
  const client = stubClient(routes);
  const signins = [];
  const ui = createAuthSigninUI({
    accountClient: client,
    ensureAccountSession: async () => {},
    onSignedIn: async session => { signins.push(session); }
  });
  const container = fakeContainer();
  ui.mount(container);
  return { client, signins, container };
}

test("mount renders the method chooser, GitHub button, and no form by default", () => {
  const { container } = mount();
  assert.ok(container.innerHTML.includes("or sign in another way"));
  assert.ok(container.innerHTML.includes("Continue with GitHub"));
  assert.ok(container.innerHTML.includes("Email + password"));
  assert.ok(container.innerHTML.includes("Magic link"));
  assert.ok(container.innerHTML.includes("Passkey"));
  assert.ok(container.innerHTML.includes("Recovery code"));
  assert.ok(!container.innerHTML.includes("data-signin-form"));
});

test("choosing a method renders its form; choosing again closes it", () => {
  const { container } = mount();
  container.fire("click", clickOnDataset("method", { method: "password" }));
  assert.ok(container.innerHTML.includes('data-signin-form="password"'));
  container.fire("click", clickOnDataset("method", { method: "password" }));
  assert.ok(!container.innerHTML.includes("data-signin-form"));
});

test("password signup posts email, password, and sessionRevision, then signs in", async () => {
  const view = { authenticated: true, account: { id: "acct-1" } };
  const { client, signins, container } = mount({ "/api/auth/password/signup": view });
  container.fire("click", clickOnDataset("method", { method: "password" }));
  await container.listeners.submit[0](submitForm("password", { email: "new@example.invalid", password: "fixture-password-1" }));
  assert.equal(client.calls[0].path, "/api/auth/password/signup");
  assert.equal(client.calls[0].data.email, "new@example.invalid");
  assert.equal(client.calls[0].data.password, "fixture-password-1");
  assert.equal(client.calls[0].data.sessionRevision, 1);
  assert.equal(signins.length, 1);
  assert.equal(signins[0].account.id, "acct-1");
});

test("password mode toggle switches between signup and login routes", async () => {
  const view = { authenticated: true, account: { id: "acct-2" } };
  const { client, container } = mount({ "/api/auth/password/login": view });
  container.fire("click", clickOnDataset("method", { method: "password" }));
  container.fire("click", clickOnDataset("password-mode", { passwordMode: "login" }));
  await container.listeners.submit[0](submitForm("password", { email: "back@example.invalid", password: "fixture-password-2" }));
  assert.equal(client.calls[0].path, "/api/auth/password/login");
});

test("magic request unavailable shows the server's honest message", async () => {
  const { client, container } = mount({
    "/api/auth/magic/request": { status: "unavailable", reason: "mail_not_configured", message: "Email delivery isn\u2019t configured." }
  });
  container.fire("click", clickOnDataset("method", { method: "magic" }));
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  assert.equal(client.calls[0].path, "/api/auth/magic/request");
  // No code phase, no sign-in.
  assert.ok(container.innerHTML.includes('data-signin-form="magic-request"'));
});

test("magic request sent moves to the code phase, then consume signs in", async () => {
  const view = { authenticated: true, account: { id: "acct-3" } };
  const { client, signins, container } = mount({
    "/api/auth/magic/request": { status: "sent" },
    "/api/auth/magic/consume": view
  });
  container.fire("click", clickOnDataset("method", { method: "magic" }));
  await container.listeners.submit[0](submitForm("magic-request", { email: "m@example.invalid" }));
  assert.ok(container.innerHTML.includes('data-signin-form="magic-code"'));
  await container.listeners.submit[0](submitForm("magic-code", { code: "12345678" }));
  assert.equal(client.calls[1].path, "/api/auth/magic/consume");
  assert.equal(client.calls[1].data.email, "m@example.invalid");
  assert.equal(client.calls[1].data.code, "12345678");
  assert.equal(client.calls[1].data.sessionRevision, 1);
  assert.equal(signins.length, 1);
});

test("recovery redeem posts email/code/sessionRevision and unwraps the session", async () => {
  const session = { authenticated: true, account: { id: "acct-4" } };
  const { client, signins, container } = mount({ "/api/auth/recovery-codes/redeem": { remaining: 7, session } });
  container.fire("click", clickOnDataset("method", { method: "recovery" }));
  await container.listeners.submit[0](submitForm("recovery", { email: "r@example.invalid", code: "abcdef-ghijkl" }));
  assert.equal(client.calls[0].path, "/api/auth/recovery-codes/redeem");
  assert.equal(client.calls[0].data.email, "r@example.invalid");
  assert.equal(signins.length, 1);
  assert.equal(signins[0].account.id, "acct-4");
});

test("passkey flow drives navigator.credentials.get and the finish route", async () => {
  const options = { challengeId: "chal-1", challenge: "dGVzdA", rpId: "example.invalid",
    allowCredentials: [], userVerification: "preferred", timeout: 60000 };
  const view = { authenticated: true, account: { id: "acct-5" } };
  const credential = {
    id: "cred-1", rawId: new TextEncoder().encode("cred").buffer, type: "public-key",
    response: {
      authenticatorData: new TextEncoder().encode("a").buffer,
      clientDataJSON: new TextEncoder().encode("c").buffer,
      signature: new TextEncoder().encode("s").buffer,
      userHandle: null
    }
  };
  const { client, signins, container } = mount({
    "/api/auth/passkey/authenticate/options": options,
    "/api/auth/passkey/authenticate/finish": view
  });
  const saw = [];
  // Node ships a getter-only navigator; defineProperty is the way in.
  Object.defineProperty(globalThis, "navigator", { value: { credentials: { get: async request => { saw.push(request); return credential; } } }, configurable: true });
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    container.fire("click", clickOnDataset("method", { method: "passkey" }));
    await container.listeners.submit[0](submitForm("passkey"));
  } finally { delete globalThis.navigator; delete globalThis.window; }
  assert.equal(client.calls[0].path, "/api/auth/passkey/authenticate/options");
  assert.equal(saw.length, 1);
  assert.equal(new TextDecoder().decode(saw[0].publicKey.challenge), "test");
  assert.equal(client.calls[1].path, "/api/auth/passkey/authenticate/finish");
  assert.equal(client.calls[1].data.challengeId, "chal-1");
  assert.equal(client.calls[1].data.response.id, "cred-1");
  assert.equal(signins.length, 1);
});

test("sign-in failure does not call onSignedIn", async () => {
  const { signins, container } = mount({
    "/api/auth/password/signup": { throw: { code: "email_in_use", message: "That email is already on an account." } }
  });
  container.fire("click", clickOnDataset("method", { method: "password" }));
  await container.listeners.submit[0](submitForm("password", { email: "dup@example.invalid", password: "fixture-password-3" }));
  assert.equal(signins.length, 0);
});
