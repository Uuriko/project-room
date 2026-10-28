// Auth audit 2026-10-09, row 23 (prod 5b08aa51): after an account is deleted,
// its email is locked out. Signup derives the same account id from the email
// (passwordAccountId), hits the deactivated tombstone, and answers "you already
// have an account"; email sign-in then fails with "Active account required".
// Deleting an account must free its email for a fresh start.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";

const PASSWORD = "fixture-password-deleted-reuse";
const EMAIL = "came-back@example.invalid";

async function start(t) {
  const f = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({ store: f.store,
    magicLinkMailer: createMagicLinkMailer({ baseUrl: "https://room.example.invalid", send: async m => { sent.push(m); } }) });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); f.store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, creds) => fetch(origin + path, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...(creds ? { Cookie: creds.cookie, "X-CSRF-Token": creds.csrf } : {}) },
    body: JSON.stringify(data) });
  const credsFrom = res => {
    const token = /account_session=([^;]+)/.exec(res.headers.get("set-cookie") || "")?.[1];
    if (!token) return null;
    const session = f.store.authenticateAccountSession(token);
    return { cookie: `account_session=${token}`, csrf: session.csrf, accountId: session.account?.id ?? null };
  };
  const slot = () => f.store.createAccountSessionSlot();
  const signup = async () => {
    const s = slot();
    const res = await post("/api/auth/password/signup", { email: EMAIL, password: PASSWORD, sessionToken: s.token, sessionRevision: s.session.sessionRevision });
    return { status: res.status, creds: credsFrom(res) };
  };
  const remove = async creds => {
    const plan = await (await fetch(origin + "/api/account/deletion/plan", { headers: { Cookie: creds.cookie } })).json();
    const res = await post("/api/account/delete", { confirmationToken: plan.confirmationToken }, creds);
    assert.equal(res.status, 200, "the first account is deleted");
  };
  return { f, sent, post, signup, remove, slot, credsFrom };
}

test("an email whose account was deleted can sign up again and gets a working account", async t => {
  const { signup, remove } = await start(t);
  const first = await signup();
  assert.equal(first.status, 202);
  assert.ok(first.creds?.accountId, "first signup signs in");
  await remove(first.creds);
  const again = await signup();
  assert.equal(again.status, 202);
  assert.ok(again.creds?.accountId, "signing up again signs the person in, instead of the 'already have an account' branch");
});

test("after deletion and a fresh signup, password login works", async t => {
  const { signup, remove, post, slot, credsFrom } = await start(t);
  await remove((await signup()).creds);
  await signup();
  const s = slot();
  const res = await post("/api/auth/password/login", { email: EMAIL, password: PASSWORD, sessionToken: s.token, sessionRevision: s.session.sessionRevision });
  assert.equal(res.status, 200, "login with the new password works");
  assert.ok(credsFrom(res)?.accountId);
});

test("after deletion, an email sign-in link starts a fresh account instead of 'Active account required'", async t => {
  const { signup, remove, post, slot, sent, credsFrom, f } = await start(t);
  const first = (await signup()).creds;
  await remove(first);
  const s = slot();
  const browser = { cookie: `account_session=${s.token}`, csrf: s.session.csrf };
  const request = await post("/api/auth/magic/request", { email: EMAIL }, browser);
  assert.equal(request.status, 200);
  const code = sent.filter(m => m.to === EMAIL && !m.purpose).at(-1)?.code;
  assert.ok(code, "a sign-in code was mailed");
  const current = f.store.accountSessionSlot(s.token);
  const res = await post("/api/auth/magic/consume", { email: EMAIL, code, sessionRevision: current.sessionRevision }, browser);
  assert.equal(res.status, 201, "the link signs in");
  const creds = credsFrom(res);
  assert.ok(creds?.accountId && creds.accountId !== first.accountId, "a new account, not the tombstone");
});
