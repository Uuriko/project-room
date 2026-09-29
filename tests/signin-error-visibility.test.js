// Magic-link failures must reach a visible first-paint host banner.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAuthSigninUI } from "../src/auth-signin-ui.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function fakeContainer() {
  const listeners = {};
  return {
    innerHTML: "",
    listeners,
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    querySelector() { return null; },
    contains() { return true; }
  };
}

function stubClient({ routes = {}, session = { authenticated: false } } = {}) {
  const calls = [];
  return {
    calls,
    generation: 0,
    session: { csrf: "c".repeat(64), sessionBinding: "b".repeat(64), sessionRevision: 1, ...session },
    owns(generation, session) { return this.generation === generation && this.session === session; },
    invalidate(generation, session) { if (!this.owns(generation, session)) return false; this.generation++; this.session = null; return true; },
    currentSession() { return this.session; },
    async request(path, { data } = {}) {
      calls.push({ path, data });
      const reply = routes[path];
      const resolved = typeof reply === "function" ? reply(data) : reply;
      if (resolved?.throw) throw Object.assign(new Error(resolved.throw.message), { code: resolved.throw.code, status: resolved.throw.status });
      return resolved;
    }
  };
}

function stubWindow(search) {
  // Node ships no window; defineProperty is the way in (cf. the passkey test).
  Object.defineProperty(globalThis, "window", {
    value: {
      location: { search, pathname: "/", hash: "" },
      history: { replaceState() {} }
    },
    configurable: true
  });
}

const flush = async () => {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

function mountLink({ routes, session, search = "?magic=one-time-code&email=m%40example.invalid" }) {
  const client = stubClient({ routes, session });
  const failures = [];
  const signins = [];
  stubWindow(search);
  const ui = createAuthSigninUI({
    accountClient: client,
    ensureAccountSession: async () => client.currentSession(),
    // Mirror the app host: a completed sign-in restores the client session.
    onSignedIn: async view => {
      signins.push(view);
      client.session = { authenticated: true, account: view?.session?.account ?? view?.account };
    },
    onMagicLinkFailure: message => { failures.push(message); }
  });
  const container = fakeContainer(); const initialSignin = ui.mount(container);
  return { client, failures, signins, container, initialSignin };
}

async function mountLinkAndFlush(args) {
  const mounted = mountLink(args);
  try { await mounted.initialSignin; await flush(); } finally { delete globalThis.window; }
  return mounted;
}

test("failed magic-link redemption reports the failure to the host", async () => {
  const { client, failures, signins } = await mountLinkAndFlush({
    routes: { "/api/auth/magic/consume": { throw: { code: "invalid_code", message: "That link has expired." } } }
  });
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].path, "/api/auth/magic/consume");
  assert.equal(client.calls[0].data.email, "m@example.invalid");
  assert.equal(client.calls[0].data.code, "one-time-code");
  assert.equal(client.calls[0].data.sessionRevision, 1);
  assert.deepEqual(failures, ["That link has expired."]);
  assert.equal(signins.length, 0);
});

test("incomplete magic-link redemption (no session in view) reports the failure", async () => {
  const { failures, signins } = await mountLinkAndFlush({
    routes: { "/api/auth/magic/consume": { status: "ok" } }
  });
  assert.deepEqual(failures, ["Sign-in didn\u2019t complete. Try again."]);
  assert.equal(signins.length, 0);
});

test("successful magic-link redemption reports no failure", async () => {
  const { failures, signins } = await mountLinkAndFlush({
    routes: { "/api/auth/magic/consume": { authenticated: true, account: { id: "acct-9" } } }
  });
  assert.deepEqual(failures, []);
  assert.equal(signins.length, 1);
});

test("no magic params: no redemption attempt, no failure report", async () => {
  const { client, failures, signins } = await mountLinkAndFlush({ routes: {}, search: "" });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(failures, []);
  assert.equal(signins.length, 0);
});

test("authenticated browser receives a contextual different-account rejection rather than dropping the link", async () => {
  const { client, failures, signins, container } = await mountLinkAndFlush({
    routes: { "/api/auth/magic/consume": { throw: { status: 409, code: "magic_account_mismatch", message: "Different account" } } },
    session: { authenticated: true, account: { id: "acct-9" } }
  });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(failures, ["Different account"]); assert.equal(signins.length, 0);
  assert.match(container.innerHTML, /data-magic-switch/); assert.equal(client.session.account.id, "acct-9");
});

test("the assertive link-failure banner is outside the hidden auth controller", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const banner = html.indexOf('id="auth-link-error"'), controller = html.indexOf('id="signin-controller"');
  assert.ok(banner !== -1 && controller !== -1);
  assert.ok(banner < controller, "first-paint banner precedes hidden controller");
  assert.match(html, /id="auth-link-error"[^>]*role="alert"/);
});
