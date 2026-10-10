import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeClaimHistory } from "../server/work-claims.mjs";
import { mirrorProjectionClaim } from "../server/work-claim-mirror.mjs";

test("summarizeClaimHistory refuses a negative or fractional keep", () => {
  const item = { id: "x", history: Array.from({ length: 10 }, (_, i) => ({ i })) };
  assert.throws(() => summarizeClaimHistory(item, -1), RangeError);
  assert.throws(() => summarizeClaimHistory(item, 1.5), RangeError);
  const once = summarizeClaimHistory(item, 3);
  assert.equal(once.history.length, 3);
  assert.equal(once.historyOmitted, 7);
  assert.deepEqual(summarizeClaimHistory(once, 3), once, "summarizing twice is a no-op");
});

test("work.superseded without a successor id writes nothing", () => {
  const writes = [];
  const store = { workClaims: { get: () => null, set: (...a) => writes.push(a), list: () => [] } };
  const out = mirrorProjectionClaim(store, "r1", "ai_actor", {
    type: "work.superseded", at: "2026-10-10T00:00:00.000Z", data: { workItemId: "task-a" }
  });
  assert.equal(out, null);
  assert.equal(writes.length, 0, "no phantom workitem claim");
});
