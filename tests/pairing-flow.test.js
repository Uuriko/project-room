// Device-code pairing over HTTP (server/routes/pairing.mjs): start, poll, approve, deny, expiry, interval, replay, caps.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PAIR_POLL_INTERVAL_MS, PAIR_TTL_MS } from "../server/pairing.mjs";

function boot(t, now = () => Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), "room-pair-flow-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ store, ownerKey, origin: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function http(origin, path, { method = "GET", token, body } = {}) {
  const headers = { Origin: origin };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html pages */ }
  return { status: res.status, json, text };
}

test("approve then poll returns one connection and a later poll is a duplicate", async t => {
  let now = 1_800_000_000_000;
  const { origin, ownerKey } = await boot(t, () => now);
  const started = await http(origin, "/api/pair", { method: "POST", body: { room: "commons", name: "Ada Agent" } });
  assert.equal(started.status, 200);
  assert.match(started.json.userCode, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(typeof started.json.deviceSecret, "string");
  const pending = await http(origin, `${started.json.pollUrl}?secret=${encodeURIComponent(started.json.deviceSecret)}`);
  assert.equal(pending.status, 400);
  assert.equal(pending.json.error, "authorization_pending");
  const approved = await http(origin, "/api/rooms/commons/pairs/" + started.json.pairId + "/decide", {
    method: "POST", token: ownerKey, body: { decision: "approve", profile: "contribute" }
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.json));
  assert.equal(approved.json.connection.roomId, "commons");
  assert.equal(typeof approved.json.connection.token, "string");
  now += PAIR_POLL_INTERVAL_MS;
  const first = await http(origin, `${started.json.pollUrl}?secret=${encodeURIComponent(started.json.deviceSecret)}`);
  assert.equal(first.status, 200);
  assert.equal(first.json.token, approved.json.connection.token);
  assert.equal(first.json.duplicate, undefined);
  now += PAIR_POLL_INTERVAL_MS;
  const again = await http(origin, `${started.json.pollUrl}?secret=${encodeURIComponent(started.json.deviceSecret)}`);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.memberId, first.json.memberId);
});

test("a second poll inside the interval is slow_down and a denied pair is access_denied", async t => {
  const { origin, ownerKey } = await boot(t);
  const started = await http(origin, "/api/pair?room=commons&name=Bea%20Agent");
  assert.equal(started.status, 200);
  const poll = () => http(origin, `${started.json.pollUrl}?secret=${encodeURIComponent(started.json.deviceSecret)}`);
  assert.equal((await poll()).json.error, "authorization_pending");
  assert.equal((await poll()).json.error, "slow_down");
  const denied = await http(origin, "/api/rooms/commons/pairs/decide", {
    method: "POST", token: ownerKey, body: { userCode: started.json.userCode, decision: "deny" }
  });
  assert.equal(denied.status, 200);
  assert.equal(denied.json.status, "denied");
  let nowWait = Date.now() + PAIR_POLL_INTERVAL_MS + 50;
  while (Date.now() < nowWait) await new Promise(resolve => setTimeout(resolve, 20));
  const after = await poll();
  assert.equal(after.status, 400);
  assert.equal(after.json.error, "access_denied");
});

test("a pair past its lifetime polls as expired_token", async t => {
  let now = 1_800_000_000_000;
  const { origin } = await boot(t, () => now);
  const started = await http(origin, "/api/pair", { method: "POST", body: { roomId: "commons", displayName: "Cara Agent" } });
  now += PAIR_TTL_MS + 1;
  const polled = await http(origin, `${started.json.pollUrl}?secret=${encodeURIComponent(started.json.deviceSecret)}`);
  assert.equal(polled.json.error, "expired_token");
});

test("eleven starts from one address are rate limited and a sixth pending pair is refused", async t => {
  const { origin } = await boot(t);
  const start = name => http(origin, "/api/pair", { method: "POST", body: { room: "commons", name } });
  const first = [];
  for (let i = 0; i < 5; i++) first.push(await start(`Agent ${i} Name`));
  assert.ok(first.every(row => row.status === 200));
  const sixth = await start("Agent 5 Name");
  assert.equal(sixth.status, 409);
  assert.equal(sixth.json.error.code, "too_many_requests");
  for (let i = 0; i < 4; i++) await start(`Extra ${i} Name`);
  const limited = await start("Extra 4 Name");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.error.code, "rate_limited");
});

test("five wrong codes lock further code decisions", async t => {
  const { origin, ownerKey } = await boot(t);
  const started = await http(origin, "/api/pair", { method: "POST", body: { room: "commons", name: "Dana Agent" } });
  assert.equal(started.status, 200);
  for (let i = 0; i < 5; i++) {
    const wrong = await http(origin, "/api/rooms/commons/pairs/decide", {
      method: "POST", token: ownerKey, body: { userCode: "ZZZZ-ZZZZ", decision: "deny" }
    });
    assert.equal(wrong.status, 404);
  }
  const locked = await http(origin, "/api/rooms/commons/pairs/decide", {
    method: "POST", token: ownerKey, body: { userCode: started.json.userCode, decision: "approve" }
  });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.error.code, "code_locked");
});
