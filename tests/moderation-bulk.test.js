// F013: moderation queue bulk actions tests.
//
// Pure unit tests with an in-memory fake store and a recording audit sink:
// per-action behavior (approve/reject/escalate), failure isolation,
// idempotency, validation errors, and the F004/F020-style audit entries.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  ACTIONABLE_STATUSES,
  ACTION_APPROVE,
  ACTION_ESCALATE,
  ACTION_REJECT,
  LIMITS,
  TRANSITIONS,
  BulkActionError,
  bulkAction,
  validateBulkAction
} from "../src/moderation-bulk.mjs";
import { STATUSES } from "../src/abuse-reporting.mjs";

const START = 1_757_000_000_000; // fixed injectable clock (ms)
const ACTOR = { id: "mod-1", role: "moderator" };

const item = (id, status = STATUSES.submitted) => ({ id, status });

// Fake store honoring the injected interface: applyAction performs the
// F014 lifecycle transition for the action and throws on demand.
const fakeStore = (failOn = new Set()) => {
  const applied = [];
  return {
    applied,
    applyAction(itemId, action, ctx) {
      applied.push([itemId, action, ctx]);
      if (failOn.has(itemId)) throw new Error(`boom on ${itemId}`);
      return { id: itemId, status: TRANSITIONS[action].to };
    }
  };
};

const harness = (opts = {}) => {
  const audits = [];
  return {
    audits,
    run: (items, action, extra = {}) =>
      bulkAction(items, action, {
        actor: ACTOR,
        store: fakeStore(),
        idempotencyKey: "key-1",
        audit: (entry) => audits.push(entry),
        now: () => START,
        id: () => "audit-1",
        idempotency: new Map(),
        ...extra
      })
  };
};

test("module reuses the F014 lifecycle vocabulary", () => {
  assert.deepEqual([...ACTIONABLE_STATUSES].sort(), [STATUSES.submitted, STATUSES.triaged].sort());
  assert.equal(TRANSITIONS[ACTION_APPROVE].to, STATUSES.actioned);
  assert.equal(TRANSITIONS[ACTION_REJECT].to, STATUSES.dismissed);
  assert.equal(TRANSITIONS[ACTION_ESCALATE].to, STATUSES.triaged);
  assert.deepEqual(ACTIONS, [ACTION_APPROVE, ACTION_REJECT, ACTION_ESCALATE]);
});

test("approve applies across every item and returns a summary", () => {
  const store = fakeStore();
  const items = [item("a"), item("b", STATUSES.triaged), item("c")];
  const summary = bulkAction(items, ACTION_APPROVE, {
    actor: ACTOR,
    store,
    idempotencyKey: "approve-1",
    now: () => START
  });
  assert.equal(summary.action, ACTION_APPROVE);
  assert.equal(summary.idempotencyKey, "approve-1");
  assert.equal(summary.actorId, ACTOR.id);
  assert.equal(summary.total, 3);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 0);
  assert.equal(summary.at, new Date(START).toISOString());
  assert.deepEqual(store.applied.map(([id, action]) => [id, action]), [
    ["a", ACTION_APPROVE],
    ["b", ACTION_APPROVE],
    ["c", ACTION_APPROVE]
  ]);
  for (const result of summary.results) {
    assert.equal(result.ok, true);
    assert.equal(result.to, STATUSES.actioned);
    assert.ok([STATUSES.submitted, STATUSES.triaged].includes(result.from));
  }
});

test("reject closes items as dismissed", () => {
  const { run } = harness();
  const summary = run([item("a"), item("b")], ACTION_REJECT);
  assert.equal(summary.succeeded, 2);
  assert.ok(summary.results.every((r) => r.ok && r.to === STATUSES.dismissed));
});

test("escalate moves submitted items to triaged", () => {
  const { run } = harness();
  const summary = run([item("a")], ACTION_ESCALATE);
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.results[0].from, STATUSES.submitted);
  assert.equal(summary.results[0].to, STATUSES.triaged);
});

