// FIX-57: server-side per-op timeouts with deterministic outcomes.
//
// Contract under test:
// - Each mutating work-claim op (create/claim/update/renew/release) runs
//   under a bounded server-side deadline (env-tunable, 10s default).
// - Every response for these ops carries an explicit `outcome`:
//   "applied" (this call applied the mutation),
//   "already-applied-idempotent" (a retry replaying the recorded outcome), or
//   "not-applied" (the deadline fired before any outcome was recorded —
//   safe to re-drive with the same requestId).
// - A timed-out op re-driven with the same requestId returns the recorded
//   outcome instead of double-applying. Never "hung, unknown".
//
// What this guards: AQ-HI-03 — a 136s release retry with unknown
// server-side outcome. Without the journal, the retry cannot tell whether
// the first attempt applied (phantom-write hazard for loss audits).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkClaimRegistry, handleWorkClaims } from "../server/work-claim-routes.mjs";
import { readRequestId, createDedupeStore } from "../server/request-dedupe.mjs";
import {
  withOpDeadline, opTimeoutMs, OpTimeoutError,
  OP_TIMEOUT_OPS, DEFAULT_OP_TIMEOUT_MS, MAX_OP_TIMEOUT_MS,
} from "../server/op-timeout.mjs";
import { ensureAutonomyTiersSchema } from "../server/autonomy-tiers.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const fakeHelpers = () => {
  const reject = (status, code, message) => {
    const error = new Error(message); error.status = status; error.code = code; throw error;
  };
  return { json: (res, status, value) => ({ status, value }), reject, body: async req => req.body };
};

// quill (board writer) owns the claim under test.
const makeStore = ({ withDedupe = true } = {}) => {
  const db = new DatabaseSync(":memory:");
  ensureAutonomyTiersSchema(db);
  const store = {
    db,
    roomAuthority: () => ({ ownerId: null, members: {
      quill: { id: "quill", kind: "agent", active: true, permissions: ["accept_work", "complete_work"] },
    } }),
    // Archived-room state makes emitWorkClaimEvent's isRoomArchived early
    // exit skip the event journal; the claim registry write still commits.
    room: () => ({ sequence: 1, state: { messages: [], room: { archivedAt: "2026-01-01T00:00:00.000Z" } } }),
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

const freshUnclaimed = async ({ withDedupe = true, registry } = {}) => {
  const store = makeStore({ withDedupe });
  const reg = registry ?? createWorkClaimRegistry();
  const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry: reg, store });
  assert.equal(created.error, null);
  return { store, registry: reg };
};

const freshClaimed = async ({ withDedupe = true, claimBody = { leaseHours: 6 }, registry } = {}) => {
  const { store, registry: reg } = await freshUnclaimed({ withDedupe, registry });
  const claimed = await runRoute({ route: "claim", id: "w1", body: claimBody, registry: reg, store });
  assert.equal(claimed.error, null);
  return { store, registry: reg };
};

// The injected stall: this registry's transaction waits `ms` before running
// the real work, so the server-side deadline fires while the op is in flight.
const stallingRegistry = (registry, ms) => Object.assign(Object.create(registry), {
  transaction: async fn => { await sleep(ms); return registry.transaction ? registry.transaction(fn) : fn(); },
});

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key]; else process.env[key] = vars[key];
  }
  try { return await fn(); }
  finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
};

const stripOutcome = value => {
  const { outcome: _o, duplicate: _d, ...rest } = value;
  return rest;
};

// --- op-timeout module unit tests ---

test("OP_TIMEOUT_OPS covers exactly the five mutating ops", () => {
  assert.deepEqual([...OP_TIMEOUT_OPS].sort(), ["claim", "create", "release", "renew", "update"]);
  assert.equal(DEFAULT_OP_TIMEOUT_MS, 10_000);
});

