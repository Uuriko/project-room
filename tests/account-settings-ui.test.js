// Unit tests for src/account-settings-ui.js (slice 7, RC-2026-09-17-016):
// pure helpers (labels, dates, escaping, WebAuthn ceremony transforms,
// HTML rendering) plus the wired UI behavior against a stub AccountClient
// and a minimal fake container. No DOM, no network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  methodLabel, methodDetail, formatMethodDate,
  base64urlToBytes, bytesToBase64url, toRegistrationPublicKey,
  toRegistrationResponse, settingsHtml, createAccountSettingsUI
} from "../src/account-settings-ui.js";

test("methodLabel names every method type honestly", () => {
  assert.equal(methodLabel({ type: "password" }), "Password");
  assert.equal(methodLabel({ type: "magic" }), "Email magic link");
  assert.equal(methodLabel({ type: "passkey" }), "Passkey");
  assert.equal(methodLabel({ type: "recovery-code-set" }), "Recovery codes");
  assert.equal(methodLabel({ type: "oauth", provider: "github" }), "GitHub");
  assert.equal(methodLabel({ type: "oauth", provider: "google" }), "Continue with Google");
  assert.equal(methodLabel({ type: "weird", label: "Custom" }), "Custom");
});

test("methodDetail surfaces only safe public detail", () => {
  assert.equal(methodDetail({ type: "password", email: "a@b.c" }), "a@b.c");
  assert.equal(methodDetail({ type: "oauth", provider: "github" }), "Connected github account");
  assert.equal(methodDetail({ type: "recovery-code-set" }), "Single-use backup codes");
  assert.equal(methodDetail({ type: "passkey" }), "");
});

test("escapeHtml neutralizes markup in rendered fields", () => {
  const html = settingsHtml({ methods: [{ id: "m1", type: "password", label: "<img>", email: "<script>@x</script>",
    createdAt: 1, lastUsedAt: null, disabled: false }], providers: null });
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("&lt;script&gt;@x&lt;/script&gt;"));
});

test("formatMethodDate handles missing and real timestamps", () => {
  assert.equal(formatMethodDate(null), "never");
  assert.equal(formatMethodDate(0), "never");
  assert.match(formatMethodDate(Date.UTC(2026, 0, 5)), /2026/);
});

test("base64url helpers round-trip", () => {
  const bytes = base64urlToBytes("aGVsbG8td29ybGQ");
  assert.equal(Buffer.from(bytes).toString(), "hello-world");
  assert.equal(bytesToBase64url(new TextEncoder().encode("hello-world")), "aGVsbG8td29ybGQ");
  assert.throws(() => base64urlToBytes("!!!"), /Invalid base64url/);
});

test("toRegistrationPublicKey decodes challenge, user id, and exclusions", () => {
  const options = {
    challenge: bytesToBase64url(new TextEncoder().encode("challenge-bytes")),
    rp: { id: "example.test", name: "example.test" },
    user: { id: bytesToBase64url(new TextEncoder().encode("user-1")), name: "user-1", displayName: "user-1" },
    excludeCredentials: [{ type: "public-key", id: bytesToBase64url(new TextEncoder().encode("cred-9")) }]
  };
  const publicKey = toRegistrationPublicKey(options);
  assert.equal(Buffer.from(publicKey.challenge).toString(), "challenge-bytes");
  assert.equal(Buffer.from(publicKey.user.id).toString(), "user-1");
  assert.equal(Buffer.from(publicKey.excludeCredentials[0].id).toString(), "cred-9");
  assert.equal(publicKey.rp.id, "example.test");
});

test("toRegistrationResponse encodes the credential for the finish route", () => {
  const enc = value => new TextEncoder().encode(value).buffer;
  const payload = toRegistrationResponse({ id: "cred-id", rawId: enc("raw"),
    type: "public-key", response: { clientDataJSON: enc("cdj"), attestationObject: enc("ao") } });
  assert.deepEqual(payload, { id: "cred-id", rawId: bytesToBase64url(enc("raw")), type: "public-key",
    response: { clientDataJSON: bytesToBase64url(enc("cdj")), attestationObject: bytesToBase64url(enc("ao")) } });
});

test("settingsHtml shows linked methods with actions and honest provider states", () => {
  const html = settingsHtml({
    methods: [
      { id: "m1", type: "password", label: "Password", email: "a@b.c", createdAt: 1, lastUsedAt: 2, disabled: false },
      { id: "m2", type: "oauth", provider: "github", label: "x", email: null, createdAt: 1, lastUsedAt: null, disabled: true }
    ],
    providers: { github: { configured: true }, google: { configured: false }, passkey: { configured: false }, mail: { configured: false } }
  });
  assert.ok(html.includes("Password"));
  assert.ok(html.includes("GitHub"));
  assert.ok(html.includes("disabled"));
  assert.ok(html.includes('data-action="disable" data-id="m1"'));
  assert.ok(html.includes('data-action="enable" data-id="m2"'));
  assert.ok(html.includes('data-action="remove"'));
  assert.ok(html.includes("/api/auth/github/link/start"), "configured GitHub offers a connect link");
  assert.ok(html.includes("Google sign-in isn\u2019t configured on this Room."), "unconfigured Google is honest");
  assert.ok(html.includes("Email delivery isn\u2019t configured on this Room"), "unconfigured mail is honest");
  assert.ok(html.includes("data-form=\"password-change\""), "an existing password offers change, not set");
});