test("non-actionable items fail per-item without aborting the batch", () => {
  const store = fakeStore();
  const items = [item("good"), item("done", STATUSES.actioned), item("gone", STATUSES.dismissed)];
  const summary = bulkAction(items, ACTION_APPROVE, {
    actor: ACTOR,
    store,
    idempotencyKey: "isolation-1",
    now: () => START
  });
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 2);
  assert.deepEqual(store.applied.map(([id]) => id), ["good"]);
  const [ok, bad1, bad2] = summary.results;
  assert.equal(ok.ok, true);
  for (const bad of [bad1, bad2]) {
    assert.equal(bad.ok, false);
    assert.equal(bad.code, "not_actionable");
  }
});

test("a store throw is isolated to that item", () => {
  const store = fakeStore(new Set(["bad"]));
  const summary = bulkAction([item("ok"), item("bad")], ACTION_REJECT, {
    actor: ACTOR,
    store,
    idempotencyKey: "throw-1",
    now: () => START
  });
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.failed, 1);
  const failed = summary.results.find((r) => r.itemId === "bad");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "apply_failed");
  assert.match(failed.message, /boom on bad/);
  assert.equal(failed.from, STATUSES.submitted);
  const good = summary.results.find((r) => r.itemId === "ok");
  assert.equal(good.ok, true);
  assert.equal(good.to, STATUSES.dismissed);
});

test("repeated idempotency key returns the original summary without re-applying", () => {
  const store = fakeStore();
  const audits = [];
  const idempotency = new Map();
  const options = {
    actor: ACTOR,
    store,
    idempotencyKey: "same-key",
    audit: (entry) => audits.push(entry),
    now: () => START,
    idempotency
  };
  const first = bulkAction([item("a")], ACTION_APPROVE, options);
  const second = bulkAction([item("a")], ACTION_APPROVE, options);
  assert.equal(second, first); // same stored object
  assert.equal(store.applied.length, 1);
  assert.equal(audits.length, 1);
});

test("different idempotency keys re-apply", () => {
  const store = fakeStore();
  const idempotency = new Map();
  const base = { actor: ACTOR, store, audit: () => {}, now: () => START, idempotency };
  bulkAction([item("a")], ACTION_APPROVE, { ...base, idempotencyKey: "k1" });
  bulkAction([item("a")], ACTION_APPROVE, { ...base, idempotencyKey: "k2" });
  assert.equal(store.applied.length, 2);
});

test("audit entry follows the F004/F020 event shape", () => {
  const { audits, run } = harness();
  const summary = run([item("a"), item("b")], ACTION_ESCALATE, {
    actor: { id: "owner-9", role: "owner" },
    idempotencyKey: "audit-9"
  });
  assert.equal(audits.length, 1);
  const entry = audits[0];
  assert.equal(entry.id, "audit-1");
  assert.equal(entry.type, "moderation.bulk_escalate");
  assert.equal(entry.actorId, "owner-9");
  assert.equal(entry.at, new Date(START).toISOString());
  assert.equal(entry.data.action, ACTION_ESCALATE);
  assert.deepEqual(entry.data.itemIds, ["a", "b"]);
  assert.equal(entry.data.succeeded, summary.succeeded);
  assert.equal(entry.data.failed, summary.failed);
  assert.equal(entry.data.idempotencyKey, "audit-9");
});

test("no audit entry is emitted on an idempotent replay", () => {
  const audits = [];
  const store = fakeStore();
  const idempotency = new Map();
  const base = {
    actor: ACTOR,
    store,
    audit: (entry) => audits.push(entry),
    now: () => START,
    idempotency
  };
  bulkAction([item("a")], ACTION_APPROVE, { ...base, idempotencyKey: "k" });
  bulkAction([item("a")], ACTION_APPROVE, { ...base, idempotencyKey: "k" });
  assert.equal(audits.length, 1);
});

