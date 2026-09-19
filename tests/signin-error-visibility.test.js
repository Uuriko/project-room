// QAX-002 (RC-2026-09-19-077): a failed magic-link redemption must surface
// visibly on first paint. The sign-in module's own status line lives inside
// the collapsed #signin-extra panel, so the module reports link failures to
// the host via onMagicLinkFailure and the host renders them in a banner above
// the sign-in panel. These tests pin the module side of that contract plus
// the banner's placement outside the collapsed panel. No DOM, no network.
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
    session,
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
  ui.mount(fakeContainer());
  return { client, failures, signins };
}

async function mountLinkAndFlush(args) {
  const mounted = mountLink(args);
  try { await flush(); } finally { delete globalThis.window; }
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

test("already-authenticated browser ignores the link params", async () => {
  const { client, failures, signins } = await mountLinkAndFlush({
    routes: {},
    session: { authenticated: true, account: { id: "acct-9" } }
  });
  assert.equal(client.calls.length, 0);
  assert.deepEqual(failures, []);
  assert.equal(signins.length, 0);
});

test("the link-failure banner lives outside the collapsed sign-in panel", () => {
  const html = readFileSync(join(ROOT, "index.html"), "utf8");
  const banner = html.indexOf('id="auth-link-error"');
  const extra = html.indexOf('id="signin-extra"');
  assert.ok(banner !== -1, "index.html has the #auth-link-error banner");
  assert.ok(extra !== -1, "index.html keeps the collapsed #signin-extra panel");
  assert.ok(banner < extra, "the banner renders above (outside) the collapsed panel, visible on first paint");
  assert.match(html, /id="auth-link-error"[^>]*role="alert"/, "the banner is announced assertively");
});