test("settingsHtml offers password set when none exists and recovery generation", () => {
  const html = settingsHtml({ methods: [], providers: null });
  assert.ok(html.includes("No sign-in methods are linked yet."));
  assert.ok(html.includes("data-form=\"password-set\""));
  assert.ok(html.includes("Generate recovery codes"));
  assert.ok(html.includes("GitHub sign-in isn\u2019t configured on this Room."));
});

// --- Wired behavior with stubs ---
function stubClient(responses) {
  const calls = [];
  return {
    calls,
    session: { authenticated: true, account: { id: "acct" }, sessionRevision: 1, csrf: "c", sessionBinding: "b" },
    currentSession() { return this.session; },
    async request(path, { method = "GET", data } = {}) {
      calls.push({ path, method, data });
      const response = responses[path];
      if (response instanceof Error) throw response;
      return typeof response === "function" ? response({ path, method, data }) : response;
    }
  };
}

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

const clickOn = (action, id) => ({ target: { closest: () => ({ dataset: { action, id } }) } });

test("mount renders methods from /api/auth/methods", async () => {
  const methods = [{ id: "m1", type: "password", label: "Password", email: "a@b.c", createdAt: 1, lastUsedAt: null, disabled: false }];
  const client = stubClient({ "/api/auth/methods": { methods, providers: { github: { configured: false } } } });
  const ui = createAccountSettingsUI({ accountClient: client });
  const container = fakeContainer();
  await ui.mount(container);
  assert.equal(client.calls[0].path, "/api/auth/methods");
  assert.ok(container.innerHTML.includes("Password"));
  assert.ok(container.innerHTML.includes("a@b.c"));
});

test("disable/enable/remove buttons call the matching routes and refresh", async () => {
  const methods = [{ id: "m1", type: "magic", label: "Email magic link", email: "a@b.c", createdAt: 1, lastUsedAt: null, disabled: false }];
  let disabled = false;
  const client = stubClient({
    "/api/auth/methods": () => ({ methods: [{ ...methods[0], disabled }], providers: null }),
    "/api/auth/methods/disable": () => { disabled = true; return { method: {} }; },
    "/api/auth/methods/enable": () => { disabled = false; return { method: {} }; },
    "/api/auth/methods/remove": () => ({ removed: true })
  });
  const ui = createAccountSettingsUI({ accountClient: client });
  const container = fakeContainer();
  globalThis.confirm = () => true;
  try {
    await ui.mount(container);
    container.fire("click", clickOn("disable", "m1"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls[1], { path: "/api/auth/methods/disable", method: "POST", data: { id: "m1" } });
    container.fire("click", clickOn("enable", "m1"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls[3], { path: "/api/auth/methods/enable", method: "POST", data: { id: "m1" } });
    container.fire("click", clickOn("remove", "m1"));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls[5], { path: "/api/auth/methods/remove", method: "POST", data: { id: "m1" } });
  } finally { delete globalThis.confirm; }
});

test("passkey add runs the WebAuthn ceremony through the register routes", async () => {
  const enc = value => new TextEncoder().encode(value).buffer;
  const options = { challengeId: "ch-1", challenge: bytesToBase64url(enc("ch")),
    user: { id: bytesToBase64url(enc("u")), name: "u", displayName: "u" }, excludeCredentials: [] };
  const credential = { id: "cred-1", rawId: enc("raw"), type: "public-key",
    response: { clientDataJSON: enc("cdj"), attestationObject: enc("ao") } };
  const created = [];
  const client = stubClient({
    "/api/auth/methods": { methods: [], providers: null },
    "/api/auth/passkey/register/options": options,
    "/api/auth/passkey/register/finish": { registered: true }
  });
  const ui = createAccountSettingsUI({ accountClient: client,
    credentials: { create: async ({ publicKey }) => { created.push(publicKey); return credential; } } });
  const container = fakeContainer();
  await ui.mount(container);
  container.fire("click", clickOn("passkey-add"));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(created.length, 1);
  assert.equal(Buffer.from(created[0].challenge).toString(), "ch");
  const finish = client.calls.find(call => call.path === "/api/auth/passkey/register/finish");
  assert.equal(finish.data.challengeId, "ch-1");
  assert.equal(finish.data.response.id, "cred-1");
  assert.equal(finish.data.response.rawId, bytesToBase64url(enc("raw")));
});

test("recovery-code generation shows the one-time codes", async () => {
  const client = stubClient({
    "/api/auth/methods": { methods: [], providers: null },
    "/api/auth/recovery-codes/generate": { codes: ["AAAA-BBBB", "CCCC-DDDD"], count: 2, warning: "Save these now." }
  });
  const ui = createAccountSettingsUI({ accountClient: client });
  let shownHtml = "";
  const container = { ...fakeContainer(),
    querySelector: sel => sel === "[data-recovery-codes]" ? { set hidden(v) {}, set innerHTML(html) { shownHtml = html; } } : null };
  await ui.mount(container);
  container.fire("click", clickOn("recovery-generate"));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(shownHtml.includes("AAAA-BBBB"));
  assert.ok(shownHtml.includes("CCCC-DDDD"));
  assert.ok(shownHtml.includes("Save these now."));
});
