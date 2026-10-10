// HS2 1b — device-code agent connect (fixwave GUILD B1).
// Fail-first HTTP integration tests for server/device-codes.mjs and the
// /approve/<code> route in server/http.mjs.
//
// Flow: an agent holding an identity secret issues a short ABCD-EFGH code,
// prints the link + code; a human approves on their phone. The approval page
// shows the code the agent displayed (anti-phishing); approval binds the
// identity into the room. No secret is ever pasted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const ROOM = "commons";
const CODE_RE = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;

const startServer = async (t, f) => {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
};

const post = (origin, path, body, secret = null) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body ?? {}),
});
const get = (origin, path, secret = null) => fetch(`${origin}${path}`, {
  headers: secret ? { authorization: `Bearer ${secret}` } : {},
});
const jsonOf = async res => ({ status: res.status, body: await res.json() });
const sha256hex = value => createHash("sha256").update(value).digest("hex");

const issue = async (origin, agent, { permissions } = {}) => {
  const { status, body } = await jsonOf(await post(origin, "/api/device-codes",
    { identityId: agent.identityId, roomId: ROOM, displayName: "Device agent", ...(permissions ? { permissions } : {}) },
    agent.secret));
  assert.equal(status, 201, `issue failed: ${JSON.stringify(body)}`);
  return body;
};

test("issue: holder's own secret returns a 201 with an ABCD-EFGH code, approve URL, and ~10-minute expiry", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent);
  assert.match(issued.code, CODE_RE, `code shape: ${issued.code}`);
  assert.ok(issued.approveUrl.endsWith(`/approve/${issued.code}`), `approveUrl: ${issued.approveUrl}`);
  const ttl = issued.expiresAt - Date.now();
  assert.ok(ttl > 9 * 60 * 1000 && ttl <= 10 * 60 * 1000 + 5000, `ttl ~10min, got ${ttl}`);
  // The raw code is never stored: only its SHA-256 hash lives in the row.
  const row = f.store.db.prepare("SELECT code_hash AS codeHash FROM device_codes WHERE code_hash=?").get(sha256hex(issued.code));
  assert.ok(row, "hash row present");
  assert.match(row.codeHash, /^[0-9a-f]{64}$/);
  const raw = f.store.db.prepare("SELECT * FROM device_codes").get();
  assert.ok(!JSON.stringify(raw).includes(issued.code), "raw code must not appear anywhere in the stored row");
});

test("issue: no bearer, wrong secret, or another identity's secret all fail", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const other = f.store.identities.create("Other agent");
  const payload = { identityId: agent.identityId, roomId: ROOM };

  assert.equal((await post(origin, "/api/device-codes", payload)).status, 401, "no bearer");
  const wrong = await jsonOf(await post(origin, "/api/device-codes", payload, "pri_totallybogus"));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "unauthenticated");
  // Cross-identity: another identity's secret cannot issue for this identityId.
  const cross = await jsonOf(await post(origin, "/api/device-codes", payload, other.secret));
  assert.equal(cross.status, 401);
});

test("approval binds the identity: owner approves, identity is linked to the room, poll reads approved", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent, { permissions: ["accept_work", "complete_work"] });

  const pending = await jsonOf(await get(origin, `/api/device-codes/${issued.code}/status`));
  assert.equal(pending.status, 200);
  assert.equal(pending.body.status, "pending");

  const approved = await jsonOf(await post(origin, `/api/device-codes/${issued.code}/approve`, null, f.keys.owner));
  assert.equal(approved.status, 200, `approve failed: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.identityId, agent.identityId);
  assert.equal(approved.body.memberId, agent.identityId);

  const link = f.store.db.prepare("SELECT identity_id AS identityId, member_id AS memberId FROM identity_links WHERE room_id=? AND identity_id=?")
    .get(ROOM, agent.identityId);
  assert.ok(link, "approval binds the identity into the room");
  assert.equal(link.memberId, agent.identityId);

  const after = await jsonOf(await get(origin, `/api/device-codes/${issued.code}/status`));
  assert.equal(after.status, 200);
  assert.equal(after.body.status, "approved");
  assert.equal(after.body.memberId, agent.identityId);
});

test("expired code is rejected: status reads expired, approve is 410", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent);
  f.store.db.prepare("UPDATE device_codes SET expires_at=? WHERE code_hash=?")
    .run(Date.now() - 1000, sha256hex(issued.code));

  const status = await jsonOf(await get(origin, `/api/device-codes/${issued.code}/status`));
  assert.equal(status.status, 200);
  assert.equal(status.body.status, "expired");

  const approved = await jsonOf(await post(origin, `/api/device-codes/${issued.code}/approve`, null, f.keys.owner));
  assert.equal(approved.status, 410);
  assert.equal(approved.body.error.code, "device_code_expired");
});

test("reused code is rejected: a second approve is 409", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent);
  const first = await post(origin, `/api/device-codes/${issued.code}/approve`, null, f.keys.owner);
  assert.equal(first.status, 200);
  const second = await jsonOf(await post(origin, `/api/device-codes/${issued.code}/approve`, null, f.keys.owner));
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, "device_code_consumed");
});

test("wrong code is rejected: status and approve on a bogus code are 404", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  await issue(origin, agent);
  const bogus = "ZZZZ-ZZZZ";
  const status = await jsonOf(await get(origin, `/api/device-codes/${bogus}/status`));
  assert.equal(status.status, 404);
  assert.equal(status.body.error.code, "device_code_not_found");
  const approved = await jsonOf(await post(origin, `/api/device-codes/${bogus}/approve`, null, f.keys.owner));
  assert.equal(approved.status, 404);
  assert.equal(approved.body.error.code, "device_code_not_found");
});

test("approval page shows the code the agent displayed (anti-phishing) and 404s on unknown codes", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent);

  const page = await get(origin, `/approve/${issued.code}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.ok(html.includes(issued.code), "page must display the code so the human can compare it with what the agent showed");
  assert.ok(html.includes("Device agent"), "page names the requesting identity");
  const roomTitle = f.store.room(ROOM).state.room.title;
  assert.ok(html.includes(roomTitle), "page names the room");

  const missing = await get(origin, "/approve/ZZZZ-ZZZZ");
  assert.equal(missing.status, 404);
});

test("deny consumes the code: poll reads denied, approve afterwards is 409", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const agent = f.store.identities.create("Device agent");
  const issued = await issue(origin, agent);
  const denied = await post(origin, `/api/device-codes/${issued.code}/deny`, null, f.keys.owner);
  assert.equal(denied.status, 200);
  const status = await jsonOf(await get(origin, `/api/device-codes/${issued.code}/status`));
  assert.equal(status.body.status, "denied");
  const link = f.store.db.prepare("SELECT 1 FROM identity_links WHERE room_id=? AND identity_id=?").get(ROOM, agent.identityId);
  assert.ok(!link, "a denied code must not bind the identity");
  const approved = await jsonOf(await post(origin, `/api/device-codes/${issued.code}/approve`, null, f.keys.owner));
  assert.equal(approved.status, 409);
});
