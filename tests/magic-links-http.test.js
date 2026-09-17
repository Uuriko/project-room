// Slice 3 (RC-2026-09-17-012) HTTP tests: POST /api/auth/magic/request and
// POST /api/auth/magic/consume in server/http.mjs.
//
// The mailer is an injected memory mailer (createMagicLinkMailer) — no
// network, no real SMTP. The Room's unconfigured default is exercised with
// the bare seam instead of the memory mailer.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const sha256hex = text => createHash("sha256").update(text, "utf8").digest("hex");

async function startServer(t, mailer = null) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const memoryMailer = mailer ?? createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: fixture.store, magicLinkMailer: memoryMailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store: fixture.store, sent };
}

async function openSlot(origin) {
  const res = await fetch(`${origin}/api/account-session`);
  assert.equal(res.status, 200);
  const view = await res.json();
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "");
  assert.ok(match, "slot cookie is set");
  return { cookie: match[1], csrf: view.csrf, revision: view.sessionRevision };
}

const post = (origin, path, { cookie, csrf, body }) => fetch(origin + path, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `account_session=${cookie}`,
    "X-CSRF-Token": csrf,
    Origin: origin
  },
  body: JSON.stringify(body)
});

const requestCode = (origin, slot, email) => post(origin, "/api/auth/magic/request", {
  cookie: slot.cookie, csrf: slot.csrf, body: { email }
});

const consumeCode = (origin, slot, email, code) => post(origin, "/api/auth/magic/consume", {
  cookie: slot.cookie, csrf: slot.csrf, body: { email, code, expectedSessionRevision: slot.revision }
});

test("request -> consume roundtrip upgrades the slot and links the method", async t => {
  const { origin, store, sent } = await startServer(t);
  const slot = await openSlot(origin);
  const email = "Ada@Example.COM";
  const normalized = "ada@example.com";

  const requested = await requestCode(origin, slot, email);
  assert.equal(requested.status, 200);
  assert.deepEqual(await requested.json(), { status: "sent" });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, normalized);
  assert.ok(typeof sent[0].code === "string" && sent[0].code.length > 0);
  assert.ok(sent[0].expiresAt > Date.now());
  const code = sent[0].code;

  const consumed = await consumeCode(origin, slot, email, code);
  assert.equal(consumed.status, 201);
  const view = await consumed.json();
  assert.equal(view.authenticated, true);
  const accountId = `email:${sha256hex(normalized)}`;
  assert.equal(view.account.id, accountId);
  assert.ok((consumed.headers.get("set-cookie") || "").includes("account_session="));

  const methods = store.accountLogins.listMethods(accountId);
  const magic = methods.find(row => row.type === "magic");
  assert.ok(magic, "a magic method is linked");
  assert.equal(magic.email, normalized);
  assert.equal(typeof magic.lastUsedAt, "number");

  // Codes are single-use: the same code no longer works (a fresh slot is
  // used because the slot's CSRF rotates on upgrade).
  const fresh = await openSlot(origin);
  const again = await consumeCode(origin, fresh, email, code);
  assert.equal(again.status, 401);
  assert.equal((await again.json()).error.code, "invalid_magic_code");
});

test("consume links to the existing account when the email already has one", async t => {
  const { origin, store, sent } = await startServer(t);
  const slot = await openSlot(origin);
  const normalized = "bob@example.com";
  store.createAccount("acct-bob", "test");
  store.accountLogins.linkPasswordMethod("acct-bob", { email: normalized, verifier: "scrypt$fixture" });

  const requested = await requestCode(origin, slot, normalized);
  assert.equal(requested.status, 200);
  const consumed = await consumeCode(origin, slot, normalized, sent[0].code);
  assert.equal(consumed.status, 201);
  const view = await consumed.json();
  // Same account, no fork: the magic method attaches to acct-bob.
  assert.equal(view.account.id, "acct-bob");
  const types = store.accountLogins.listMethods("acct-bob").map(row => row.type).sort();
  assert.deepEqual(types, ["magic", "password"]);
});

