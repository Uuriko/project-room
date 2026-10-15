// Transport boundary for the spend-grant routes (#2955):
// POST /api/rooms/{roomId}/spend-grants, DELETE .../spend-grants/{agentId},
// GET /api/rooms/{roomId}/spend-grant (server/routes/spend-grants.mjs).
//
// These routes build credentials via roomCredentials, which falls back to
// ambient cookie-carried tokens when no Authorization header is present.
// Every sibling room write route runs the full write chain before mutating
// (roomAuth, no Bearer account sessions, no non-session cookie credentials,
// API-key scope, protectWrite CSRF/Origin, rate limit); the spend-grant
// routes skipped all of it, so a cross-site cookie POST could mint money.
// The store-layer grant rules live in tests/spend-grants.test.js and are
// never re-asserted here.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";
import { ensureSpendGrantsSchema } from "../server/spend-grants.mjs";
import { issueSpendGrant, revokeSpendGrant, readOwnSpendGrant } from "../server/routes/spend-grants.mjs";

// --- Handler-level boundary (fake ctx, mirroring tests/typing-routes) ---

// The store stub records reachability and stops there: the guard chain must
// run before any store mutation path is entered, and a passing chain is
// proven by the sentinel, not by re-testing the store layer.
function fakeCtx({ bearer = false, authExtra = {}, protectWriteError = null, body = { agentId: "peer", capCents: "1000", perTxCapCents: "100" } } = {}) {
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
    url: new URL("https://room.example/api/rooms/commons/spend-grants"),
    params: { roomId: "commons", agentId: "peer" },
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

test("issue: cookie writes go through protectWrite and the write rate bucket before the store", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => issueSpendGrant(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, [false]);
  assert.deepEqual(ctx.rated, [["write:hash-owner", 60]]);
});

test("issue: a CSRF/Origin refusal from protectWrite stops the grant before the store", async () => {
  const csrf = new Error("Origin header is required"); csrf.status = 403; csrf.code = "origin_denied";
  const ctx = fakeCtx({ protectWriteError: csrf });
  const err = await errOf(() => issueSpendGrant(ctx));
  assert.equal(err.status, 403);
  assert.equal(err.code, "origin_denied");
  assert.equal(ctx.storeReached(), false, "no grant mutation path entered");
});

test("issue: a bearer account session (not a room credential) is refused", async () => {
  const ctx = fakeCtx({ bearer: true, authExtra: { credentialScope: "account-session" } });
  const err = await errOf(() => issueSpendGrant(ctx));
  assert.equal(err.status, 403);
  assert.equal(err.code, "access_denied");
  assert.equal(ctx.storeReached(), false);
});

test("issue: a non-session credential carried by cookie is refused", async () => {
  const ctx = fakeCtx({ authExtra: { kind: "access" } });
  const err = await errOf(() => issueSpendGrant(ctx));
  assert.equal(err.status, 401);
  assert.equal(err.code, "unauthenticated");
  assert.equal(ctx.storeReached(), false);
});

test("issue: API keys need rooms:write; a room bearer with it still works", async () => {
  const readOnly = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:read"] } });
  const err = await errOf(() => issueSpendGrant(readOnly));
  assert.equal(err.status, 403);
  assert.equal(err.code, "insufficient_scope");
  assert.equal(readOnly.storeReached(), false);

  const keyed = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  const ok = await errOf(() => issueSpendGrant(keyed));
  assert.equal(ok.code, "store_reached");
  assert.deepEqual(keyed.protectedWrites, [true]);
  assert.deepEqual(keyed.rated, [["write:hash-owner", 60]]);
});

test("revoke: the DELETE takes the same write chain before the store", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => revokeSpendGrant(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, [false]);
  assert.deepEqual(ctx.rated, [["write:hash-owner", 60]]);

  const csrf = new Error("Session confirmation required"); csrf.status = 403; csrf.code = "csrf_denied";
  const refusedCtx = fakeCtx({ protectWriteError: csrf });
  const refused = await errOf(() => revokeSpendGrant(refusedCtx));
  assert.equal(refused.status, 403);
  assert.equal(refusedCtx.storeReached(), false, "no revoke mutation path entered");
});

