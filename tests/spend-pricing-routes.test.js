// Transport boundary for the spend-pricing routes (RES-0144):
// GET /api/rooms/{roomId}/spend-pricing, POST /api/rooms/{roomId}/spend-pricing
// (server/routes/spend-pricing.mjs).
//
// These routes build credentials via roomCredentials, which falls back to
// ambient cookie-carried tokens when no Authorization header is present.
// Every sibling room route runs the full guard chain before the handler
// (roomAuth, no Bearer account sessions, no non-session cookie credentials,
// API-key scope, protectWrite CSRF/Origin, rate limit); the spend-pricing
// routes skipped all of it, so a read-only API key could flip room pricing,
// a cross-site cookie POST could flip it without Origin/CSRF, and writes
// were never rate-limited (wave-4 lane C-12, executed: read-only rak_ write
// 201; cookie no-Origin/no-CSRF write 201 vs 403 control; 40/40 burst, no
// 429). The store-layer pricing rules live in tests/spend-pricing.test.js
// and are never re-asserted here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { ensureSpendGrantsSchema } from "../server/spend-grants.mjs";
import { readSpendPricing } from "../server/spend-pricing.mjs";
import { getSpendPricing, setSpendPricingRoute } from "../server/routes/spend-pricing.mjs";

// --- Handler-level boundary (fake ctx, mirroring tests/spend-grant-routes) ---

// The store stub records reachability and stops there: the guard chain must
// run before any store path is entered, and a passing chain is proven by the
// sentinel, not by re-testing the store layer. Both pricing module entry
// points open with store.readTransaction, so one sentinel covers both.
function fakeCtx({ bearer = false, authExtra = {}, protectWriteError = null } = {}) {
  const rated = [];
  const protectedWrites = [];
  let storeReached = false;
  const reject = (status, code, message) => { const e = new Error(message); e.status = status; e.code = code; throw e; };
  const reach = () => {
    storeReached = true;
    const e = new Error("store reached"); e.code = "store_reached"; throw e;
  };
  return {
    rated,
    protectedWrites,
    storeReached: () => storeReached,
    req: { method: "POST", headers: {} },
    res: {},
    url: new URL("https://room.example/api/rooms/commons/spend-pricing"),
    params: { roomId: "commons" },
    roomCredentials: () => ({ token: "tok", bearer, mode: "room" }),
    expectedBinding: () => null,
    accountBinding: () => { throw new Error("not account mode"); },
    roomAuth: () => ({ member: { id: "owner" }, credentialHash: "hash-owner", kind: "session", credentialScope: "room", ...authExtra }),
    protectWrite: (req, auth, isBearer) => { protectedWrites.push(isBearer); if (protectWriteError) throw protectWriteError; },
    rate: (key, max) => { rated.push([key, max]); },
    body: async () => ({ enabled: false }),
    json: (_res, status, value) => ({ status, value }),
    reject,
    store: { readTransaction: reach, command: reach },
  };
}

const errOf = async fn => {
  try { await fn(); } catch (error) { return error; }
  throw new Error("expected the handler to throw");
};

test("set: cookie writes go through protectWrite and the write rate bucket before the store", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => setSpendPricingRoute(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, [false]);
  assert.deepEqual(ctx.rated, [["write:hash-owner", 60]]);
});

test("set: a CSRF/Origin refusal from protectWrite stops the write before the store", async () => {
  const csrf = new Error("Origin header is required"); csrf.status = 403; csrf.code = "origin_denied";
  const ctx = fakeCtx({ protectWriteError: csrf });
  const err = await errOf(() => setSpendPricingRoute(ctx));
  assert.equal(err.status, 403);
  assert.equal(err.code, "origin_denied");
  assert.equal(ctx.storeReached(), false, "no pricing mutation path entered");
});

test("set: a bearer account session (not a room credential) is refused", async () => {
  const ctx = fakeCtx({ bearer: true, authExtra: { credentialScope: "account-session" } });
  const err = await errOf(() => setSpendPricingRoute(ctx));
  assert.equal(err.status, 403);
  assert.equal(err.code, "access_denied");
  assert.equal(ctx.storeReached(), false);
});

test("set: a non-session credential carried by cookie is refused", async () => {
  const ctx = fakeCtx({ authExtra: { kind: "access" } });
  const err = await errOf(() => setSpendPricingRoute(ctx));
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthenticated");
  assert.equal(ctx.storeReached(), false);
});

test("set: API keys need rooms:write; a room bearer with it still works", async () => {
  const readOnly = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:read"] } });
  const err = await errOf(() => setSpendPricingRoute(readOnly));
  assert.equal(err.status, 403);
  assert.equal(err.code, "insufficient_scope");
  assert.equal(readOnly.storeReached(), false);

  const keyed = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  const ok = await errOf(() => setSpendPricingRoute(keyed));
  assert.equal(ok.code, "store_reached");
  assert.deepEqual(keyed.protectedWrites, [true]);
  assert.deepEqual(keyed.rated, [["write:hash-owner", 60]]);
});

test("read: rate-limited on the read bucket, no write chain, scope gate applies", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => getSpendPricing(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, []);
  assert.deepEqual(ctx.rated, [["read:hash-owner", 600]]);

  const bearerAccount = fakeCtx({ bearer: true, authExtra: { credentialScope: "account-session" } });
  const refused = await errOf(() => getSpendPricing(bearerAccount));
  assert.equal(refused.status, 403);
  assert.equal(bearerAccount.storeReached(), false);

  const writeOnlyKey = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  const scoped = await errOf(() => getSpendPricing(writeOnlyKey));
  assert.equal(scoped.status, 403);
  assert.equal(scoped.code, "insufficient_scope");

  const readKey = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:read"] } });
  const ok = await errOf(() => getSpendPricing(readKey));
  assert.equal(ok.code, "store_reached");
});

