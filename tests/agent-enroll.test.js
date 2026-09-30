// Contract tests for the one-call guest enrollment route
// (server/agent-enroll.mjs, POST /api/agents/enroll).
//
// Authoring-gate answers:
// 1. Protects the new public enrollment contract: one call mints an identity
//    (whose credential is NEVER revealed — red-team HIGH RC-2026-09-29-3604),
//    a 24h guest-scoped rak_ key, discovery URLs, and starter tasks; repeats
//    are idempotent (no duplicate identity, no re-issued secrets); the guest
//    key is confined to guest scopes and cannot mint privileged keys; the
//    endpoint is rate-limited and validates input; registered lane names are
//    reserved (409 + alternative); an optional roomId files an access request
//    inline and surfaces an auto-approval as membership.
// 2. Credible regressions: credential leak in the response (the parked
//    HIGH), scope widening on the guest key (privilege escalation), guest
//    token used to mint keys, lane name-squatting, idempotency loss,
//    rate-limit removal (enrollment spam), feed outage failing enrollment.
// 3. No existing coverage: new module, new route. Scope enforcement on the
//    plug-in routes themselves is owned by tests/agent-plugin-http.test.js;
//    here we prove the enroll route only ever issues the guest scope set and
//    that the real route auth honors it.
// 4. No test-only production seams: the deps (enrollments Map, buildFeed,
//    now, rate, accessRequests) are the wiring's own injection points, also
//    used by the production mount. The approved-roomJoin stub implements only
//    the single request() method the module calls; the pending path runs
//    against the real AccessRequests.
//
// Boundary: the REAL RoomStore (SQLite identity minting with hash-only
// secret storage, real rak_ issuance/verification) and the REAL
// createAgentPluginRoutes for the privilege test. Only the http.mjs locals
// (json/reject/body/rate/exact/bearer/pathId) are stubbed, mirroring
// server/http.mjs exactly; the stubs throw on unknown methods.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore, ServiceError } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { accessRequestSchema } from "../server/access-requests.mjs";
import { createAgentEnrollRoutes, ENROLL_GUEST_SCOPES, ENROLL_GUEST_TTL_MS, ENROLL_ROOM_PERMISSIONS, RESERVED_LANE_NAMES } from "../server/agent-enroll.mjs";
import { createAgentPluginRoutes } from "../server/agent-plugin-routes.mjs";

// --- http.mjs locals, mirrored exactly (server/http.mjs) ---
const exact = (value, fields) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const reject = (status, code, message) => { throw new ServiceError(status, code, message); };
const json = (res, status, value) => { res.statusCode = status; res.jsonValue = value; };
const body = req => {
  if (!("parsedBody" in req)) throw new Error("test stub: set req.parsedBody");
  return Promise.resolve(req.parsedBody);
};
const bearer = req => {
  if (!req.headers.authorization) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43}|ga1\.[A-Za-z0-9_-]{43}|pri_[A-Za-z0-9_-]{43,128}|rak_[A-Za-z0-9_-]{16,128})$/.exec(req.headers.authorization);
  if (!match) reject(401, "unauthenticated", "Invalid Authorization header");
  return match[1];
};
const pathId = () => { throw new Error("test stub: pathId unused on these routes"); };

const ORIGIN = "https://room.example.test";
const T0 = 1_800_000_000_000;

const cannedFeed = items => () => ({ generatedAt: new Date(T0).toISOString(), opportunities: items });
const cannedItem = (n, kind = "help-wanted") => kind === "bounty"
  ? { kind, bountyId: `b${n}`, roomId: "room1", roomTitle: "Room One", roomPath: "/?room=room1", title: `Bounty ${n}`, criteria: "do it", amountMillis: 1000, state: "funded", deadlineMs: T0 + 999, createdAt: new Date(T0).toISOString() }
  : { kind, workItemId: `w${n}`, roomId: "room1", roomTitle: "Room One", roomPath: "/?room=room1", title: `Task ${n}`, definitionOfDone: "done", helpScope: "scope", workState: "proposed", openedAt: new Date(T0).toISOString() };