test("read: rate-limited on the read bucket, no write chain, bearer account sessions refused", async () => {
  const ctx = fakeCtx();
  const err = await errOf(() => readOwnSpendGrant(ctx));
  assert.equal(err.code, "store_reached");
  assert.deepEqual(ctx.protectedWrites, []);
  assert.deepEqual(ctx.rated, [["read:hash-owner", 600]]);

  const bearerAccount = fakeCtx({ bearer: true, authExtra: { credentialScope: "account-session" } });
  const refused = await errOf(() => readOwnSpendGrant(bearerAccount));
  assert.equal(refused.status, 403);
  assert.equal(bearerAccount.storeReached(), false);

  const readOnlyKey = fakeCtx({ bearer: true, authExtra: { kind: "api-key", apiKeyScopes: ["rooms:write"] } });
  const scoped = await errOf(() => readOwnSpendGrant(readOnlyKey));
  assert.equal(scoped.status, 403);
  assert.equal(scoped.code, "insufficient_scope");
});

// --- End-to-end over HTTP with the real protectWrite ---

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-spend-grant-routes-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  ensureSpendGrantsSchema(store.db);
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", {
    id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "peer", displayName: "Peer agent", kind: "agent", permissions: [] },
  });
  setTier(store.db, "commons", "peer", "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  const session = store.createSession(ownerKey);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, ownerKey, session, origin: `http://127.0.0.1:${server.address().port}` };
}

const GRANT_BODY = JSON.stringify({ agentId: "peer", capCents: "1000", perTxCapCents: "100" });
const grantTerms = store => store.db.prepare("SELECT count(*) AS n FROM spend_grant_terms WHERE room_id='commons' AND agent_id='peer'").get().n;

test("HTTP: a cross-site cookie POST cannot issue a spend grant, a confirmed browser POST can", async t => {
  const { store, session, origin } = await serve(t);
  const cookie = `room_session=${session.token}`;
  // Ambient cookie only: no Origin, no CSRF token — the classic CSRF shape.
  const attack = await fetch(`${origin}/api/rooms/commons/spend-grants`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: GRANT_BODY,
  });
  assert.equal(attack.status, 403, `cookie-only issue must be refused, got ${attack.status}`);
  await attack.text();
  assert.equal(grantTerms(store), 0, "the refused request minted no grant");

  const legit = await fetch(`${origin}/api/rooms/commons/spend-grants`, {
    method: "POST",
    headers: { cookie, origin, "x-csrf-token": session.session.csrf, "content-type": "application/json" },
    body: GRANT_BODY,
  });
  assert.equal(legit.status, 201, `confirmed browser issue must work, got ${legit.status}: ${await legit.clone().text()}`);
  await legit.text();
  assert.equal(grantTerms(store), 1);
});

test("HTTP: a cookie DELETE cannot revoke without CSRF confirmation; a bearer owner key needs none", async t => {
  const { store, ownerKey, session, origin } = await serve(t);
  const issued = await fetch(`${origin}/api/rooms/commons/spend-grants`, {
    method: "POST",
    headers: { authorization: `Bearer ${ownerKey}`, "content-type": "application/json" },
    body: GRANT_BODY,
  });
  assert.equal(issued.status, 201, `bearer issue must work, got ${issued.status}: ${await issued.clone().text()}`);
  await issued.text();
  assert.equal(grantTerms(store), 1);

  const cookie = `room_session=${session.token}`;
  const attack = await fetch(`${origin}/api/rooms/commons/spend-grants/peer`, {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(attack.status, 403, `cookie-only revoke must be refused, got ${attack.status}`);
  await attack.text();

  // If the refused DELETE had revoked anyway, this confirmed revoke would
  // report revoked:false (revoke is idempotent) instead of revoked:true.
  const legit = await fetch(`${origin}/api/rooms/commons/spend-grants/peer`, {
    method: "DELETE",
    headers: { cookie, origin, "x-csrf-token": session.session.csrf },
  });
  assert.equal(legit.status, 200);
  assert.equal((await legit.json()).revoked, true);
});

test("HTTP: the caller's own spend summary still reads back over a browser session", async t => {
  const { session, origin } = await serve(t);
  const res = await fetch(`${origin}/api/rooms/commons/spend-grant`, {
    headers: { cookie: `room_session=${session.token}` },
  });
  assert.equal(res.status, 200);
  const value = await res.json();
  assert.equal(value.memberId, "owner");
  assert.equal(value.spend, null, "grant-less members are withheld, never refused");
});
