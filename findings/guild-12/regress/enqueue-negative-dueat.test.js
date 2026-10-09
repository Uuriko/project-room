// Guild-12 fail-first regression for fuzz finding F7 (wake-queue.mjs enqueue).
//
// FINDING: enqueue() accepts a negative dueAt (e.g. -5). The validation
// block requires a safe integer and rejects dueAt beyond now+horizon, but
// sets no lower bound — so a meaningless "due in 1969" wake is recorded and
// is immediately due. Every other field is validated strictly (exact field
// set, safe integers, 1<=maxAttempts<=5, intentBytes cap); the missing lower
// bound on dueAt is an oversight.
//
// FAIL-FIRST: on current code this test FAILS (enqueue succeeds). With a
// lower-bound check it PASSES.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.at = () => at;
  return f;
}

test("enqueue rejects non-positive dueAt", t => {
  const f = fixture(t);
  const q = f.store.wakeQueue, k = f.keys.owner;
  for (const dueAt of [-5, -1, 0]) {
    assert.throws(
      () => q.enqueue(k, "commons", { requestId: randomUUID(), queueKey: "neg-" + dueAt, intent: { x: 1 }, dueAt, maxAttempts: 3 }),
      err => err.code === "invalid_wake" || err.code === "invalid_wake_time",
      `dueAt=${dueAt} must be rejected`);
  }
  assert.equal(q.list(k, "commons").wakes.length, 0, "rejected enqueues record nothing");
});