test("opTimeoutMs: 10s default, env-tunable per op and globally", async () => {
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_MS: undefined, WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: undefined,
    WORK_CLAIM_OP_TIMEOUT_RELEASE_MS: undefined }, () => {
    for (const op of OP_TIMEOUT_OPS) assert.equal(opTimeoutMs(op), 10_000);
  });
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_MS: "2500" }, () => {
    assert.equal(opTimeoutMs("claim"), 2500);
    assert.equal(opTimeoutMs("release"), 2500);
  });
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_MS: "2500", WORK_CLAIM_OP_TIMEOUT_RELEASE_MS: "7000" }, () => {
    assert.equal(opTimeoutMs("release"), 7000, "per-op wins over global");
    assert.equal(opTimeoutMs("claim"), 2500);
  });
  for (const bad of ["nope", "-5", "0", ""]) {
    await withEnv({ WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: bad }, () => {
      assert.equal(opTimeoutMs("claim"), 10_000, `invalid ${JSON.stringify(bad)} falls back to default`);
    });
  }
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: "999999999" }, () => {
    assert.equal(opTimeoutMs("claim"), MAX_OP_TIMEOUT_MS, "absurd values clamp to the max");
  });
  assert.throws(() => opTimeoutMs("bogus"), /unknown op/);
});

test("withOpDeadline: fast ops resolve with value and elapsedMs", async () => {
  const { value, elapsedMs } = await withOpDeadline("claim", () => 42, { timeoutMs: 1000 });
  assert.equal(value, 42);
  assert.ok(elapsedMs >= 0 && elapsedMs < 1000);
});

test("withOpDeadline: a stalled op rejects with OpTimeoutError", async () => {
  await assert.rejects(
    withOpDeadline("release", () => sleep(5000), { timeoutMs: 30 }),
    err => err instanceof OpTimeoutError && err.code === "op_timeout"
      && err.op === "release" && err.timeoutMs === 30 && err.elapsedMs >= 30,
  );
});

test("withOpDeadline: a sync throw passes through untouched (not a timeout)", async () => {
  const boom = Object.assign(new Error("nope"), { status: 409 });
  await assert.rejects(withOpDeadline("claim", () => { throw boom; }, { timeoutMs: 1000 }), /nope/);
});

// --- route-level: deterministic outcomes ---

test("claim: an op stalled past the deadline returns 504 op_timeout, outcome not-applied", async () => {
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: "50" }, async () => {
    const store = makeStore();
    const registry = stallingRegistry(createWorkClaimRegistry(), 400);
    const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry, store });
    assert.equal(created.error, null);
    const out = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-stall-1" }, registry, store });
    assert.equal(out.error, null);
    assert.equal(out.out.status, 504);
    const v = out.out.value;
    assert.equal(v.error.code, "op_timeout");
    assert.equal(v.outcome, "not-applied");
    assert.equal(v.retryable, true);
    assert.equal(v.requestId, "req-stall-1");
    assert.equal(v.op, "claim");
    assert.equal(v.deterministicRetry, true);
  });
});

test("retry after a timeout: same requestId replays already-applied-idempotent, never double-applies", async () => {
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: "50" }, async () => {
    const store = makeStore();
    const base = createWorkClaimRegistry();
    const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry: base, store });
    assert.equal(created.error, null);
    const stalled = stallingRegistry(base, 400);
    const timedOut = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-stall-2" }, registry: stalled, store });
    assert.equal(timedOut.out.status, 504, "the stalled first attempt times out");
    await sleep(700); // let the stalled attempt finish and journal its outcome
    const retry = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-stall-2" }, registry: base, store });
    assert.equal(retry.error, null);
    assert.equal(retry.out.status, 200);
    assert.equal(retry.out.value.duplicate, true);
    assert.equal(retry.out.value.outcome, "already-applied-idempotent");
    const item = base.get("room1", "w1");
    assert.equal(item.state, "claimed");
    assert.equal(item.history.filter(entry => entry.action === "claimed").length, 1,
      "the claim applied exactly once — no phantom write");
  });
});

test("claim: normal op records outcome applied; immediate retry replays without re-applying", async () => {
  const { store, registry } = await freshUnclaimed();
  const first = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-claim-1" }, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.status, 200);
  assert.equal(first.out.value.outcome, "applied");
  assert.equal(first.out.value.duplicate, undefined);
  const before = registry.get("room1", "w1").history.length;
  const second = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-claim-1" }, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.status, 200);
  assert.equal(second.out.value.duplicate, true);
  assert.equal(second.out.value.outcome, "already-applied-idempotent");
  assert.deepEqual(stripOutcome(second.out.value), stripOutcome(first.out.value), "replay returns the recorded outcome");
  assert.equal(registry.get("room1", "w1").history.length, before, "no double-apply");
});

