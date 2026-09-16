// A022: channel failover. Pure retry-queue tests; no provider sends.
import test from "node:test";
import assert from "node:assert/strict";
import { createFailoverQueue, backoffDelay, FailoverError, DEFAULTS } from "../server/channel-failover.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof FailoverError && error.code === code);

test("backoffDelay grows exponentially and caps", () => {
  assert.deepEqual([1, 2, 3].map(a => backoffDelay(a, { baseDelayMs: 1000, maxDelayMs: 10000 })),
    [1000, 2000, 4000]);
  assert.equal(backoffDelay(20, { baseDelayMs: 1000, maxDelayMs: 5000 }), 5000);
  assert.equal(DEFAULTS.maxAttempts, 5);
});
test("enqueue → failure → retry → success lifecycle", () => {
  const queue = createFailoverQueue({ maxAttempts: 3, baseDelayMs: 1000 });
  const item = queue.enqueue({ id: "m1", channel: "telegram", payload: { text: "hi" } }, { now: 0 });
  assert.equal(item.state, "queued");
  assert.equal(queue.size(), 1);
  const failed = queue.recordFailure("m1", { now: 0, error: "timeout" });
  assert.equal(failed.attempts, 1);
  assert.equal(failed.state, "queued");
  assert.equal(new Date(failed.nextRetryAt).getTime(), 1000);
  // Not due yet at t=500; due at t=1000.
  assert.equal(queue.dueItems({ now: 500 }).length, 0);
  assert.equal(queue.dueItems({ now: 1000 }).length, 1);
  const delivered = queue.recordSuccess("m1");
  assert.equal(delivered.state, "delivered");
  assert.equal(queue.size(), 0);
});
test("exhausted attempts go to dead-letter, never silently dropped", () => {
  const queue = createFailoverQueue({ maxAttempts: 2, baseDelayMs: 1000 });
  queue.enqueue({ id: "m2", channel: "whatsapp" }, { now: 0 });
  queue.recordFailure("m2", { now: 0 });
  const dead = queue.recordFailure("m2", { now: 1000 });
  assert.equal(dead.state, "dead-letter");
  assert.equal(dead.attempts, 2);
  assert.equal(queue.size(), 1); // still tracked, not lost
  assert.equal(queue.dueItems({ now: 999999 }).length, 0); // never retried again
});
test("malformed inputs are refused", () => {
  throwsCode(() => backoffDelay(0), "invalid_failover");
  throwsCode(() => createFailoverQueue({ maxAttempts: 0 }), "invalid_failover");
  const queue = createFailoverQueue();
  throwsCode(() => queue.enqueue({ id: "", channel: "x" }), "invalid_failover");
  throwsCode(() => queue.recordFailure("nope"), "invalid_failover");
});
