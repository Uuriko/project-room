// G018: historical event import/backfill. Pure tool tests.
import test from "node:test";
import assert from "node:assert/strict";
import { prepareBackfill, BackfillError } from "../server/backfill.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof BackfillError && error.code === code);

test("validates, deduplicates, and normalizes", () => {
  const result = prepareBackfill({ events: [
    { type: "message", roomId: "r1", timestamp: "2026-09-01T10:00:00Z", userId: "ada" },
    { type: "message", roomId: "r1", timestamp: "2026-09-01T10:00:00Z", userId: "ada" }, // duplicate
    { type: "message", roomId: "r1", timestamp: "invalid" }, // invalid
    { type: "join", roomId: "r2", timestamp: "2026-09-02T10:00:00+00:00", userId: "bob" },
  ]});
  assert.equal(result.validCount, 2);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 1);
  assert.ok(result.valid[0].timestamp.endsWith("Z"));
  assert.ok(Object.isFrozen(result));
});
test("malformed inputs are refused", () => {
  throwsCode(() => prepareBackfill({ events: "nope" }), "invalid_backfill");
});
