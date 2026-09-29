// Contract tests for the one-call guest enrollment route
// (server/agent-enroll.mjs, POST /api/agents/enroll).
//
// Authoring-gate answers:
// 1. Protects the new public enrollment contract: one call mints an identity
//    (credential shown once), a 24h guest-scoped rak_ key, discovery URLs,
//    and starter tasks; repeats are idempotent (no duplicate identity, no
//    re-issued secrets); the guest key is confined to guest scopes; the
//    endpoint is rate-limited and validates input.
// 2. Credible regressions: scope widening on the guest key (privilege
//    escalation), idempotency loss (duplicate identities/secrets on retry),
//    secret re-display on duplicate, rate-limit removal (enrollment spam),
//    feed outage failing enrollment.
// 3. No existing coverage: new module, new route. Scope enforcement on the
//    plug-in routes themselves is owned by tests/agent-plugin-http.test.js;
//    here we prove the enroll route only ever issues the guest scope set and
//    that the real route auth honors it.
// 4. No test-only production seams: the deps (enrollments Map, buildFeed,
//    now, rate) are the wiring's own injection points, also used by the
//    production mount.
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
import { createAgentEnrollRoutes, ENROLL_GUEST_SCOPES, ENROLL_GUEST_TTL_MS } from "../server/agent-enroll.mjs";
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
  assert.match(e.credential, /^pri_/);
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
  // The identity secret is stored hash-only, like POST /api/agent-identities.
  const row = h.store.db.prepare("SELECT secret_hash FROM agent_identities WHERE identity_id=?").get(e.identityId);
  assert.ok(row && !row.secret_hash.includes(e.credential.slice(4, 12)));
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
  assert.equal(e.credential, null, "credential is shown once, never re-issued");
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
  assert.equal(retry.res.jsonValue.credential, null);
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
