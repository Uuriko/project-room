import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { hashPassword, verifyPassword } from "../src/password-auth.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { request as httpRequest } from "node:http";

async function fixture(t, configured = true, { noticeFails = false } = {}) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  for (const [id, email] of [["reset-owner", "owner@example.com"], ["unrelated", "other@example.com"]]) {
    store.createAccount(id);
    store.accountLogins.linkPasswordMethod(id, { email, verifier: hashPassword("original-password") });
  }
  store.bindHumanAccount("commons", "owner", "reset-owner");
  const ownerKey = store.issueAccessKey("commons", "owner"), sent = [];
  const magicLinkMailer = configured ? { isConfigured: () => true, sendMagicLink: payload => configuredMailer.sendMagicLink(payload),
    sendPasswordResetNotice: payload => configuredMailer.sendPasswordResetNotice(payload) } : createMagicLinkMailer();
  const server = createRoomServer({ store, magicLinkMailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configuredMailer = createMagicLinkMailer({ baseUrl: origin, send: async payload => {
    if (noticeFails && payload.purpose === "password-reset-complete") throw new Error("synthetic notification failure");
    sent.push(payload);
  } });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const openSlot = async () => {
    const response = await fetch(origin + "/api/account-session");
    return { cookie: /account_session=([^;]+)/.exec(response.headers.get("set-cookie"))[1], view: await response.json() };
  };
  const post = (path, slot, body, headers = {}) => fetch(origin + path, { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json", Cookie: `account_session=${slot.cookie}`, "X-CSRF-Token": slot.view.csrf, ...headers }, body: JSON.stringify(body) });
  return { store, ownerKey, origin, sent, openSlot, post };
}
const requestPath = "/api/auth/password/reset/request", consumePath = "/api/auth/password/reset/consume";
const proofBody = (delivery, slot) => ({ email: delivery.to, code: delivery.code, newPassword: "replacement-password", sessionRevision: slot.view.sessionRevision });

test("reset request is nonenumerating and actual delivered URL retains destination without signing in", async t => {
  const f = await fixture(t), slot = await f.openSlot();
  const returnTo = "/?room=commons#invite/" + "A".repeat(43);
  for (const email of ["owner@example.com", "unknown@example.com"]) {
    const response = await f.post(requestPath, slot, { email, returnTo });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "sent" });
    const delivery = f.sent.at(-1), link = new URL(delivery.link);
    assert.equal(delivery.purpose, "password-reset");
    assert.equal(link.origin, f.origin);
    assert.equal(link.searchParams.get("room"), "commons");
    assert.equal(link.hash, new URL(returnTo, f.origin).hash);
    assert.equal(link.searchParams.get("reset"), delivery.code);
    assert.equal(link.searchParams.has("magic"), false);
  }
  const unknown = await f.post(consumePath, slot, proofBody(f.sent[1], slot));
  assert.equal(unknown.status, 401);
  assert.equal((await unknown.json()).error.code, "invalid_password_reset");
  assert.equal(verifyPassword("original-password", f.store.accountLogins.readPasswordVerifier("reset-owner")), true);
});

test("foreign-account mismatch does not burn proof; reset ends target sessions but preserves unrelated/agent authority", async t => {
  const f = await fixture(t), slot = await f.openSlot();
  const key = f.store.issueAccountAccessKey("reset-owner"), unrelatedKey = f.store.issueAccountAccessKey("unrelated");
  const ownerSlot = f.store.createAccountSessionSlot();
  f.store.loginAccountSession(ownerSlot.token, key, 0);
  const roomSession = f.store.createSession(f.ownerKey);
  f.store.command(f.ownerKey, "commons", { id: "reset-agent-added", type: T.MEMBER_ADDED,
    data: { memberId: "reset-peer", displayName: "Independent agent", kind: "agent", permissions: [] } });
  const agentKey = f.store.issueAccessKey("commons", "reset-peer");
  const beforeEpoch = f.store.account("reset-owner").authEpoch;
  await f.post(requestPath, slot, { email: "owner@example.com" });
  const delivery = f.sent[0];
  const foreign = await f.openSlot();
  const login = await f.post("/api/account-session", foreign, { accountAccessKey: unrelatedKey, expectedSessionRevision: foreign.view.sessionRevision });
  foreign.cookie = /account_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1]; foreign.view = await login.json();
  const mismatch = await f.post(consumePath, foreign, proofBody(delivery, foreign));
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error.code, "reset_account_mismatch");
  const completed = await f.post(consumePath, slot, proofBody(delivery, slot));
  assert.equal(completed.status, 200);
  assert.deepEqual(await completed.json(), { status: "password_reset", signInRequired: true });
  assert.throws(() => f.store.authenticateAccountAccessKey(key), error => error.status === 401);
  assert.throws(() => f.store.authenticateAccountSession(ownerSlot.token), error => error.status === 401);
  assert.throws(() => f.store.authenticate(roomSession.token), error => error.status === 401);
  assert.throws(() => f.store.authenticate(f.ownerKey), error => error.status === 401);
  assert.equal(f.store.authenticateAccountAccessKey(unrelatedKey).account.id, "unrelated");
  assert.equal(f.store.authenticate(agentKey).member.id, "reset-peer");
  assert.equal(f.store.account("reset-owner").authEpoch, beforeEpoch, "membership/invitation issuer epochs do not change with session revocation");
  const restored = await fetch(f.origin + "/api/account-session", { headers: { Cookie: `account_session=${slot.cookie}` } });
  assert.equal((await restored.json()).authenticated, false, "reset does not log the browser in");
  assert.equal((await f.post(consumePath, slot, proofBody(delivery, slot))).status, 401);
  const loggedIn = await f.post("/api/auth/password/login", slot, { email: "owner@example.com", password: "replacement-password", sessionRevision: slot.view.sessionRevision });
  assert.equal(loggedIn.status, 200);
  assert.equal((await loggedIn.json()).authenticated, true);
});

