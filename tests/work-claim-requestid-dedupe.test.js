// Crash-recovery guild, system #1: requestId idempotency on the mutating
// work-claim routes — claim, review, release, reassign, renew.
//
// Contract under test: a retried POST carrying the same requestId replays the
// original 200 with `duplicate: true` instead of double-applying the
// mutation. Requests without a requestId behave exactly as before.
//
// What this guards: after a crash or a lost response, a client retries the
// same mutation. Without dedupe the retry double-applies (renew extends the
// lease twice, release 500s/422s on an already-released claim, reassign and
// claim 409/422 on the moved claim, a verdict review recommits). The dedupe
// store is installed on the store object (`store.requestDedupe`) by server
// init (B5 wiring); routes null-guard it for backward compatibility. The
// in-memory store here implements the server/request-dedupe.mjs contract
// the same way the production wiring will install it.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { readRequestId, createDedupeStore } from "../server/request-dedupe.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const H = 3600 * 1000;

const fakeHelpers = () => {
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return { json: (res, status, value) => ({ status, value }), reject, body: async req => req.body };
};

// Room members: quill (board writer) owns the claim under test; grok holds
// the verify profile so it may record verdict reviews and attestations.
const makeStore = ({ withDedupe = true, messages = [] } = {}) => {
  const db = new DatabaseSync(":memory:");
  // The route path enforces the autonomy tier through store.db; the table
  // is empty here, so members run at the default tier (production boot
  // installs the same schema).
  ensureAutonomyTiersSchema(db);
  const store = {
    db,
    roomAuthority: () => ({ ownerId: null, members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
      grok: { id: "grok", kind: "agent", active: true, permissions: ["verify"] },
    } }),
    // The archived-room state makes emitWorkClaimEvent's isRoomArchived
    // early-exit skip the event journal (same as the db-less fakes in
    // lease-renewal.test.js); the claim registry write still commits.
    room: () => ({ sequence: 1, state: { messages, room: { archivedAt: "2026-01-01T00:00:00.000Z" } } }),
  };
  if (withDedupe) store.requestDedupe = createDedupeStore(db);
  return store;
};

const runRoute = async ({ route, id, body = {}, memberId = "quill", registry, store }) => {
  const helpers = fakeHelpers();
  try {
    const out = await handleWorkClaims({ req: { method: "POST", body }, res: {},
      url: {}, store, roomId: "room1", auth: { member: { id: memberId, kind: "agent", permissions: [] } },
      workClaimRoute: route, workClaimId: id, helpers, registry });
    return { out, error: null };
  } catch (error) {
    return { out: null, error };
  }
};

const freshUnclaimed = async ({ withDedupe = true } = {}) => {
  const store = makeStore({ withDedupe });
  const registry = createWorkClaimRegistry();
  const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry, store });
  assert.equal(created.error, null);
  return { store, registry };
};

const freshClaimed = async ({ withDedupe = true, claimBody = { leaseHours: 6 } } = {}) => {
  const { store, registry } = await freshUnclaimed({ withDedupe });
  const claimed = await runRoute({ route: "claim", id: "w1", body: claimBody, registry, store });
  assert.equal(claimed.error, null);
  return { store, registry };
};

// Sends the same mutating POST twice with one requestId. The second call
// must replay the first result with duplicate:true and the registry state
// must be identical before and after the retry (mutation applied once).
const retryOnce = async ({ route, id, body, memberId = "quill", signature, setup }) => {
  const { store, registry } = await setup();
  const first = await runRoute({ route, id, body: { ...body, requestId: "req-1" }, memberId, registry, store });
  assert.equal(first.error, null, `first ${route} should succeed`);
  assert.equal(first.out.status, 200);
  assert.equal(first.out.value.duplicate, undefined, "first call is not a duplicate");
  const afterFirst = signature(registry.get("room1", id));
  const second = await runRoute({ route, id, body: { ...body, requestId: "req-1" }, memberId, registry, store });
  assert.equal(second.error, null, `retried ${route} should replay, not fail`);
  assert.equal(second.out.status, 200);
  assert.equal(second.out.value.duplicate, true, `retried ${route} must be marked duplicate`);
  const { duplicate: _dropped, ...replayed } = second.out.value;
  assert.deepEqual(replayed, first.out.value, `retried ${route} replays the original result`);
  assert.deepEqual(signature(registry.get("room1", id)), afterFirst, `${route} applied exactly once`);
  return { store, registry, first: first.out.value };
};

// --- the store contract the routes depend on (B1's module must satisfy this) ---

test("readRequestId: only a 1..128-char string survives, never throws", () => {
  assert.equal(readRequestId({ requestId: "abc-123" }), "abc-123");
  assert.equal(readRequestId({}), null);
  assert.equal(readRequestId(null), null);
  assert.equal(readRequestId(undefined), null);
  assert.equal(readRequestId({ requestId: 42 }), null);
  assert.equal(readRequestId({ requestId: "" }), null);
  assert.equal(readRequestId({ requestId: "x".repeat(129) }), null);
  const max = "x".repeat(128);
  assert.equal(readRequestId({ requestId: max }), max);
});

