// Guild-12 fail-first regression for mutant M04 (wake-queue.mjs recover()).
//
// M-18 contract: an expired lease whose attempts are exhausted must go to
// 'dead' on crash recovery — like fail() would have — never back to pending,
// and never stranded in 'leased'. The existing suite only recovers a lease
// with attempts < maxAttempts, so the `attempts>=max_attempts` boundary in
// recover() is unpinned: the M04 mutant (`>` instead of `>=`) passes the
// whole suite while stranding exhausted leases in 'leased' forever (they match
// neither the dead-update nor the pending-update).
//
// FAIL-FIRST: run against the M04 mutant -> this test FAILS (state stays
// 'leased'). Run against clean code -> PASSES.

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../../../server/store.mjs";
import { wakeQueueLimits } from "../../../server/wake-queue.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.at = () => at; f.advance = ms => { at += ms; };
  return f;
}

test("recover dead-letters an expired lease with exhausted attempts (M-18)", t => {
  const f = fixture(t);
  const memberId = f.store.authenticate(f.keys.owner, "commons").member.id;
  f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: f.at(), maxAttempts: 2 });
  // Attempt 1: lease then fail -> pending with backoff.
  const owner1 = randomUUID();
  assert.ok(f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", owner1));
  f.store.wakeQueue.fail("commons", memberId, "recipe:draft-catch-up", { leaseOwner: owner1, error: "boom" });
  // Attempt 2 (last): lease, then die mid-attempt without completing.
  f.advance(wakeQueueLimits.baseBackoffMs);
  const owner2 = randomUUID();
  const leased = f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", owner2);
  assert.ok(leased, "second lease granted");
  assert.equal(leased.attempts, 2, "attempts exhausted at maxAttempts=2");
  // Simulate the crash: the lease expires during downtime.
  f.advance(wakeQueueLimits.leaseMs + 1);
  f.store.close();
  f.store = new RoomStore(join(f.directory, "room.sqlite"), { now: () => f.at() });
  const wakes = f.store.wakeQueue.list(f.keys.owner, "commons").wakes;
  assert.equal(wakes.length, 1, "the wake survived the restart");
  assert.equal(wakes[0].state, "dead", "exhausted lease goes to dead on crash recovery, not pending");
  assert.equal(wakes[0].lastError, "crash_recovery_attempts_exhausted");
  assert.equal(f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", randomUUID()), null,
    "a dead-lettered wake is not leasable");
  assert.equal(f.store.wakeQueue.due(f.at()).length, 0, "a dead-lettered wake is never due");
});
