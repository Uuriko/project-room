// Guild-12 fail-first regression for mutant M14 (wake-queue-limits.mjs).
//
// FINDING: no test pins the backoff value (wakeQueueLimits.baseBackoffMs).
// The M14 mutant (60000 -> 6000) passes the suite — the existing test only
// asserts relative ordering (not due immediately after fail, due after one
// backoff elapses), so a 10x smaller backoff is invisible.
//
// FAIL-FIRST: on current code PASSES; with the M14 mutant FAILS.
//
// NOTE: the 30000 below is a literal on purpose — it must NOT be read from
// wakeQueueLimits.baseBackoffMs, or the test adapts to the very mutant it
// is meant to catch.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";

test("fail() backs off the full baseBackoffMs, not less", t => {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at;
  const q = f.store.wakeQueue, k = f.keys.owner;
  const memberId = f.store.authenticate(k, "commons").member.id;
  q.enqueue(k, "commons", { requestId: randomUUID(), queueKey: "k", intent: { x: 1 }, dueAt: at, maxAttempts: 3 });
  const owner = randomUUID();
  assert.ok(q.lease("commons", memberId, "k", owner));
  q.fail("commons", memberId, "k", { leaseOwner: owner, error: "boom" });
  at += 30000; // half the true baseBackoffMs (60000); 5x the mutant's (6000)
  assert.equal(q.due(at).length, 0, "wake is not due before the full backoff elapses");
});
