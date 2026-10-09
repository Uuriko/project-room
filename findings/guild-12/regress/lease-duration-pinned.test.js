// Guild-12 fail-first regression for mutant M13 (wake-queue-limits.mjs).
//
// FINDING: no test pins the lease duration (wakeQueueLimits.leaseMs).
// The M13 mutant (30000 -> 3000) passes the suite while making crash
// recovery ten times more aggressive.
//
// FAIL-FIRST: on current code PASSES; with the M13 mutant FAILS.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../../../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../../../server/store.mjs";
import { wakeQueueLimits } from "../../../server/wake-queue.mjs";

test("a lease younger than leaseMs survives crash recovery", t => {
  const f = createAcceptanceFixture();
  t.after(() => { try { f.store.close(); } catch {} rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at;
  const memberId = f.store.authenticate(f.keys.owner, "commons").member.id;
  f.store.wakeQueue.enqueue(f.keys.owner, "commons",
    { requestId: randomUUID(), queueKey: "k", intent: { x: 1 }, dueAt: at, maxAttempts: 3 });
  const owner = randomUUID();
  assert.ok(f.store.wakeQueue.lease("commons", memberId, "k", owner));
  // Crash well before the lease expires: the lease must NOT be recovered.
  // NOTE: the 15000 below is a literal on purpose — it must NOT be read
  // from wakeQueueLimits.leaseMs, or the test adapts to the very mutant it
  // is meant to catch (M13: leaseMs 30000 -> 3000).
  at += 15000;
  f.store.close();
  f.store = new RoomStore(join(f.directory, "room.sqlite"), { now: () => at });
  const wakes = f.store.wakeQueue.list(f.keys.owner, "commons").wakes;
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].state, "leased", "unexpired lease is untouched by recovery");
  assert.equal(wakes[0].leaseOwner, owner);
});