test("dedupe store: first check misses, record replays, TTL prunes", () => {
  const db = new DatabaseSync(":memory:");
  const store = createDedupeStore(db, { ttlMs: 1000 });
  assert.deepEqual(store.check("k1"), { duplicate: false });
  store.record("k1", { ok: true });
  assert.deepEqual(store.check("k1"), { duplicate: true, result: { ok: true } });
  const deleted = store.prune(Date.now() + 2000);
  assert.equal(deleted, 1);
  assert.deepEqual(store.check("k1"), { duplicate: false });
});

// --- one idempotency test per mutating route ---

test("claim: a retried claim with the same requestId replays instead of 409ing", async () => {
  await retryOnce({
    route: "claim", id: "w1", body: {},
    setup: () => freshUnclaimed(),
    signature: item => [item.state, item.owner, item.history.length],
  });
});

test("review verdict: a retried verdict with the same requestId replays instead of recommitting", async () => {
  await retryOnce({
    route: "review", id: "w1", memberId: "grok",
    body: { verdict: "approve", summary: "looks good" },
    setup: () => freshClaimed(),
    signature: item => [item.reviews.length, item.history.length],
  });
});

test("review attestation: a retried note with the same requestId replays instead of re-attesting", async () => {
  await retryOnce({
    route: "review", id: "w1", memberId: "grok",
    body: { note: "a review note" },
    setup: () => freshClaimed(),
    signature: item => [item.attestations.length, item.history.length],
  });
});

test("release: a retried release with the same requestId replays instead of failing", async () => {
  await retryOnce({
    route: "release", id: "w1", body: { reason: "done here" },
    setup: () => freshClaimed(),
    signature: item => [item.state, item.owner, item.history.length],
  });
});

test("reassign: a retried reassign with the same requestId replays instead of failing", async () => {
  await retryOnce({
    route: "reassign", id: "w1", body: { newOwner: "grok" },
    setup: () => freshClaimed(),
    signature: item => [item.owner, item.history.length],
  });
});

test("renew: a retried renew with the same requestId replays instead of extending twice", async () => {
  const { first } = await retryOnce({
    route: "renew", id: "w1", body: {},
    setup: () => freshClaimed({ claimBody: { leaseHours: 0.5 } }),
    signature: item => [item.leaseExpiresAt, item.leaseStartAt, item.history.length],
  });
  // The renew footgun stays fixed under idempotency: an empty renew keeps
  // the claim's own short window, never the room's 24h default.
  assert.equal(Date.parse(first.leaseExpiresAt) - Date.parse(first.leaseStartAt), 0.5 * H);
});

// --- backward compatibility: no requestId changes nothing ---

test("no requestId: repeated renews keep extending (unchanged behavior)", async () => {
  const { store, registry } = await freshClaimed();
  const first = await runRoute({ route: "renew", id: "w1", body: {}, registry, store });
  assert.equal(first.error, null);
  const second = await runRoute({ route: "renew", id: "w1", body: {}, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, undefined);
  const item = registry.get("room1", "w1");
  assert.equal(item.history.filter(entry => entry.action === "renewed").length, 2);
});

test("no requestId: a second claim still 409s (unchanged behavior)", async () => {
  const { store, registry } = await freshUnclaimed();
  const first = await runRoute({ route: "claim", id: "w1", body: {}, registry, store });
  assert.equal(first.error, null);
  const second = await runRoute({ route: "claim", id: "w1", body: {}, registry, store });
  assert.ok(second.error, "second claim without requestId must fail as before");
  assert.equal(second.error.status, 409);
});

test("no requestId: a second release still fails (unchanged behavior)", async () => {
  const { store, registry } = await freshClaimed();
  const first = await runRoute({ route: "release", id: "w1", body: { reason: "x" }, registry, store });
  assert.equal(first.error, null);
  const second = await runRoute({ route: "release", id: "w1", body: { reason: "x" }, registry, store });
  assert.ok(second.error, "second release without requestId must fail as before");
  assert.equal(second.out, null);
});

test("no requestId: a second reassign by the former owner still fails (unchanged behavior)", async () => {
  const { store, registry } = await freshClaimed();
  const first = await runRoute({ route: "reassign", id: "w1", body: { newOwner: "grok" }, registry, store });
  assert.equal(first.error, null);
  const second = await runRoute({ route: "reassign", id: "w1", body: { newOwner: "grok" }, registry, store });
  assert.ok(second.error, "second reassign without requestId must fail as before");
});

test("no requestId: a repeated verdict review stays a natural no-op without the duplicate flag (unchanged behavior)", async () => {
  const { store, registry } = await freshClaimed();
  const body = { verdict: "approve", summary: "looks good" };
  const first = await runRoute({ route: "review", id: "w1", body, memberId: "grok", registry, store });
  assert.equal(first.error, null);
  const historyAfterFirst = registry.get("room1", "w1").history.length;
  const second = await runRoute({ route: "review", id: "w1", body, memberId: "grok", registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, undefined);
  assert.equal(registry.get("room1", "w1").history.length, historyAfterFirst);
});

// The routes must not consult the dedupe store when it is absent (B5 has
// not wired it yet): identical behavior to the pre-idempotency code.
test("no dedupe store installed: requestId is ignored, behavior unchanged", async () => {
  const { store, registry } = await freshClaimed({ withDedupe: false });
  const first = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-1" }, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.duplicate, undefined);
  const second = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-1" }, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, undefined);
  assert.equal(registry.get("room1", "w1").history.filter(entry => entry.action === "renewed").length, 2);
});
