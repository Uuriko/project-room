// FIX-64: one canonical 429 shape + exposed budgets.
//
// Every 429 must answer the same body shape — the documented error envelope
// ({ error: { code, message }, status, reason, hint, next, operationId,
// category }) plus a nested `detail` object carrying the machine-readable
// retry info ({ retryAfterMs, limit, window, resetAt?, remaining? }).
// Retry-After on 429s must come from that detail, not a hardcoded 60.
// Responses guarded by a limiter carry RateLimit-Limit/Remaining/Reset,
// including 200s. GET /api/agent-rooms/budget exposes the caller's budgets
// (room-creation cap, write budget) with remaining + reset.
//
// These tests are written against the CURRENT behavior first: they fail
// until the implementation lands.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { agentRoomSchema, AGENT_ROOM_CREATE_CAPACITY } from "../server/agent-rooms.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const PAGE_HTML = `<!doctype html><html><head><title>t</title></head><body><p>hello</p></body></html>`;

async function serve(t) {
  process.env.WEB_FETCH_ALLOW_LOOPBACK = "1";
  const directory = mkdtempSync(join(tmpdir(), "room-fix64-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MEMBER_ADDED, { memberId: "member", displayName: "Member", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  store.bindHumanAccount("commons", "member", "account-member");
  const memberKey = store.issueAccessKey("commons", "member");
  const page = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  });
  await new Promise(resolve => page.listen(0, "127.0.0.1", resolve));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => page.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.WEB_FETCH_ALLOW_LOOPBACK;
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const pageOrigin = `http://127.0.0.1:${page.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, ownerKey, memberKey, pageOrigin };
}

const createArgs = (roomId) => ({
  roomId, title: "Fix64 Room", purpose: "Testing 429 shapes.", kind: "personal", displayName: "Fix64"
});

// The canonical 429 assertions every 429 body must satisfy.
function assertCanonical429(body, headers, { retryAfterGte } = {}) {
  assert.equal(body.error.code, "rate_limited");
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.detail && typeof body.detail === "object", "nested detail object present");
  assert.equal(typeof body.detail.retryAfterMs, "number", "detail.retryAfterMs is a number");
  assert.ok(body.detail.retryAfterMs >= 0);
  if (retryAfterGte !== undefined) assert.ok(body.detail.retryAfterMs >= retryAfterGte);
  // The documented error envelope rides along on every 429.
  for (const key of ["status", "reason", "hint", "next", "operationId", "category"]) {
    assert.ok(body[key] !== undefined, `envelope key ${key} present`);
  }
  assert.equal(body.category, "rate_limited");
  // Retry-After is derived from the detail, not a hardcoded value.
  const retryAfter = headers.get("retry-after");
  assert.ok(retryAfter, "Retry-After header present");
  assert.equal(retryAfter, String(Math.max(1, Math.ceil(body.detail.retryAfterMs / 1000))),
    "Retry-After matches detail.retryAfterMs");
}

test("the two /api/web/fetch 429s share one canonical shape", async t => {
  const { request, memberKey, ownerKey, pageOrigin, store } = await serve(t);
  const fetchBody = { url: `${pageOrigin}/page`, formats: { markdown: true } };
  // A second member with a fresh per-credential write budget for the quota leg.
  const command = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  command(T.MEMBER_ADDED, { memberId: "member2", displayName: "Second Member", kind: "human", permissions: ["accept_work", "complete_work", "verify"] });
  store.bindHumanAccount("commons", "member2", "account-member2");
  const member2Key = store.issueAccessKey("commons", "member2");

  // Shape A: the per-credential write limiter (61st request in the minute).
  let perAddress = null;
  for (let i = 0; i < 61; i++) {
    const res = await request("/api/web/fetch", { method: "POST", token: memberKey, data: fetchBody });
    if (i === 60) perAddress = res;
    else await res.arrayBuffer(); // drain
    assert.ok(res.status === 200 || res.status === 429, `unexpected status ${res.status} on fetch ${i}`);
  }
  assert.equal(perAddress.status, 429, "61st fetch in a minute is rate limited");
  const perAddressBody = await perAddress.json();
  assertCanonical429(perAddressBody, perAddress.headers);

  // Shape B: the web-fetch quota path (pre-filled journal rows, fresh credential).
  const now = Date.now();
  const insert = store.db.prepare(`INSERT INTO web_fetch_log
    (request_id, room_id, member_id, host, cache_status, bytes, tags_json, created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  store.transaction(() => {
    for (let i = 0; i < 100; i++) {
      insert.run(`wf_fix64_${i}`, "commons", "member2", "example.com", "hit", 10, "[]", now - 1000);
    }
  });
  const quota = await request("/api/web/fetch", { method: "POST", token: member2Key, data: fetchBody });
  assert.equal(quota.status, 429, "quota exhaustion is 429");
  const quotaBody = await quota.json();
  assertCanonical429(quotaBody, quota.headers);
  // Legacy flat fields stay for existing clients.
  assert.ok(typeof quotaBody.retryAfterMs === "number");
  assert.ok(typeof quotaBody.resetAt === "number");
  assert.ok(typeof quotaBody.request_id === "string");
});

