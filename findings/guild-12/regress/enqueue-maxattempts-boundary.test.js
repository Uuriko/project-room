// Guild-12 fail-first regression for mutant M06 (wake-queue.mjs enqueue).
//
// FINDING: no test enqueues with maxAttempts exactly equal to the legal
// maximum (wakeQueueLimits.maxAttempts = 5). The M06 mutant (>= instead of
// >) silently rejects the legal boundary value and passes the suite.
//
// FAIL-FIRST: on current code PASSES; with the M06 mutant FAILS.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";
import { wakeQueueLimits } from "../../../server/wake-queue.mjs";

test("enqueue accepts maxAttempts at exactly the legal maximum", t => {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); });
  const r = f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "boundary", intent: { x: 1 }, dueAt: Date.now(), maxAttempts: wakeQueueLimits.maxAttempts });
  assert.equal(r.receipt.state, "pending");
  assert.equal(r.receipt.coalesced, false);
  assert.throws(() => f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "over", intent: { x: 1 }, dueAt: Date.now(), maxAttempts: wakeQueueLimits.maxAttempts + 1 }),
    err => err.code === "invalid_wake", "one above the max is still rejected");
});
