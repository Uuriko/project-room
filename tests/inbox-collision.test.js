// LANE C (quill/inbox-agent-collab): soft draft locks and concurrent-edit
// detection — advisory, expiring, never a hard gate on sending.
import test from "node:test";
import assert from "node:assert/strict";
import { CollisionError, createCollisionTracker, defaultLockTtlMs } from "../server/inbox-collision.mjs";

const claude = { kind: "agent", id: "claude", label: "Claude" };
const instinct = { kind: "agent", id: "instinct", label: "Instinct" };
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof CollisionError); assert.equal(error.code, code); return error; }
  assert.fail(`expected ${code} but nothing threw`);
};
const manualClock = (start = 1000) => { let now = start; const clock = () => now; clock.advance = ms => { now += ms; }; return clock; };
const ids = (() => { let n = 0; return () => `lock-${++n}`; })();

test("acquireLock returns a frozen lock with expiry from the clock", () => {
  const clock = manualClock(1000);
  const tracker = createCollisionTracker({ clock, id: ids });
  const { lock, duplicate } = tracker.acquireLock("thread:1", claude);
  assert.equal(duplicate, false);
  assert.equal(lock.threadId, "thread:1");
  assert.deepEqual(lock.holder, claude);
  assert.equal(lock.expiresAt, 1000 + defaultLockTtlMs);
  assert.ok(Object.isFrozen(lock) && Object.isFrozen(lock.holder));
});
test("a live lock held by someone else throws collision_lock_held with the holder attached", () => {
  const tracker = createCollisionTracker({ clock: manualClock(1000), id: ids });
  tracker.acquireLock("thread:1", claude);
  const error = expectCode(() => tracker.acquireLock("thread:1", instinct), "collision_lock_held");
  assert.equal(error.detail.holder.id, "claude");
});
test("the same holder re-acquiring refreshes the expiry instead of colliding", () => {
  const clock = manualClock(1000);
  const tracker = createCollisionTracker({ clock, id: ids });
  tracker.acquireLock("thread:1", claude);
  clock.advance(60000);
  const { lock, duplicate } = tracker.acquireLock("thread:1", claude);
  assert.equal(duplicate, true);
  assert.equal(lock.expiresAt, 61000 + defaultLockTtlMs);
});
test("expired locks are silently replaced; heartbeat on an expired lock throws", () => {
  const clock = manualClock(1000);
  const tracker = createCollisionTracker({ clock, id: ids });
  const first = tracker.acquireLock("thread:1", claude).lock;
  clock.advance(defaultLockTtlMs + 1);
  const second = tracker.acquireLock("thread:1", instinct).lock;
  assert.notEqual(second.lockId, first.lockId);
  expectCode(() => tracker.heartbeat(first.lockId), "collision_lock_not_found");
  const alive = tracker.heartbeat(second.lockId);
  assert.equal(alive.lockId, second.lockId);
});
test("heartbeat extends a live lock; only the holder may release", () => {
  const clock = manualClock(1000);
  const tracker = createCollisionTracker({ clock, id: ids });
  const { lock } = tracker.acquireLock("thread:1", claude);
  clock.advance(60000);
  const refreshed = tracker.heartbeat(lock.lockId);
  assert.equal(refreshed.expiresAt, 61000 + defaultLockTtlMs);
  expectCode(() => tracker.releaseLock(lock.lockId, { by: instinct }), "collision_forbidden");
  const released = tracker.releaseLock(lock.lockId, { by: claude });
  assert.deepEqual(released, { released: true, lockId: lock.lockId });
  expectCode(() => tracker.heartbeat(lock.lockId), "collision_lock_not_found");
});
test("detectCollision names the other editor and ships a merge hint", () => {
  const tracker = createCollisionTracker({ clock: manualClock(1000), id: ids });
  tracker.acquireLock("thread:1", claude);
  const hit = tracker.detectCollision("thread:1", instinct);
  assert.equal(hit.collision, true);
  assert.deepEqual(hit.holders.map(h => h.id), ["claude"]);
  assert.match(hit.warning, /Claude is drafting/);
  assert.match(hit.mergeHint, /compare drafts/i);
  assert.ok(Object.isFrozen(hit) && Object.isFrozen(hit.holders));
  const self = tracker.detectCollision("thread:1", claude);
  assert.equal(self.collision, false);
  assert.equal(self.warning, null);
  assert.equal(self.mergeHint, null);
  const empty = tracker.detectCollision("thread:free", instinct);
  assert.equal(empty.collision, false);
});
test("sweep drops expired locks and reports the count", () => {
  const clock = manualClock(1000);
  const tracker = createCollisionTracker({ clock, id: ids });
  tracker.acquireLock("thread:1", claude);
  tracker.acquireLock("thread:2", instinct, { ttlMs: 60000 });
  assert.equal(tracker.sweep(), 0);
  clock.advance(60001);
  assert.equal(tracker.sweep(), 1);
  // thread:1's default-ttl lock survives; instinct's is gone.
  assert.equal(tracker.detectCollision("thread:1", instinct).collision, true);
  assert.equal(tracker.detectCollision("thread:2", claude).collision, false);
});
test("validation rejects bad holders, threads and ttls", () => {
  const tracker = createCollisionTracker({ id: ids });
  expectCode(() => tracker.acquireLock("", claude), "collision_invalid");
  expectCode(() => tracker.acquireLock("t", "claude"), "collision_invalid");
  expectCode(() => tracker.acquireLock("t", claude, { ttlMs: 500 }), "collision_invalid");
  expectCode(() => tracker.heartbeat(""), "collision_invalid");
});