// Harness: real store, controllable clock/feed/rate, strict stubs.
function harness(t, { feedItems = [cannedItem(1), cannedItem(2, "bounty"), cannedItem(3)], rateAllow = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-enroll-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let now = T0;
  const rateCalls = [];
  const deps = {
    store,
    json, reject, body, bearer, exact, pathId,
    origin: ORIGIN,
    now: () => now,
    buildFeed: cannedFeed(feedItems),
    rate: (id, max) => {
      rateCalls.push([id, max]);
      if (rateCalls.length > rateAllow) throw new ServiceError(429, "rate_limited", "Too many requests");
    },
  };
  const handle = createAgentEnrollRoutes(deps);
  const call = (method, path, parsedBody, headers = {}) => {
    const res = {};
    const req = { method, headers, parsedBody };
    const url = new URL(path, "http://127.0.0.1");
    return handle(req, res, { url, remoteAddress: "127.0.0.1" })
      .then(served => ({ served, res }))
      .catch(error => ({ served: true, res, error }));
  };
  const identityCount = () => store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
  return { store, deps, handle, call, rateCalls, identityCount, setNow: v => { now = v; } };
}

test("enroll mints identity + scoped guest key + starter tasks in one call", async t => {
  const h = harness(t);
  const { served, res } = await h.call("POST", "/api/agents/enroll", { name: "Outside Agent" });
  assert.equal(served, true);
  assert.equal(res.statusCode, 201);
  const e = res.jsonValue;
  assert.equal(e.type, "agent_enrollment");
  assert.equal(e.duplicate, false);
  assert.match(e.identityId, /^ai_/);
  // Red-team HIGH (RC-2026-09-29-3604): the identity credential is never
  // revealed — no `credential` field at all, and no pri_ string anywhere in
  // the serialized body. The guest token is the only usable credential.
  assert.ok(!("credential" in e), "no credential field in the response");
  assert.ok(!JSON.stringify(e).includes("pri_"), "no identity credential anywhere in the response");
  assert.match(e.guestToken, /^rak_/);
  assert.deepEqual(e.guestTokenScopes, [...ENROLL_GUEST_SCOPES]);
  assert.equal(e.guestTokenExpiresAt, T0 + ENROLL_GUEST_TTL_MS);
  assert.equal(e.tier, "guest");
  // Starter tasks: machine-readable, three of them, absolute room URLs.
  assert.equal(e.starterTasks.length, 3);
  assert.deepEqual(e.starterTasks.map(s => s.kind), ["help-wanted", "bounty", "help-wanted"]);
  assert.ok(e.starterTasks.every(s => s.roomUrl.startsWith(ORIGIN) && typeof s.title === "string"));
  // Discovery: absolute machine-readable entry points.
  assert.ok(e.discovery.agentCard.startsWith(ORIGIN));
  assert.ok(e.discovery.opportunities.startsWith(ORIGIN));
  assert.equal(e.next.length, 3);
  // The identity secret is stored hash-only, like POST /api/agent-identities —
  // and it is never exposed by this route.
  const row = h.store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(e.identityId);
  assert.ok(row && typeof row.secret_hash === "string" && row.secret_hash.length > 0);
  assert.ok(!row.secret_hash.includes("pri_"));
});

test("second call with the same name is idempotent: no duplicate identity, no re-issued secrets", async t => {
  const h = harness(t);
  const first = await h.call("POST", "/api/agents/enroll", { name: "  Retry Bot " });
  assert.equal(first.res.statusCode, 201);
  assert.equal(h.identityCount(), 1);
  const second = await h.call("POST", "/api/agents/enroll", { name: "retry bot" });
  assert.equal(second.res.statusCode, 200);
  const e = second.res.jsonValue;
  assert.equal(e.duplicate, true);
  assert.equal(e.identityId, first.res.jsonValue.identityId);
  assert.ok(!("credential" in e), "no credential field on duplicates either");
  assert.equal(e.guestToken, null, "guest token is shown once, never re-issued");
  assert.equal(h.identityCount(), 1, "no duplicate identity row");
});

test("same requestId retries the same enrollment without new secrets", async t => {
  const h = harness(t);
  const first = await h.call("POST", "/api/agents/enroll", { name: "Idem Agent", requestId: "req-1", contact: "agent@example.test" });
  assert.equal(first.res.statusCode, 201);
  const retry = await h.call("POST", "/api/agents/enroll", { name: "Idem Agent", requestId: "req-1" });
  assert.equal(retry.res.statusCode, 200);
  assert.equal(retry.res.jsonValue.duplicate, true);
  assert.equal(retry.res.jsonValue.identityId, first.res.jsonValue.identityId);
  assert.ok(!("credential" in retry.res.jsonValue));
  assert.equal(h.identityCount(), 1);
});

test("a different name still mints a fresh identity", async t => {
  const h = harness(t);
  const a = await h.call("POST", "/api/agents/enroll", { name: "Agent A" });
  const b = await h.call("POST", "/api/agents/enroll", { name: "Agent B" });
  assert.equal(a.res.statusCode, 201);
  assert.equal(b.res.statusCode, 201);
  assert.notEqual(a.res.jsonValue.identityId, b.res.jsonValue.identityId);
  assert.equal(h.identityCount(), 2);
});

test("guest token is confined to guest scopes: privileged plug-in routes reject it, guest routes accept it", async t => {
  const h = harness(t);
  const { res } = await h.call("POST", "/api/agents/enroll", { name: "Scoped Guest" });
  const guestToken = res.jsonValue.guestToken;
  // The issued key verifies against the real store with exactly the guest scopes.
  const verified = h.store.agentPlugin.verifyPresentedApiKey(guestToken);
  assert.ok(verified);
  assert.deepEqual([...verified.scopes].sort(), [...ENROLL_GUEST_SCOPES].sort());

  // Real plug-in route auth: privileged route (webhooks:manage) -> 403.
  const plugin = createAgentPluginRoutes({ ...h.deps, rate: () => {} });
  const pluginCall = async (method, path, token, parsedBody) => {
    const pres = {};
    const preq = { method, headers: { authorization: `Bearer ${token}` }, parsedBody };
    try {
      const served = await plugin(preq, pres, { url: new URL(path, "http://127.0.0.1"), remoteAddress: "127.0.0.1" });
      return { served, status: pres.statusCode };
    } catch (error) {
      return { served: true, status: error.status, code: error.code };
    }
  };
  const privileged = await pluginCall("POST", "/api/agent-webhooks", guestToken, { url: "https://example.test/hook", events: ["*"] });
  assert.equal(privileged.status, 403);
  assert.equal(privileged.code, "insufficient_scope");

  // Guest-scoped route (heartbeats:report) passes auth — never a 403.
  // (Body validation may 422; auth is what this test owns.)
  const allowed = await pluginCall("POST", "/api/agent-heartbeats", guestToken, { hostId: "h1", mode: "poll" });
  assert.notEqual(allowed.status, 403, `guest token must clear scope auth on heartbeats:report (got ${allowed.status}/${allowed.code})`);
});

test("rate limit trips: the endpoint rejects with 429 past the budget", async t => {
  const h = harness(t, { rateAllow: 2 });
  assert.equal((await h.call("POST", "/api/agents/enroll", { name: "R1" })).res.statusCode, 201);
  assert.equal((await h.call("POST", "/api/agents/enroll", { name: "R2" })).res.statusCode, 201);
  const third = await h.call("POST", "/api/agents/enroll", { name: "R3" });
  assert.equal(third.error.status, 429);
  assert.equal(third.error.code, "rate_limited");
  // Per-address key, per-minute family — same pattern as the other issuance routes.
  assert.ok(h.rateCalls.every(([id, max]) => id === "agent-enroll:127.0.0.1" && max === 10));
});

test("validation rejects malformed bodies with 422", async t => {
  const h = harness(t);
  const cases = [
    [{}, "missing name"],
    [{ name: "" }, "empty name"],
    [{ name: "   " }, "blank name"],
    [{ name: "x".repeat(81) }, "name too long"],
    [{ name: 42 }, "non-string name"],
    [{ name: "Ok", contact: 42 }, "non-string contact"],
    [{ name: "Ok", contact: "x".repeat(201) }, "contact too long"],
    [{ name: "Ok", requestId: "" }, "empty requestId"],
    [{ name: "Ok", surprise: 1 }, "unknown field"],
  ];
  for (const [payload, label] of cases) {
    const { error } = await h.call("POST", "/api/agents/enroll", payload);
    assert.equal(error?.status, 422, label);
    assert.equal(error?.code, "invalid_enrollment", label);
  }
});

test("wrong method is 405; other paths fall through", async t => {
  const h = harness(t);
  const get = await h.call("GET", "/api/agents/enroll", undefined);
  assert.equal(get.error.status, 405);
  const other = await h.call("POST", "/api/agents/other", { name: "X" });
  assert.equal(other.served, false, "must fall through so http.mjs can route it");
});

test("a feed outage does not fail enrollment", async t => {
  const h = harness(t);
  const handle = createAgentEnrollRoutes({ ...h.deps, buildFeed: () => { throw new Error("feed down"); } });
  const res = {};
  await handle(
    { method: "POST", headers: {}, parsedBody: { name: "Feedless" } },
    res,
    { url: new URL("/api/agents/enroll", "http://127.0.0.1"), remoteAddress: "127.0.0.1" },
  );
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.jsonValue.starterTasks, []);
  assert.ok(res.jsonValue.discovery.opportunities, "the agent can still poll the board itself");
});

