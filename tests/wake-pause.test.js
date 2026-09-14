// W4-48 H7: pause and inspect - one stop surface over the wake queue.
// Done-when: pending and already-running attempts are distinguished.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { surfaceClass } from "../server/action-classes.mjs";

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  let at = Date.now(); f.store.now = () => at; f.at = () => at; f.advance = ms => { at += ms; };
  f.enqueue = (extra = {}, actor = "owner") => f.store.wakeQueue.enqueue(f.keys[actor], "commons",
    { requestId: randomUUID(), queueKey: "recipe:draft-catch-up", intent: { recipe: "draft-catch-up" }, dueAt: at, maxAttempts: 3, ...extra });
  f.view = (actor = "owner") => f.store.wakeQueue.list(f.keys[actor], "commons");
  return f;
}

test("pause and resume validate, retry idempotently and are the member's own", t => {
  const f = fixture(t);
  assert.throws(() => f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: "bad id!", reason: null }));
  assert.throws(() => f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "x".repeat(201) }));
  assert.throws(() => f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID(), extra: true }));
  const paused = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "inspecting" });
  assert.equal(paused.receipt.state, "paused");
  assert.equal(paused.receipt.alreadyPaused, false);
  assert.equal(paused.pause.reason, "inspecting");
  const again = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "still" });
  assert.equal(again.receipt.alreadyPaused, true, "re-pause keeps the original pause");
  assert.equal(f.view().pause.reason, "inspecting");
  const retry = f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: paused.receipt.requestId, reason: "inspecting" });
  assert.equal(retry.duplicate, true, "exact retry returns the historical receipt");
  assert.equal(f.view("guest").pause, null, "pause is private per member");
  const resumed = f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.equal(resumed.receipt.wasPaused, true);
  assert.equal(f.view().pause, null);
  const twice = f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.equal(twice.receipt.wasPaused, false, "resume without a pause is a no-op, not an error");
});

test("done-when: while paused no pending attempt starts, an already-running attempt is distinguished and finishes", t => {
  const f = fixture(t);
  f.enqueue();
  const running = f.store.wakeQueue.lease("commons", "owner", "recipe:draft-catch-up", "worker-1");
  assert.ok(running, "wake leased before the pause: already running");
  f.enqueue({ queueKey: "recipe:request-review" }, "owner");
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: "look before more" });
  // The stop surface distinguishes: one running, one pending.
  const view = f.view();
  assert.deepEqual(view.running.map(w => w.queueKey), ["recipe:draft-catch-up"]);
  assert.deepEqual(view.pending.map(w => w.queueKey), ["recipe:request-review"]);
  assert.equal(view.pause.reason, "look before more");
  // No new attempt starts while paused, even when due.
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), [], "paused member's pending wake is not leasable");
  assert.equal(f.store.wakeQueue.lease("commons", "owner", "recipe:request-review", "worker-1"), null);
  // The already-running attempt is not interrupted: it completes normally.
  const done = f.store.wakeQueue.complete("commons", "owner", "recipe:draft-catch-up", { requestId: randomUUID(), leaseOwner: "worker-1", effect: { draft: true } });
  assert.equal(done.receipt.state, "done");
  // Recent outcomes are readable: the completion shows with its attempt count.
  const after = f.view();
  assert.deepEqual(after.recentOutcomes.map(o => [o.queueKey, o.state, o.attempts]), [["recipe:draft-catch-up", "done", 1]]);
  assert.equal(after.running.length, 0);
  // Resume lets the pending wake start again.
  f.store.wakeQueue.resume(f.keys.owner, "commons", { requestId: randomUUID() });
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), ["recipe:request-review"]);
});

test("a paused member's dead-letter and failed attempts stay inspectable, other members are unaffected", t => {
  const f = fixture(t);
  f.enqueue({ maxAttempts: 1 });
  f.store.wakeQueue.lease("commons", "owner", "recipe:draft-catch-up", "worker-1");
  const failed = f.store.wakeQueue.fail("commons", "owner", "recipe:draft-catch-up", { leaseOwner: "worker-1", error: "boom" });
  assert.equal(failed.state, "dead");
  f.enqueue({}, "guest");
  f.store.wakeQueue.pause(f.keys.owner, "commons", { requestId: randomUUID(), reason: null });
  const view = f.view();
  assert.deepEqual(view.recentOutcomes.map(o => [o.queueKey, o.state, o.lastError]), [["recipe:draft-catch-up", "dead", "boom"]]);
  assert.deepEqual(f.store.wakeQueue.due(f.at()).map(w => w.queueKey), ["recipe:draft-catch-up"], "guest's due wake is unaffected by the owner's pause");
  assert.equal(surfaceClass("wake-queue"), "draft", "the stop surface stays draft class: no sends, no spend");
});
