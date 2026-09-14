// W4-45 H3: durable wake queue - retry, coalescing, dead-letter, recovery.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { RoomStore } from "../server/store.mjs";
import { wakeQueueLimits } from "../server/wake-queue.mjs";
import { surfaceClass } from "../server/action-classes.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.at = () => at; f.advance = ms => { at += ms; };
  f.enqueue = (extra = {}, actor = "owner") => f.store.wakeQueue.enqueue(f.keys[actor], "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: at, maxAttempts: 3, ...extra });
  f.list = (actor = "owner") => f.store.wakeQueue.list(f.keys[actor], "commons").wakes;
  return f;
}

test("enqueue validates exactly, coalesces per queue key and retries idempotently", t => {
  const f = fixture(t);
  for (const change of [{ queueKey: "bad key!" }, { dueAt: 1.5 }, { maxAttempts: 0 }, { maxAttempts: 99 }, { intent: null }, { intent: [] }, { dueAt: f.at() + wakeQueueLimits.horizon + 1 }]) {
    assert.throws(() => f.enqueue(change));
    assert.equal(f.list().length, 0);
  }
  const first = f.enqueue();
  assert.equal(first.duplicate, false); assert.equal(first.receipt.coalesced, false);
  assert.equal(f.list().length, 1);
  const retry = f.enqueue({ requestId: first.receipt.requestId });
  assert.equal(retry.duplicate, true, "exact retry returns the historical receipt, no second row");
  assert.equal(f.list().length, 1);
  f.advance(5000);
  const again = f.enqueue({ dueAt: f.at() });
  assert.equal(again.receipt.coalesced, true, "same queue key coalesces instead of duplicating");
  assert.equal(f.list().length, 1);
  assert.equal(f.list()[0].dueAt, first.receipt.dueAt, "coalescing keeps the earliest due time");
  assert.equal(f.list("guest").length, 0, "wakes are private per member");
});

test("leased wakes retry with bounded backoff and dead-letter when exhausted", t => {
  const f = fixture(t);
  f.enqueue({ maxAttempts: 2 });
  const owner1 = randomUUID();
  const leased = f.store.wakeQueue.lease("commons", f.store.authenticate(f.keys.owner, "commons").member.id, "recipe:draft-catch-up", owner1);
  assert.equal(leased.attempts, 1); assert.equal(leased.state, "leased");
  assert.equal(f.store.wakeQueue.lease("commons", leased.member_id, "recipe:draft-catch-up", randomUUID()), null, "a leased wake cannot be double-leased");
  assert.throws(() => f.store.wakeQueue.complete("commons", leased.member_id, "recipe:draft-catch-up", { requestId: randomUUID(), leaseOwner: "wrong" }), { code: "wake_not_leased" });
  const failed = f.store.wakeQueue.fail("commons", leased.member_id, "recipe:draft-catch-up", { leaseOwner: owner1, error: "boom" });
  assert.equal(failed.state, "pending"); assert.ok(failed.dueAt > f.at(), "failure backs off instead of hot-looping");
  assert.equal(f.store.wakeQueue.due(f.at()).length, 0, "backed-off wake is not due yet");
  f.advance(wakeQueueLimits.baseBackoffMs);
  assert.equal(f.store.wakeQueue.due(f.at()).length, 1, "wake is due again after backoff");
  const owner2 = randomUUID();
  f.store.wakeQueue.lease("commons", leased.member_id, "recipe:draft-catch-up", owner2);
  const dead = f.store.wakeQueue.fail("commons", leased.member_id, "recipe:draft-catch-up", { leaseOwner: owner2, error: "boom again" });
  assert.equal(dead.state, "dead", "exhausted attempts dead-letter the wake");
  assert.equal(f.list()[0].state, "dead"); assert.equal(f.list()[0].lastError, "boom again");
  assert.throws(() => f.enqueue(), { code: "wake_dead" }, "dead letters park until explicitly requeued");
  const rq = f.store.wakeQueue.requeue(f.keys.owner, "commons", { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", dueAt: f.at() });
  assert.equal(rq.receipt.state, "pending"); assert.equal(f.list()[0].attempts, 0);
});

test("done-when: a restart preserves intent without duplicate action", t => {
  const f = fixture(t);
  const enqueued = f.enqueue();
  const memberId = f.store.authenticate(f.keys.owner, "commons").member.id;
  const owner = randomUUID();
  const leased = f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", owner);
  assert.ok(leased, "wake is in-flight when the process dies");
  // Simulate the crash: close without completing, reopen from the same file.
  f.advance(wakeQueueLimits.leaseMs + 1); // the lease expires during downtime
  f.store.close();
  f.store = new RoomStore(join(f.directory, "room.sqlite"), { now: () => f.at() });
  const wakes = f.store.wakeQueue.list(f.keys.owner, "commons").wakes;
  assert.equal(wakes.length, 1, "exactly one wake survived the restart - intent preserved, not duplicated");
  assert.equal(wakes[0].state, "pending", "open-time recovery returned the expired lease to pending");
  assert.equal(wakes[0].attempts, 1, "the interrupted attempt was counted once");
  assert.deepEqual(wakes[0].intent, { recipe: "draft-catch-up" }, "the intent payload survived byte-identical");
  const ownerB = randomUUID();
  assert.ok(f.store.wakeQueue.lease("commons", memberId, "recipe:draft-catch-up", ownerB), "recovered wake is leasable again");
  const requestId = randomUUID();
  let effects = 0;
  const done = f.store.wakeQueue.complete("commons", memberId, "recipe:draft-catch-up", { requestId, leaseOwner: ownerB, effect: "draft-written" });
  if (!done.duplicate) effects += 1;
  const again = f.store.wakeQueue.complete("commons", memberId, "recipe:draft-catch-up", { requestId, leaseOwner: ownerB, effect: "draft-written" });
  if (!again.duplicate) effects += 1;
  assert.equal(again.duplicate, true, "retried completion is a duplicate no-op");
  assert.equal(effects, 1, "the effect applied exactly once across the retry");
  assert.equal(f.store.wakeQueue.list(f.keys.owner, "commons").wakes[0].state, "done");
});

test("wake queue is draft-class and enqueueing appends no room events", t => {
  const f = fixture(t);
  assert.equal(surfaceClass("wake-queue"), "draft");
  const before = f.store.snapshot(f.keys.owner, "commons");
  f.enqueue();
  const after = f.store.snapshot(f.keys.owner, "commons");
  assert.equal(after.sequence, before.sequence, "queue intent is private state, never a room event");
  assert.deepEqual(after.state, before.state);
});