test("store-layer failures surface with their status, not a 500", async () => {
  const strictDouble = {
    identities: { create: () => { throw new ServiceError(409, "pilot_limit", "Bounded pilot capacity reached"); } },
    agentPlugin: { issueApiKey: () => { throw new Error("must not be called"); } },
  };
  const handle = createAgentEnrollRoutes({
    store: strictDouble, json, reject, body, exact, origin: ORIGIN, now: () => T0,
    rate: () => {}, buildFeed: cannedFeed([]),
  });
  const res = {};
  let error = null;
  try {
    await handle(
      { method: "POST", headers: {}, parsedBody: { name: "Capped" } },
      res,
      { url: new URL("/api/agents/enroll", "http://127.0.0.1"), remoteAddress: "127.0.0.1" },
    );
  } catch (e) { error = e; }
  assert.equal(error?.status, 409);
  assert.equal(error?.code, "pilot_limit");
});

// --- Red-team HIGH (RC-2026-09-29-3604): no credential in the response ---

test("the guest token cannot mint privileged keys: POST /api/agent-keys rejects it", async t => {
  const h = harness(t);
  const { res } = await h.call("POST", "/api/agents/enroll", { name: "Keyless Guest" });
  const guestToken = res.jsonValue.guestToken;
  // The old response handed over the identity credential (pri_), which could
  // POST /api/agent-keys with arbitrary scopes — minting privileged keys in
  // one call. The guest token must fail that route at auth, not at
  // validation: it is not an identity secret.
  const plugin = createAgentPluginRoutes({ ...h.deps, rate: () => {} });
  const pres = {};
  let error = null;
  try {
    await plugin(
      { method: "POST", headers: { authorization: `Bearer ${guestToken}` },
        parsedBody: { scopes: ["webhooks:manage"], label: "escalation" } },
      pres,
      { url: new URL("/api/agent-keys", "http://127.0.0.1"), remoteAddress: "127.0.0.1" },
    );
  } catch (e) { error = e; }
  assert.ok(error, "expected the key-issuance route to reject the guest token");
  assert.equal(error.status, 403);
  assert.equal(error.code, "insufficient_scope");
  // And no key was minted for the guest identity.
  assert.equal(h.store.agentPlugin.listApiKeys(res.jsonValue.identityId).length, 1);
});