test("wrong code returns 401 invalid_magic_code", async t => {
  const { origin, sent } = await startServer(t);
  const slot = await openSlot(origin);
  await requestCode(origin, slot, "carol@example.com");
  const consumed = await consumeCode(origin, slot, "carol@example.com", "definitely-not-the-code");
  assert.equal(consumed.status, 401);
  const consumedBody = await consumed.json();
  assert.equal(consumedBody.error.code, "invalid_magic_code");
  // The response never carries a code.
  assert.ok(!JSON.stringify(consumedBody).includes(sent[0].code));
});

test("expired code returns 401 invalid_magic_code", async t => {
  const { origin, store, sent } = await startServer(t);
  const slot = await openSlot(origin);
  await requestCode(origin, slot, "dave@example.com");
  store.db.prepare("UPDATE account_magic_codes SET expires_at=?").run(Date.now() - 1000);
  const consumed = await consumeCode(origin, slot, "dave@example.com", sent[0].code);
  assert.equal(consumed.status, 401);
  assert.equal((await consumed.json()).error.code, "invalid_magic_code");
});

test("five wrong attempts burn the code window", async t => {
  const { origin, sent } = await startServer(t);
  const slot = await openSlot(origin);
  await requestCode(origin, slot, "erin@example.com");
  const code = sent[0].code;
  for (let i = 0; i < 5; i += 1) {
    const res = await consumeCode(origin, slot, "erin@example.com", `wrong-${i}`);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, "invalid_magic_code");
  }
  // The correct code no longer works after the burn.
  const burned = await consumeCode(origin, slot, "erin@example.com", code);
  assert.equal(burned.status, 401);
  assert.equal((await burned.json()).error.code, "invalid_magic_code");
});

test("unconfigured mailer answers honestly and issues no code", async t => {
  const { origin, store } = await startServer(t, createMagicLinkMailer());
  const slot = await openSlot(origin);
  const res = await requestCode(origin, slot, "frank@example.com");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "mail_not_configured");
  assert.ok(typeof body.message === "string" && body.message.includes("not configured"));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM account_magic_codes").get().n, 0);
});

test("request shape is identical whether or not the email has an account", async t => {
  const { origin, store } = await startServer(t);
  const slot = await openSlot(origin);
  const known = await requestCode(origin, slot, "grace@example.com");
  const unknown = await requestCode(origin, slot, "nobody-else@example.com");
  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  const knownBody = await known.json(), unknownBody = await unknown.json();
  assert.deepEqual(knownBody, unknownBody);
  assert.deepEqual(knownBody, { status: "sent" });
  // The shape carries no code and nothing account-specific.
  assert.ok(!JSON.stringify(knownBody).includes("code"));
  assert.ok(store.db.prepare("SELECT count(*) AS n FROM account_magic_codes").get().n >= 2);
});

test("per-email rate limit throttles repeat requests", async t => {
  const { origin } = await startServer(t);
  const slot = await openSlot(origin);
  const email = "hank@example.com";
  for (let i = 0; i < 3; i += 1) {
    const res = await requestCode(origin, slot, email);
    assert.equal(res.status, 200);
  }
  const limited = await requestCode(origin, slot, email);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "rate_limited");
});

test("invalid email is rejected with 422 and malformed bodies are refused", async t => {
  const { origin } = await startServer(t);
  const slot = await openSlot(origin);
  const bad = await requestCode(origin, slot, "not-an-email");
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error.code, "invalid_email");
  const extra = await post(origin, "/api/auth/magic/request", {
    cookie: slot.cookie, csrf: slot.csrf, body: { email: "ok@example.com", extra: 1 }
  });
  assert.equal(extra.status, 422);
  const missing = await post(origin, "/api/auth/magic/consume", {
    cookie: slot.cookie, csrf: slot.csrf, body: { email: "ok@example.com", code: "x" }
  });
  assert.equal(missing.status, 422);
});
