// Transport boundary for the spend-pricing routes (BACKLOG-BURN-1 / C6,
// hunt-2026-10-18 adversary.md P6):
// GET + POST /api/rooms/{roomId}/spend-pricing (server/routes/spend-pricing.mjs).
//
// These routes build credentials via roomCredentials, which falls back to
// ambient cookie-carried tokens when no Authorization header is present.
// Every sibling room route runs the standard chain before touching the
// store (roomAuth dispatch, no Bearer account sessions, no non-session
// cookie credentials, API-key scope, protectWrite CSRF/Origin for writes,
// shared rate buckets); the spend-pricing routes skipped all of it, so a
// cross-site cookie POST could flip the room's priced-tool kill switch
// with only the store's owner check in the way. The store-layer rules
// (owner-only, strict shape) live in tests/spend-pricing.test.js and are
// never re-asserted here.
//
// Credential-kind decision for API keys (explicit, C6): a scoped rak_ key
// may use these routes only at the sibling scope (rooms:read to read,
// rooms:write to write) AND only as its bound identity — the store's
// owner check then binds writes to keys whose identity is the room
// owner member. A key bound to any other member is refused
// owner_required by the store, exactly like that member's own secret.

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
import { setTier } from "../server/autonomy-tiers.mjs";
import { getSpendPricing, setSpendPricingRoute } from "../server/routes/spend-pricing.mjs";

// --- Handler-level boundary (fake ctx, mirroring tests/spend-grant-routes) ---

// The store stub records reachability and stops there: the guard chain must
// run before any store path is entered, and a passing chain is proven by
// the sentinel, not by re-testing the store layer.
function fakeCtx({ bearer = false, authExtra = {}, protectWriteError = null, body = { enabled: false } } = {}) {
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
    body: async () => body,
    json: (_res, status, value) => ({ status, value }),
    reject,
    store: { transaction: reach, readTransaction: reach },
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

test("set: API keys need rooms:write; a key with it passes the chain as its bound identity", async () => {
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

test("get: rate-limited on the read bucket, no write chain, API keys need rooms:read", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => getSpendPricing(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, []);
  assert.deepEqual(ctx.rated, [["read:hash-owner", 600]]);

  const writeOnlyKey = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  const scoped = await errOf(() => getSpendPricing(writeOnlyKey));
  assert.equal(scoped.status, 403);
  assert.equal(scoped.code, "insufficient_scope");
  assert.equal(writeOnlyKey.storeReached(), false);
});

// --- End-to-end over HTTP with the real protectWrite ---

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-pricing-routes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  ensureSpendGrantsSchema(store.db);
  const rooms = new AgentRooms(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });
  const owner = store.identities.create("Owen");
  const peer = store.identities.create("Peer agent");
  const created = rooms.create(owner.secret, { title: "Pricing room", purpose: "Kill switch", displayName: "Owner" });
  const roomId = created.roomId;
  const ownerMemberId = created.ownerMemberId ?? owner.identityId;
  const invite = store.invites.create(owner.secret, roomId, { profile: "chat", displayName: "Peer agent" }, null);
  const joined = store.invites.redeem(invite.code, { displayName: "Peer agent", identitySecret: peer.secret });
  const peerMemberId = joined.memberId ?? joined.member?.id;
  assert.ok(peerMemberId, "peer member id missing from redeem response");
  setTier(store.db, roomId, peerMemberId, "t2_standard", { updatedBy: ownerMemberId, nowMs: Date.now() });
  // The owner member here is an agent identity, so its browser session is a
  // join session; authenticate() exposes the same csrf the server checks.
  const joinSession = store.createJoinSession(roomId, ownerMemberId);
  const session = { token: joinSession.token, session: store.authenticate(joinSession.token, roomId) };
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({
      store, roomId, session,
      ownerIdentityId: owner.identityId, peerIdentityId: peer.identityId,
      origin: `http://127.0.0.1:${server.address().port}`,
    });
  }));
}

test("HTTP: a cross-site cookie POST cannot flip pricing; a confirmed browser POST can", async t => {
  const { store, roomId, session, origin } = await serve(t);
  const path = `${origin}/api/rooms/${roomId}/spend-pricing`;
  const cookie = `room_session=${session.token}`;
  // Ambient cookie only: no Origin, no CSRF token — the classic CSRF shape.
  const attack = await fetch(path, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(attack.status, 403, `cookie-only write must be refused, got ${attack.status}`);
  await attack.text();

  const legit = await fetch(path, {
    method: "POST",
    headers: { cookie, origin, "x-csrf-token": session.session.csrf, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(legit.status, 201, `confirmed browser write must work, got ${legit.status}: ${await legit.clone().text()}`);
  await legit.text();
  const state = store.room(roomId).state;
  assert.equal(state.room.spendPricing?.enabled, false, "the confirmed write committed");
});

test("HTTP: API keys are scope-gated at the route and owner-bound at the store", async t => {
  const { store, roomId, origin, ownerIdentityId, peerIdentityId } = await serve(t);
  const path = `${origin}/api/rooms/${roomId}/spend-pricing`;
  const post = token => fetch(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });

  // A read-scoped key bound to the owner never reaches the store.
  const readKey = store.agentPlugin.issueApiKey({ identityId: ownerIdentityId, scopes: ["rooms:read"] });
  const scoped = await post(`rak_${readKey.secret}`);
  assert.equal(scoped.status, 403, `read-scoped key write must be refused, got ${scoped.status}`);
  assert.equal((await scoped.json()).error.code, "insufficient_scope");
  assert.equal(store.room(roomId).state.room.spendPricing ?? null, null, "the refused key write committed nothing");

  // A write-scoped key bound to a non-owner member passes the route chain
  // and is refused by the store's owner check — the key acts only as its
  // bound identity.
  const peerKey = store.agentPlugin.issueApiKey({ identityId: peerIdentityId, scopes: ["rooms:write"] });
  const peered = await post(`rak_${peerKey.secret}`);
  assert.equal(peered.status, 403, `non-owner key write must be refused, got ${peered.status}`);
  assert.equal((await peered.json()).error.code, "owner_required");
  assert.equal(store.room(roomId).state.room.spendPricing ?? null, null, "the refused peer-key write committed nothing");

  // A write-scoped key bound to the owner member flips the switch.
  const ownerKey = store.agentPlugin.issueApiKey({ identityId: ownerIdentityId, scopes: ["rooms:write"] });
  const owned = await post(`rak_${ownerKey.secret}`);
  assert.equal(owned.status, 201, `owner key write must work, got ${owned.status}: ${await owned.clone().text()}`);
  await owned.text();
  assert.equal(store.room(roomId).state.room.spendPricing?.enabled, false, "the owner key write committed");
});
