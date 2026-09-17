// W010: stale procedure detector. Pure detector tests.
import test from "node:test";
import assert from "node:assert/strict";
import { detectStale, StaleError, STALE_DAYS } from "../server/stale-detector.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof StaleError && error.code === code);

test("partitions stale and fresh", () => {
  const result = detectStale({
    now: "2026-09-16T00:00:00Z",
    procedures: [
      { procedureId: "p1", title: "Old", lastUsedAt: "2026-01-01T00:00:00Z", createdAt: "2025-01-01T00:00:00Z" },
      { procedureId: "p2", title: "New", lastUsedAt: "2026-09-10T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" },
      { procedureId: "p3", title: "Never", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
    ],
  });
  assert.equal(result.staleCount, 2);
  assert.equal(result.freshCount, 1);
  assert.equal(result.stale[0].procedureId, "p1"); // stalest first
  assert.equal(result.staleDays, STALE_DAYS);
  assert.ok(Object.isFrozen(result));
});
test("custom threshold", () => {
  const result = detectStale({ now: "2026-09-16T00:00:00Z", staleDays: 7,
    procedures: [{ procedureId: "p1", lastUsedAt: "2026-09-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }] });
  assert.equal(result.staleCount, 1);
});
test("malformed inputs are refused", () => {
  throwsCode(() => detectStale({ procedures: [], now: "nope" }), "invalid_stale");
  throwsCode(() => detectStale({ procedures: "nope", now: "2026-09-16T00:00:00Z" }), "invalid_stale");
});
