// G020: analytics retention. Pure policy tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRetention, RetentionError } from "../server/retention.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RetentionError && error.code === code);

test("isExpired respects per-category windows", () => {
  const retention = createRetention({ policies: { events: 30, aggregates: 365 } });
  const now = "2026-09-16T00:00:00Z";
  assert.equal(retention.isExpired({ category: "events", timestamp: "2026-08-01T00:00:00Z" }, { now }), true);
  assert.equal(retention.isExpired({ category: "events", timestamp: "2026-09-10T00:00:00Z" }, { now }), false);
  assert.equal(retention.isExpired({ category: "aggregates", timestamp: "2026-08-01T00:00:00Z" }, { now }), false);
});
test("purgePlan partitions keep/purge", () => {
  const retention = createRetention({ policies: { events: 30 } });
  const now = "2026-09-16T00:00:00Z";
  const records = [
    { category: "events", timestamp: "2026-08-01T00:00:00Z", id: "old" },
    { category: "events", timestamp: "2026-09-10T00:00:00Z", id: "new" },
  ];
  const plan = retention.purgePlan({ records, now });
  assert.equal(plan.purgeCount, 1);
  assert.equal(plan.keepCount, 1);
  assert.equal(plan.purge[0].id, "old");
  assert.ok(Object.isFrozen(plan));
});
test("malformed inputs are refused", () => {
  throwsCode(() => createRetention({ policies: { events: 0 } }), "invalid_retention");
  const retention = createRetention({ policies: { events: 30 } });
  throwsCode(() => retention.isExpired({ category: "unknown", timestamp: "2026-09-10T00:00:00Z" }, { now: "2026-09-16T00:00:00Z" }), "invalid_retention");
});