test("unsafe return, Origin, CSRF, revision and password policy fail without burning reset proof", async t => {
  const f = await fixture(t), slot = await f.openSlot();
  assert.equal((await f.post(requestPath, slot, { email: "owner@example.com", returnTo: "//evil.example/" })).status, 422);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM account_magic_codes").get().n, 0);
  await f.post(requestPath, slot, { email: "owner@example.com" });
  const body = proofBody(f.sent[0], slot);
  for (const headers of [{ Origin: "https://evil.example" }, { "X-CSRF-Token": "wrong" }]) assert.equal((await f.post(consumePath, slot, body, headers)).status, 403);
  assert.equal((await f.post(consumePath, slot, { ...body, sessionRevision: body.sessionRevision + 1 })).status, 409);
  assert.equal((await f.post(consumePath, slot, { ...body, newPassword: "short" })).status, 422);
  assert.equal((await f.post(consumePath, slot, body)).status, 200);
});

test("reset unconfigured mail and per-email rate limits retain honest bounded behavior", async t => {
  const f = await fixture(t, false), slot = await f.openSlot();
  for (let n = 0; n < 3; n++) {
    const response = await f.post(requestPath, slot, { email: "unknown@example.com" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reason, "mail_not_configured");
  }
  assert.equal((await f.post(requestPath, slot, { email: "unknown@example.com" })).status, 429);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM account_magic_codes").get().n, 0);
});

test("same-account reset clears its browser identity and advances the slot revision", async t => {
  const f = await fixture(t), slot = await f.openSlot();
  const key = f.store.issueAccountAccessKey("reset-owner");
  const login = await f.post("/api/account-session", slot, { accountAccessKey: key, expectedSessionRevision: slot.view.sessionRevision });
  slot.cookie = /account_session=([^;]+)/.exec(login.headers.get("set-cookie"))[1]; slot.view = await login.json();
  await f.post(requestPath, slot, { email: "owner@example.com" });
  const response = await f.post(consumePath, slot, proofBody(f.sent[0], slot));
  assert.equal(response.status, 200);
  assert.equal(f.store.accountSessionSlot(slot.cookie).sessionRevision, slot.view.sessionRevision + 1);
  const restored = await fetch(f.origin + "/api/account-session", { headers: { Cookie: `account_session=${slot.cookie}` } });
  assert.equal((await restored.json()).authenticated, false);
  assert.equal(f.sent[1].purpose, "password-reset-complete");
  assert.equal(Object.hasOwn(f.sent[1], "code"), false, "completion notification contains no reset proof");
});

test("completion notification failure does not turn a committed reset into an uncertain mutation", async t => {
  const f = await fixture(t, true, { noticeFails: true }), slot = await f.openSlot();
  await f.post(requestPath, slot, { email: "owner@example.com" });
  const body = proofBody(f.sent[0], slot);
  const response = await f.post(consumePath, slot, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "password_reset", signInRequired: true });
  assert.equal(verifyPassword("replacement-password", f.store.accountLogins.readPasswordVerifier("reset-owner")), true);
  assert.equal((await f.post(consumePath, slot, body)).status, 401);
});