test("validateBulkAction rejects empty sets, unknown actions, and bad actors", () => {
  assert.deepEqual(
    validateBulkAction([], ACTION_APPROVE, ACTOR).map((e) => e.code),
    ["empty_batch"]
  );
  assert.deepEqual(
    validateBulkAction("nope", ACTION_APPROVE, ACTOR).map((e) => e.code),
    ["empty_batch"]
  );
  assert.ok(
    validateBulkAction([item("a")], "nuke", ACTOR).some((e) => e.code === "unknown_action")
  );
  assert.ok(
    validateBulkAction([item("a")], ACTION_APPROVE, { id: "m", role: "member" })
      .some((e) => e.code === "forbidden_actor")
  );
  assert.ok(
    validateBulkAction([item("a")], ACTION_APPROVE, "mod-1").some((e) => e.code === "invalid_actor")
  );
  assert.ok(
    validateBulkAction([item("a")], ACTION_APPROVE, { id: "!!", role: "owner" })
      .some((e) => e.code === "invalid_actor")
  );
});

test("validateBulkAction flags non-actionable and duplicate items as typed errors", () => {
  const errors = validateBulkAction(
    [item("a"), item("b", STATUSES.actioned), item("a")],
    ACTION_APPROVE,
    ACTOR
  );
  assert.ok(errors.some((e) => e.code === "not_actionable" && e.itemId === "b"));
  assert.ok(errors.some((e) => e.code === "duplicate_item"));
});

test("validateBulkAction returns [] for a valid batch", () => {
  assert.deepEqual(
    validateBulkAction([item("a"), item("b", STATUSES.triaged)], ACTION_REJECT, ACTOR),
    []
  );
});

test("bulkAction throws BulkActionError on batch-level validation failures", () => {
  const { run } = harness();
  assert.throws(
    () => run([], ACTION_APPROVE, { idempotencyKey: "x1" }),
    (err) =>
      err instanceof BulkActionError &&
      err.code === "invalid_batch" &&
      err.errors.some((e) => e.code === "empty_batch")
  );
  assert.throws(
    () => run([item("a")], "zap", { idempotencyKey: "x2" }),
    (err) => err instanceof BulkActionError && err.errors.some((e) => e.code === "unknown_action")
  );
  assert.throws(
    () => run([item("a"), item("a")], ACTION_APPROVE, { idempotencyKey: "x3" }),
    (err) => err instanceof BulkActionError && err.errors.some((e) => e.code === "duplicate_item")
  );
  assert.throws(
    () =>
      run([item("a")], ACTION_APPROVE, {
        actor: { id: "m", role: "member" },
        idempotencyKey: "x4"
      }),
    (err) => err instanceof BulkActionError && err.errors.some((e) => e.code === "forbidden_actor")
  );
});

test("bulkAction throws typed errors for a missing idempotency key or store", () => {
  const { run } = harness();
  assert.throws(
    () => run([item("a")], ACTION_APPROVE, { idempotencyKey: "" }),
    (err) => err instanceof BulkActionError && err.code === "invalid_idempotency_key"
  );
  assert.throws(
    () => run([item("a")], ACTION_APPROVE, { store: {}, idempotencyKey: "x5" }),
    (err) => err instanceof BulkActionError && err.code === "invalid_store"
  );
});

test("batch over the limit is rejected", () => {
  const items = Array.from({ length: LIMITS.maxBatch + 1 }, (_, i) => item(`i-${i}`));
  assert.ok(
    validateBulkAction(items, ACTION_APPROVE, ACTOR).some((e) => e.code === "batch_too_large")
  );
  assert.throws(
    () => harness().run(items, ACTION_APPROVE, { idempotencyKey: "x6" }),
    (err) => err instanceof BulkActionError && err.errors.some((e) => e.code === "batch_too_large")
  );
});