test("create: a retried create with the same requestId replays instead of 409ing", async () => {
  const store = makeStore();
  const registry = createWorkClaimRegistry();
  const body = { id: "w2", title: "t", requestId: "req-create-1" };
  const first = await runRoute({ route: "create", body, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.status, 201);
  assert.equal(first.out.value.outcome, "applied");
  const second = await runRoute({ route: "create", body, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.status, 200);
  assert.equal(second.out.value.duplicate, true);
  assert.equal(second.out.value.outcome, "already-applied-idempotent");
  assert.equal(registry.list("room1").filter(item => item.id === "w2").length, 1);
});

test("update: a retried update with the same requestId replays instead of double-applying", async () => {
  const { store, registry } = await freshClaimed();
  const body = { state: "in_progress", note: "working", requestId: "req-update-1" };
  const first = await runRoute({ route: "update", id: "w1", body, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.outcome, "applied");
  const before = registry.get("room1", "w1").history.length;
  const second = await runRoute({ route: "update", id: "w1", body, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, true);
  assert.equal(second.out.value.outcome, "already-applied-idempotent");
  assert.deepEqual(stripOutcome(second.out.value), stripOutcome(first.out.value));
  assert.equal(registry.get("room1", "w1").history.length, before, "no double-apply");
});

test("renew: a retried renew with the same requestId replays instead of extending twice", async () => {
  const { store, registry } = await freshClaimed({ claimBody: { leaseHours: 0.5 } });
  const first = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-renew-1" }, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.outcome, "applied");
  const leaseAfterFirst = registry.get("room1", "w1").leaseExpiresAt;
  const second = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-renew-1" }, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, true);
  assert.equal(second.out.value.outcome, "already-applied-idempotent");
  assert.equal(registry.get("room1", "w1").leaseExpiresAt, leaseAfterFirst, "lease extended exactly once");
});

test("release: a retried release with the same requestId replays instead of failing", async () => {
  const { store, registry } = await freshClaimed();
  const item = registry.get("room1", "w1");
  const body = { expectedClaimedAt: item.claimedAt, expectedHistoryLength: item.history.length,
    reason: "done here", requestId: "req-release-1" };
  const first = await runRoute({ route: "release", id: "w1", body, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.outcome, "applied");
  assert.equal(first.out.value.state, "unclaimed");
  const second = await runRoute({ route: "release", id: "w1", body, registry, store });
  assert.equal(second.error, null, "retried release replays instead of 409ing on the released claim");
  assert.equal(second.out.value.duplicate, true);
  assert.equal(second.out.value.outcome, "already-applied-idempotent");
  assert.deepEqual(stripOutcome(second.out.value), stripOutcome(first.out.value));
});

// --- backward compatibility ---

test("no requestId: behavior unchanged, outcome still reported as applied", async () => {
  const { store, registry } = await freshUnclaimed();
  const first = await runRoute({ route: "claim", id: "w1", body: {}, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.outcome, "applied");
  assert.equal(first.out.value.duplicate, undefined);
  const second = await runRoute({ route: "claim", id: "w1", body: {}, registry, store });
  assert.ok(second.error, "second claim without requestId still 409s as before");
  assert.equal(second.error.status, 409);
});

test("no dedupe store installed: requestId is ignored, behavior unchanged, no crash", async () => {
  const { store, registry } = await freshClaimed({ withDedupe: false });
  const first = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-1" }, registry, store });
  assert.equal(first.error, null);
  assert.equal(first.out.value.outcome, "applied");
  assert.equal(first.out.value.duplicate, undefined);
  const second = await runRoute({ route: "renew", id: "w1", body: { requestId: "req-1" }, registry, store });
  assert.equal(second.error, null);
  assert.equal(second.out.value.duplicate, undefined);
});

test("no dedupe store: a timed-out op still answers 504, flagged non-deterministic", async () => {
  await withEnv({ WORK_CLAIM_OP_TIMEOUT_CLAIM_MS: "50" }, async () => {
    const store = makeStore({ withDedupe: false });
    const registry = stallingRegistry(createWorkClaimRegistry(), 400);
    const created = await runRoute({ route: "create", id: "w1", body: { id: "w1", title: "t" }, registry, store });
    assert.equal(created.error, null);
    const out = await runRoute({ route: "claim", id: "w1", body: { requestId: "req-stall-3" }, registry, store });
    assert.equal(out.out.status, 504);
    assert.equal(out.out.value.outcome, "not-applied");
    assert.equal(out.out.value.deterministicRetry, false);
  });
});

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
