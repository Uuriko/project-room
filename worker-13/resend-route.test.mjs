// WAVE-2000 guild-02 worker-13: route-level test for POST /api/auth/email/verify/resend
// success path (200 resent) + GET /api/account/retention.
// Run: TMPDIR=<worktree>/.tmp node --test worker-13/resend-route.test.mjs
// Covers the mailer-configured branch that the standalone server never reaches
// (server.mjs leaves the mailer seam unconfigured -> 503).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

let nextPort = 49201;
const originFor = port => `http://127.0.0.1:${port}`;

function makeServer({ send } = {}) {
  const port = nextPort++;
  const origin = originFor(port);
  const dir = mkdtempSync(join(tmpdir(), "w13-resend-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { instanceLockPath: join(dir, "lock") });
  const sent = [];
  const mailer = createMagicLinkMailer({ send: send ?? (async args => { sent.push(args); }) });
  const server = createRoomServer({ store, origin, magicLinkMailer: mailer });
  return { store, sent, server, port, origin };
}

function makeServerUnconfigured() {
  const port = nextPort++;
  const origin = originFor(port);
  const dir = mkdtempSync(join(tmpdir(), "w13-resend-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { instanceLockPath: join(dir, "lock") });
  const mailer = createMagicLinkMailer(); // no send -> honestly unconfigured
  const server = createRoomServer({ store, origin, magicLinkMailer: mailer });
  return { store, server, port, origin };
}

function mintSession(store, accountId, email) {
  store.createAccount(accountId, "test");
  if (email) store.accountLogins.linkPasswordMethod(accountId, { email, verifier: "v" });
  const { token, session } = store.createAccountSessionSlot();
  const auth = store.loginAccountSessionWithMethod(token, accountId, session.sessionRevision, {
    method: { kind: "password", ref: "lm" },
  });
  return { token, csrf: auth.csrf };
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function authed(origin, token, csrf, extra = {}) {
  return {
    method: "POST",
    headers: { Origin: origin, Cookie: `account_session=${token}`, "x-csrf-token": csrf, ...extra },
  };
}

function closeServer(t, server, store) {
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
}

test("resend issues a fresh code and reports 200 resent when mail is configured", async t => {
  const { store, sent, server, port, origin } = makeServer();
  closeServer(t, server, store);
  await listen(server, port);
  const { token, csrf } = mintSession(store, "acct-a", "someone@example.com");

  const res = await fetch(`${origin}/api/auth/email/verify/resend`, authed(origin, token, csrf));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "resent");
  assert.equal(body.email, "someone@example.com");
  assert.ok(typeof body.expiresAt === "number" && body.expiresAt > Date.now());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "someone@example.com");
  assert.equal(sent[0].purpose, "email-verify");
  assert.match(sent[0].code, /^\d{6}$/);
});

test("resend still answers 200 when delivery throws (delivery failure is not the resend response)", async t => {
  const { store, server, port, origin } = makeServer({ send: async () => { throw new Error("smtp down"); } });
  closeServer(t, server, store);
  await listen(server, port);
  const { token, csrf } = mintSession(store, "acct-b", "other@example.com");

  const res = await fetch(`${origin}/api/auth/email/verify/resend`, authed(origin, token, csrf));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, "resent");
});

test("resend 503s honestly when the mailer seam is unconfigured", async t => {
  const { store, server, port, origin } = makeServerUnconfigured();
  closeServer(t, server, store);
  await listen(server, port);
  const { token, csrf } = mintSession(store, "acct-c", "third@example.com");
  const res = await fetch(`${origin}/api/auth/email/verify/resend`, authed(origin, token, csrf));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, "mail_not_configured");
});

test("resend 429s after 5 per-account resends within the window", async t => {
  const { store, sent, server, port, origin } = makeServer();
  closeServer(t, server, store);
  await listen(server, port);
  const { token, csrf } = mintSession(store, "acct-d", "fourth@example.com");
  const statuses = [];
  for (let i = 0; i < 7; i++) {
    const res = await fetch(`${origin}/api/auth/email/verify/resend`, authed(origin, token, csrf));
    statuses.push(res.status);
    await res.text();
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  assert.equal(sent.length, 5);
});

test("retention returns the policy document to any authenticated account", async t => {
  const { store, server, port, origin } = makeServer();
  closeServer(t, server, store);
  await listen(server, port);
  const { token } = mintSession(store, "acct-e", null);
  const res = await fetch(`${origin}/api/account/retention`, {
    headers: { Cookie: `account_session=${token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.policy && typeof body.policy.version === "string");
});