test("reserved lane names are rejected with 409 and an alternative (case-insensitive)", async t => {
  const h = harness(t);
  for (const name of ["quill", "QUILL", "Quill", "Jillian", "JILLIAN", "codex", "quill-s2", "GrokBot", "INSTINCT"]) {
    const { error } = await h.call("POST", "/api/agents/enroll", { name });
    assert.equal(error?.status, 409, name);
    assert.equal(error?.code, "name_reserved", name);
    assert.match(error?.message, /reserved for a registered lane/, name);
    assert.match(error?.message, new RegExp(`${name}-agent`), name);
  }
  assert.equal(h.identityCount(), 0, "no identity minted for reserved names");
  // Near-misses that are not lane names still enroll.
  const ok = await h.call("POST", "/api/agents/enroll", { name: "quilliam" });
  assert.equal(ok.res.statusCode, 201);
});

test("RESERVED_LANE_NAMES stays in sync with lanes/REGISTRY.md", async () => {
  const { readFileSync } = await import("node:fs");
  const registry = readFileSync(new URL("../lanes/REGISTRY.md", import.meta.url), "utf8");
  const lanes = [...registry.matchAll(/^\| ([A-Za-z0-9_-]+) \|/gm)]
    .map(m => m[1]).filter(name => name !== "Lane");
  assert.ok(lanes.length > 0, "expected lane rows in the registry table");
  for (const lane of lanes) {
    assert.ok(RESERVED_LANE_NAMES.some(r => r.toLowerCase() === lane.toLowerCase()),
      `lane "${lane}" from REGISTRY.md must be reserved`);
  }
});

