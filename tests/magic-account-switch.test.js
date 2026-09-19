// QAX-007 (RC-2026-09-19-074) magic account-switch tests: POST
// /api/auth/magic/consume while already authenticated with a DIFFERENT email
// must refuse (409 magic_account_mismatch) — never silently switch accounts
// and never burn the foreign link. Same-account re-auth stays allowed.
//
// Boots a real server against an acceptance-fixture store over loopback; the
// magic mailer is an injected memory mailer. No network, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: fixture.store, magicLinkMailer: mailer });
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

const freshCookie = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;

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

// Signs in as email via the magic flow; returns the authenticated session
// handle (fresh rotated token, csrf, revision, account id).
async function signInAs(origin, slot, sent, email) {
  const before = sent.length;
  const requested = await post(origin, "/api/auth/magic/request", {
    cookie: slot.cookie, csrf: slot.csrf, body: { email }
  });
  assert.equal(requested.status, 200);
  const code = sent[before].code;
  const consumed = await post(origin, "/api/auth/magic/consume", {
    cookie: slot.cookie, csrf: slot.csrf,
    body: { email, code, sessionToken: slot.cookie, sessionRevision: slot.revision }
  });
  assert.equal(consumed.status, 201);
  const view = await consumed.json();
  return { cookie: freshCookie(consumed), csrf: view.csrf, revision: view.sessionRevision, accountId: view.account.id };
}

const requestCode = (origin, session, sent, email) => post(origin, "/api/auth/magic/request", {
  cookie: session.cookie, csrf: session.csrf, body: { email }
}).then(async res => {
  assert.equal(res.status, 200);
  return sent[sent.length - 1].code;
});

const consumeCode = (origin, session, email, code) => post(origin, "/api/auth/magic/consume", {
  cookie: session.cookie, csrf: session.csrf,
  body: { email, code, sessionToken: session.cookie, sessionRevision: session.revision }
});

test("consume for a different email while signed in is refused and the link survives", async t => {
  const { origin, store, sent } = await startServer(t);
  const alice = await signInAs(origin, await openSlot(origin), sent, "alice@example.com");

  // Alice (signed in) opens a magic link meant for bob (no account yet).
  const bobCode = await requestCode(origin, alice, sent, "bob@example.com");
  const refused = await consumeCode(origin, alice, "bob@example.com", bobCode);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "magic_account_mismatch");

  // The foreign link was NOT burned: bob can still use it on a fresh slot.
  const bobSlot = await openSlot(origin);
  const bobConsumed = await consumeCode(origin, bobSlot, "bob@example.com", bobCode);
  assert.equal(bobConsumed.status, 201, "the refused code stays live for its real owner");
  const bobView = await bobConsumed.json();
  assert.notEqual(bobView.account.id, alice.accountId, "no silent account switch happened");

  // Alice is still signed in as herself on her own token.
  assert.equal(store.authenticateAccountSession(alice.cookie).account.id, alice.accountId);
});

test("consume for a different EXISTING account while signed in is refused", async t => {
  const { origin, store, sent } = await startServer(t);
  store.createAccount("acct-bob", "test");
  store.accountLogins.linkPasswordMethod("acct-bob", { email: "bob@example.com", verifier: "scrypt$fixture" });

  const alice = await signInAs(origin, await openSlot(origin), sent, "alice@example.com");
  const bobCode = await requestCode(origin, alice, sent, "bob@example.com");
  const refused = await consumeCode(origin, alice, "bob@example.com", bobCode);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).error.code, "magic_account_mismatch");
  assert.equal(store.authenticateAccountSession(alice.cookie).account.id, alice.accountId);
});

test("re-consuming a link for the SAME email while signed in stays allowed", async t => {
  const { origin, sent } = await startServer(t);
  const alice = await signInAs(origin, await openSlot(origin), sent, "alice@example.com");
  const againCode = await requestCode(origin, alice, sent, "alice@example.com");
  const again = await consumeCode(origin, alice, "alice@example.com", againCode);
  assert.equal(again.status, 201);
  assert.equal((await again.json()).account.id, alice.accountId, "same account, no switch");
});

test("anonymous slots are unaffected by the guard", async t => {
  const { origin, sent } = await startServer(t);
  const slot = await openSlot(origin);
  const requested = await post(origin, "/api/auth/magic/request", {
    cookie: slot.cookie, csrf: slot.csrf, body: { email: "newbie@example.com" }
  });
  assert.equal(requested.status, 200);
  const consumed = await consumeCode(origin, slot, "newbie@example.com", sent[sent.length - 1].code);
  assert.equal(consumed.status, 201, "first-time sign-in on an anonymous slot still works");
});