test("the room-creation 429 carries canonical detail and an honest Retry-After", async t => {
  const { request, store } = await serve(t);
  const identity = store.identities.create("Fix64 Creator");
  for (let i = 0; i < AGENT_ROOM_CREATE_CAPACITY; i++) {
    const res = await request("/api/agent-rooms", {
      method: "POST", token: identity.secret, data: createArgs(`fix64-room-${i}`)
    });
    assert.ok(res.status === 201 || res.status === 200, `create ${i} got ${res.status}`);
    await res.json();
  }
  const limited = await request("/api/agent-rooms", {
    method: "POST", token: identity.secret, data: createArgs("fix64-room-over")
  });
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assertCanonical429(body, limited.headers, { retryAfterGte: 3600_000 });
  assert.equal(body.detail.limit, AGENT_ROOM_CREATE_CAPACITY);
  assert.equal(body.detail.window, "24h");
  assert.equal(limited.headers.get("ratelimit-limit"), String(AGENT_ROOM_CREATE_CAPACITY));
  assert.equal(limited.headers.get("ratelimit-remaining"), "0");
  assert.notEqual(limited.headers.get("retry-after"), "60", "Retry-After is not the old hardcoded 60");
});

test("GET /api/agent-rooms/budget exposes the caller's budgets", async t => {
  const { request, store } = await serve(t);
  const identity = store.identities.create("Fix64 Budget");

  const fresh = await request("/api/agent-rooms/budget", { token: identity.secret });
  assert.equal(fresh.status, 200);
  const freshBody = await fresh.json();
  assert.equal(freshBody.identityId, identity.identityId);
  assert.deepEqual(freshBody.budgets.roomCreation, {
    limit: AGENT_ROOM_CREATE_CAPACITY, remaining: AGENT_ROOM_CREATE_CAPACITY, window: "24h", resetAt: null
  });
  assert.equal(freshBody.budgets.writes.limit, 60);
  assert.equal(freshBody.budgets.writes.window, "1m");
  assert.equal(typeof freshBody.budgets.writes.remaining, "number");

  for (let i = 0; i < AGENT_ROOM_CREATE_CAPACITY; i++) {
    const res = await request("/api/agent-rooms", {
      method: "POST", token: identity.secret, data: createArgs(`fix64-budget-${i}`)
    });
    await res.json();
  }
  const spent = await request("/api/agent-rooms/budget", { token: identity.secret });
  assert.equal(spent.status, 200);
  const spentBody = await spent.json();
  assert.equal(spentBody.budgets.roomCreation.remaining, 0);
  assert.ok(typeof spentBody.budgets.roomCreation.resetAt === "number"
    && spentBody.budgets.roomCreation.resetAt > Date.now(), "resetAt is a future ms epoch");

  const anon = await request("/api/agent-rooms/budget");
  assert.equal(anon.status, 401);
});

test("200 responses carry RateLimit headers when a limiter ran", async t => {
  const { request, store } = await serve(t);
  const identity = store.identities.create("Fix64 Headers");
  const res = await request("/api/agent-rooms", { token: identity.secret });
  assert.equal(res.status, 200);
  await res.json();
  assert.equal(res.headers.get("ratelimit-limit"), "60");
  assert.equal(res.headers.get("ratelimit-remaining"), "59");
  const reset = Number(res.headers.get("ratelimit-reset"));
  assert.ok(Number.isFinite(reset) && reset >= 0, "RateLimit-Reset present");
});

test("identity-mint minute-tier 429 carries machine-readable detail", t => {
  const directory = mkdtempSync(join(tmpdir(), "room-fix64-mint-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => Date.now() });
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const buckets = { address: "198.51.100.9", network: "203.0.113.0/24" };
  // admitAnonymous only checks the budgets; seed 8 mint rows so the
  // per-address minute tier (8/min) trips on the next admission.
  const now = Date.now();
  const seed = store.db.prepare(`INSERT INTO agent_identities
    (identity_id, secret_hash, display_name, created_at, mint_address, mint_network)
    VALUES(?,?,?,?,?,?)`);
  store.transaction(() => {
    for (let i = 0; i < 8; i++) {
      seed.run(`fix64-mint-${i}`, `hash-${i}`, `Fix64 Mint ${i}`, now - 1000, buckets.address, buckets.network);
    }
  });
  let thrown = null;
  try {
    store.identities.admitAnonymous("Fix64 Mint 9", buckets, null, false, now);
  } catch (error) { thrown = error; }
  assert.ok(thrown, "the 9th mint in a minute is refused");
  assert.equal(thrown.status, 429);
  assert.equal(thrown.code, "rate_limited");
  assert.ok(thrown.detail && typeof thrown.detail === "object", "detail attached to the error");
  assert.equal(thrown.detail.retryAfterMs, 60000);
  assert.equal(thrown.detail.limit, 8);
  assert.equal(thrown.detail.window, "1m");
});