// --- Optional roomId: inline access request ---

function roomHarness(t) {
  const h = harness(t);
  h.store.initialize(initialRoom("commons"));
  h.store.db.exec(accessRequestSchema);
  return h;
}

test("roomId files an access request inline: pending without an auto-approve rule", async t => {
  const h = roomHarness(t);
  const { res } = await h.call("POST", "/api/agents/enroll",
    { name: "Room Joiner", requestId: "enroll-room-1", roomId: "commons" });
  assert.equal(res.statusCode, 201);
  const roomJoin = res.jsonValue.roomJoin;
  assert.ok(roomJoin, "roomJoin present");
  assert.equal(roomJoin.roomId, "commons");
  assert.equal(roomJoin.status, "pending");
  assert.ok(roomJoin.requestId);
  assert.ok(roomJoin.pollPath.includes(roomJoin.requestId));
  // The request row really exists, asking for the guest-worker set.
  const row = h.store.db.prepare("SELECT * FROM access_requests WHERE request_id=?").get(roomJoin.requestId);
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.requested_permissions), [...ENROLL_ROOM_PERMISSIONS]);
  assert.equal(row.status, "pending");
});

test("roomId duplicate enrollment does not file a second access request", async t => {
  const h = roomHarness(t);
  const first = await h.call("POST", "/api/agents/enroll",
    { name: "Room Rejoiner", requestId: "enroll-room-2", roomId: "commons" });
  const second = await h.call("POST", "/api/agents/enroll",
    { name: "Room Rejoiner", requestId: "enroll-room-2", roomId: "commons" });
  assert.equal(second.res.statusCode, 200);
  assert.equal(second.res.jsonValue.roomJoin.requestId, first.res.jsonValue.roomJoin.requestId);
  const n = h.store.db.prepare("SELECT count(*) AS n FROM access_requests").get().n;
  assert.equal(n, 1, "one access request, not two");
});