for (const mutation of ["logout", "rotate login slot"]) {
  test(`a held reset body cannot consume proof after concurrent ${mutation}`, { timeout: 5000 }, async t => {
    const f = await fixture(t), slot = await f.openSlot();
    const loggedIn = await f.post("/api/account-session", slot, { accountAccessKey: f.store.issueAccountAccessKey("reset-owner"), expectedSessionRevision: slot.view.sessionRevision });
    slot.cookie = /account_session=([^;]+)/.exec(loggedIn.headers.get("set-cookie"))[1]; slot.view = await loggedIn.json();
    await f.post(requestPath, slot, { email: "owner@example.com" });
    const delivery = f.sent[0], payload = JSON.stringify(proofBody(delivery, slot));
    const original = f.store.accountSessionSlot.bind(f.store);
    let sawRead; const slotRead = new Promise(resolve => { sawRead = resolve; });
    let armed = true;
    f.store.accountSessionSlot = (...args) => {
      const value = original(...args);
      if (armed && args[0] === slot.cookie) { armed = false; sawRead(); }
      return value;
    };
    let held;
    const result = new Promise((resolve, reject) => {
      held = httpRequest(f.origin + consumePath, { method: "POST", headers: {
        Origin: f.origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload),
        Cookie: `account_session=${slot.cookie}`, "X-CSRF-Token": slot.view.csrf
      } }, response => {
        let text = ""; response.setEncoding("utf8"); response.on("data", chunk => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
      });
      held.on("error", reject); held.write(payload.slice(0, 1));
    });
    t.after(() => held.destroy());
    await slotRead;
    if (mutation === "logout") {
      const logout = await fetch(f.origin + "/api/account-session", { method: "DELETE", headers: {
        Origin: f.origin, "Content-Type": "application/json", Cookie: `account_session=${slot.cookie}`, "X-CSRF-Token": slot.view.csrf
      }, body: JSON.stringify({ expectedSessionRevision: slot.view.sessionRevision }) });
      assert.equal(logout.status, 200);
    } else {
      const rotated = await f.post("/api/account-session", slot, { accountAccessKey: f.store.issueAccountAccessKey("unrelated"), expectedSessionRevision: slot.view.sessionRevision });
      assert.equal(rotated.status, 201);
      assert.notEqual(/account_session=([^;]+)/.exec(rotated.headers.get("set-cookie"))[1], slot.cookie);
    }
    held.end(payload.slice(1));
    const refused = await result;
    assert.ok([401, 403, 409].includes(refused.status), `stale body must be refused, got ${refused.status}`);
    assert.equal(verifyPassword("original-password", f.store.accountLogins.readPasswordVerifier("reset-owner")), true);
    assert.equal(f.store.db.prepare("SELECT consumed_at FROM account_magic_codes").get().consumed_at, null);
    const fresh = await f.openSlot();
    assert.equal((await f.post(consumePath, fresh, proofBody(delivery, fresh))).status, 200, "fresh browser slot can still redeem unburned proof");
  });
}

test("invalid reset proofs still commit bounded attempts inside the slot freshness transaction", async t => {
  const f = await fixture(t), slot = await f.openSlot();
  await f.post(requestPath, slot, { email: "owner@example.com" });
  const delivery = f.sent[0];
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await f.post(consumePath, slot, { ...proofBody(delivery, slot), code: "incorrect-reset-proof" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, "invalid_password_reset");
    const row = f.store.db.prepare("SELECT attempts FROM account_magic_codes").get();
    if (attempt < 5) assert.equal(row.attempts, attempt);
    else assert.equal(row, undefined);
  }
  assert.equal((await f.post(consumePath, slot, proofBody(delivery, slot))).status, 401);
  assert.equal(verifyPassword("original-password", f.store.accountLogins.readPasswordVerifier("reset-owner")), true);
});
