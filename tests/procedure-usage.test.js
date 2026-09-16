// W011: procedure usage analytics. Pure aggregator tests.
import test from "node:test";
import assert from "node:assert/strict";
import { usageAnalytics, UsageError } from "../server/procedure-usage.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof UsageError && error.code === code);

test("aggregates usage stats", () => {
  const stats = usageAnalytics({ events: [
    { procedureId: "p1", userId: "ada", timestamp: "2026-09-16T10:00:00Z", success: true },
    { procedureId: "p1", userId: "bob", timestamp: "2026-09-16T11:00:00Z", success: false },
    { procedureId: "p1", userId: "ada", timestamp: "2026-09-16T12:00:00Z", success: true },
    { procedureId: "p2", userId: "ada", timestamp: "2026-09-16T10:00:00Z", success: true },
  ]});
  assert.equal(stats.length, 2);
  assert.equal(stats[0].procedureId, "p1"); // most used first
  assert.equal(stats[0].uses, 3);
  assert.equal(stats[0].uniqueUsers, 2);
  assert.equal(stats[0].successRate, 0.67);
  assert.equal(stats[0].lastUsedAt, "2026-09-16T12:00:00Z");
  assert.ok(Object.isFrozen(stats));
});
test("malformed inputs are refused", () => {
  throwsCode(() => usageAnalytics({ events: "nope" }), "invalid_usage");
  throwsCode(() => usageAnalytics({ events: [{ procedureId: "", timestamp: "2026-09-16T10:00:00Z" }] }),
    "invalid_usage");
});