test("roomId surfaces an auto-approval as membership (approved shape)", async t => {
  const h = harness(t);
  // Narrow double: implements exactly the request() method the module calls,
  // returning the approved shape from the auto-approve slice. The pending
  // path above runs against the real AccessRequests.
  const stubAccessRequests = {
    request: (roomId, opts) => ({
      requestId: opts.requestId,
      roomId,
      identityId: opts.identityId,
      displayName: opts.displayName,
      requestedPermissions: opts.requestedPermissions,
      status: "approved",
      decidedBy: "auto-approve",
      decidedAt: T0,
      memberId: opts.identityId,
      grantedPermissions: [...opts.requestedPermissions],
    }),
  };
  const handle = createAgentEnrollRoutes({ ...h.deps, accessRequests: stubAccessRequests });
  const res = {};
  await handle(
    { method: "POST", headers: {}, parsedBody: { name: "Auto Member", roomId: "commons" } },
    res,
    { url: new URL("/api/agents/enroll", "http://127.0.0.1"), remoteAddress: "127.0.0.1" },
  );
  assert.equal(res.statusCode, 201);
  const roomJoin = res.jsonValue.roomJoin;
  assert.equal(roomJoin.status, "approved");
  assert.equal(roomJoin.memberId, res.jsonValue.identityId);
  assert.deepEqual(roomJoin.grantedPermissions, [...ENROLL_ROOM_PERMISSIONS]);
});

test("roomId for an unknown room is a 404, not a 500", async t => {
  const h = roomHarness(t);
  const { error } = await h.call("POST", "/api/agents/enroll",
    { name: "Lost Joiner", roomId: "no-such-room" });
  assert.equal(error?.status, 404);
});

test("roomId validates like the other optional fields", async t => {
  const h = harness(t);
  for (const [payload, label] of [
    [{ name: "Ok", roomId: 42 }, "non-string roomId"],
    [{ name: "Ok", roomId: "" }, "empty roomId"],
    [{ name: "Ok", roomId: "x".repeat(385) }, "roomId too long"],
    [{ name: "Ok", roomId: "commons", bogus: 1 }, "unknown field alongside roomId"],
  ]) {
    const { error } = await h.call("POST", "/api/agents/enroll", payload);
    assert.equal(error?.status, 422, label);
  }
  // Without roomId the response carries no roomJoin.
  const { res } = await h.call("POST", "/api/agents/enroll", { name: "No Room" });
  assert.equal(res.jsonValue.roomJoin, null);
});

test("H-23: a failing inline room join mints no credential — the shown-once key is never committed-but-undelivered", async t => {
  // Contract: the guest key is issued only after the inline room join
  // succeeds (join-then-commit). Credible regression: the old order issued
  // the shown-once rak_ key first and joined after, so a join failure
  // committed the key but never delivered it — and the idempotent retry
  // returns guestToken: null, losing the credential forever.
  const h = harness(t);
  const failingJoin = createAgentEnrollRoutes({
    ...h.deps,
    accessRequests: { request: () => { throw new ServiceError(500, "join_failed", "room join backend down"); } },
  });
  const keyCount = () => h.store.db.prepare("SELECT count(*) AS n FROM agent_api_keys").get().n;
  const before = keyCount();
  const res = {};
  let error = null;
  try {
    await failingJoin(
      { method: "POST", headers: {}, parsedBody: { name: "Join Fail Bot", roomId: "commons" } },
      res,
      { url: new URL("/api/agents/enroll", "http://127.0.0.1"), remoteAddress: "127.0.0.1" },
    );
  } catch (e) { error = e; }
  assert.ok(error, "the join failure surfaces instead of a 201 with a lost key");
  assert.equal(error.code, "join_failed");
  assert.equal(keyCount(), before, "no API key was committed when the join failed");
  assert.ok(!("statusCode" in res), "no response was sent with an undelivered credential");
});