// --- End-to-end over HTTP with the real protectWrite ---

async function boot(t, prepare) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-pricing-routes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const fixture = prepare(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, ...fixture, origin: `http://127.0.0.1:${server.address().port}` };
}

// The bootstrap commons owner is a human member: it can hold a browser
// session (createSession refuses non-human access keys).
function serveCommons(t) {
  return boot(t, store => {
    const ownerKey = store.issueAccessKey("commons", "owner");
    const session = store.createSession(ownerKey);
    return { roomId: "commons", ownerKey, session };
  });
}

// An AgentRooms room is owned by an identity: it can hold rak_ API keys.
function serveAgentRoom(t) {
  return boot(t, store => {
    const rooms = new AgentRooms(store, {
      rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
    });
    const owner = store.identities.create("Owen");
    const created = rooms.create(owner.secret, { title: "Pricing room", purpose: "Guard chain", displayName: "Owner" });
    return { roomId: created.roomId, ownerSecret: owner.secret };
  });
}

const postPricing = (origin, roomId, headers, enabled) => fetch(`${origin}/api/rooms/${roomId}/spend-pricing`, {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ enabled }),
});

test("HTTP: a cross-site cookie POST cannot flip pricing, a confirmed browser POST can", async t => {
  const { store, roomId, ownerKey, session, origin } = await serveCommons(t);
  const cookie = `room_session=${session.token}`;
  // Ambient cookie only: no Origin, no CSRF token — the classic CSRF shape.
  const attack = await postPricing(origin, roomId, { cookie }, false);
  assert.equal(attack.status, 403, `cookie-only write must be refused, got ${attack.status}`);
  assert.equal((await attack.json()).error.code, "origin_denied");
  assert.equal(readSpendPricing(store, ownerKey, roomId).enabled, true, "the refused request flipped nothing");

  const legit = await postPricing(origin, roomId, { cookie, origin, "x-csrf-token": session.session.csrf }, false);
  assert.equal(legit.status, 201, `confirmed browser write must work, got ${legit.status}: ${await legit.clone().text()}`);
  await legit.text();
  assert.equal(readSpendPricing(store, ownerKey, roomId).enabled, false);

  // The bearer owner access key needs no CSRF confirmation.
  const bearer = await postPricing(origin, roomId, { authorization: `Bearer ${ownerKey}` }, true);
  assert.equal(bearer.status, 201, `bearer owner write must keep working, got ${bearer.status}`);
  await bearer.text();
  assert.equal(readSpendPricing(store, ownerKey, roomId).enabled, true);
});

test("HTTP: a read-only API key cannot write pricing; a write key can; the owner bearer still can", async t => {
  const { store, roomId, ownerSecret, origin } = await serveAgentRoom(t);
  const issueKey = async scopes => {
    const res = await fetch(`${origin}/api/agent-keys`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerSecret}`, "content-type": "application/json" },
      body: JSON.stringify({ scopes, label: "res-0144" }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).credential;
  };
  const readKey = await issueKey(["rooms:read"]);
  const denied = await postPricing(origin, roomId, { authorization: `Bearer ${readKey}` }, false);
  assert.equal(denied.status, 403, `read-only key write must be refused, got ${denied.status}`);
  assert.equal((await denied.json()).error.code, "insufficient_scope");
  assert.equal(readSpendPricing(store, ownerSecret, roomId).enabled, true, "the refused key flipped nothing");

  // The same read key may still read the pricing state.
  const read = await fetch(`${origin}/api/rooms/${roomId}/spend-pricing`, {
    headers: { authorization: `Bearer ${readKey}` },
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).enabled, true);

  const writeKey = await issueKey(["rooms:write"]);
  const keyed = await postPricing(origin, roomId, { authorization: `Bearer ${writeKey}` }, false);
  assert.equal(keyed.status, 201, `write-scoped key must work, got ${keyed.status}: ${await keyed.clone().text()}`);
  await keyed.text();
  assert.equal(readSpendPricing(store, ownerSecret, roomId).enabled, false);

  const bearer = await postPricing(origin, roomId, { authorization: `Bearer ${ownerSecret}` }, true);
  assert.equal(bearer.status, 201, `owner identity bearer must keep working, got ${bearer.status}`);
  await bearer.text();
  assert.equal(readSpendPricing(store, ownerSecret, roomId).enabled, true);
});

test("HTTP: pricing writes are rate-limited per credential", async t => {
  const { roomId, ownerKey, origin } = await serveCommons(t);
  // A fresh credential (the commons owner access key, unused so far in this
  // fixture): the shared write bucket bursts at 40 (http.mjs
  // CREDENTIAL_WRITE_BURST) and refills at 1/s, so a 45-write burst inside a
  // second-scale window must see a 429. Before the fix this route never
  // touched the bucket: 40/40 answered 201.
  const statuses = [];
  for (let i = 0; i < 45; i++) {
    const r = await postPricing(origin, roomId, { authorization: `Bearer ${ownerKey}` }, i % 2 === 0);
    statuses.push(r.status);
    await r.text();
  }
  assert.equal(statuses[0], 201, "the first write succeeds");
  assert.ok(statuses.includes(429), `burst must hit the write rate bucket, got ${JSON.stringify(statuses)}`);
});
