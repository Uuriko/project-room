// Time-layer skew regressions (methods audit Phase B B3-5 F1-F4 + B3-1-F1).
// Leases and backoffs are wall-clock in the tables, but a forward wall
// step must not double-fire work that is still in flight in real time,
// a backward step must not erase backoff, an aged-out sleeper wake must
// be observable, and a commit reported as failed after it applied must
// still publish its append notification.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { WakeQueue, wakeQueueSchema, wakeQueueLimits } from "../server/wake-queue.mjs";
import { missedWakeDueAt, catchUpMissedWakes, agedOutMissedWakes } from "../server/sleeper-wake.mjs";
import { rememberPoll } from "../server/claim-coordination.mjs";
import { WEBHOOK_DELIVERY_CLAIM_LEASE_MS } from "../server/agent-plugin-store.mjs";

const T0 = 1_760_000_000_000, MIN = 60_000, HOUR = 3_600_000;

function freshStore(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}
function seedWake(store, key, dueAt = T0) {
  if (!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wake_queue'").get()) store.db.exec(wakeQueueSchema);
  store.db.prepare(`INSERT INTO wake_queue (room_id,member_id,queue_key,intent,state,due_at,attempts,max_attempts,lease_owner,lease_expires_at,last_error,created_at,updated_at)
    VALUES ('commons','m1',?,'{}','pending',?,0,3,NULL,NULL,NULL,?,?)`).run(key, dueAt, T0, T0);
}

test("B3-5-F1: a forward wall step past the wake lease does not hand one wake to two live owners", t => {
  const store = freshStore(t);
  seedWake(store, "w-lease");
  const W = store.wakeQueue;
  const leaseA = W.lease("commons", "m1", "w-lease", "owner-A", T0);
  assert.ok(leaseA);
  // Wall steps +31s (past the 30s lease) while A has had ~0 real time.
  assert.equal(W.recover(T0 + wakeQueueLimits.leaseMs + 1000), 0);
  assert.equal(W.lease("commons", "m1", "w-lease", "owner-B", T0 + wakeQueueLimits.leaseMs + 1000), null);
  // The original holder still completes, exactly once.
  const done = W.complete("commons", "m1", "w-lease", { requestId: "req-a-000000000001", leaseOwner: "owner-A" });
  assert.equal(done.receipt.state, "done");
});

test("B3-5-F1 control: a lease unknown to this process (post-restart) recovers on wall expiry as before", t => {
  const store = freshStore(t);
  seedWake(store, "w-lease");
  store.wakeQueue.lease("commons", "m1", "w-lease", "owner-A", T0);
  const restarted = new WakeQueue(store); // empty monotonic registry
  assert.equal(restarted.recover(T0 + wakeQueueLimits.leaseMs + 1000), 1);
  assert.ok(restarted.lease("commons", "m1", "w-lease", "owner-B", T0 + wakeQueueLimits.leaseMs + 1000));
});

test("B3-5-F3: wake fail() backoff is anchored at the lease, so a backward step cannot erase it", t => {
  const store = freshStore(t);
  seedWake(store, "w-backoff");
  const W = store.wakeQueue;
  W.lease("commons", "m1", "w-backoff", "owner-C", T0);
  const failed = W.fail("commons", "m1", "w-backoff", { leaseOwner: "owner-C", error: "boom", now: T0 - HOUR });
  assert.equal(failed.dueAt, T0 + wakeQueueLimits.baseBackoffMs);
  assert.equal(W.due(T0 + wakeQueueLimits.baseBackoffMs - 1).filter(w => w.queueKey === "w-backoff").length, 0);
});

test("B3-5-F3: claim rememberPoll never moves the next poll earlier than the schedule it replaces", () => {
  const base = { id: "x", state: "claimed", owner: "alice",
    pullRequest: { url: "https://github.com/Uuriko/project-room/pull/9", outcome: null, nextPollAt: T0 + 10 * MIN, rateLimitedUntil: null } };
  const polled = rememberPoll(base, T0 - HOUR, 60_000, {});
  assert.equal(polled.pullRequest.nextPollAt, T0 + 10 * MIN);
  // Unskewed control: a due poll still advances by exactly the delay.
  const normal = rememberPoll(base, T0 + 10 * MIN, 60_000, {});
  assert.equal(normal.pullRequest.nextPollAt, T0 + 11 * MIN);
});

test("B3-5-F2: a forward wall step past the webhook claim lease does not double-POST one delivery", async t => {
  const store = freshStore(t);
  const plugin = store.agentPlugin;
  const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
  const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });
  const { subscription } = plugin.subscribeWebhook({
    identityId: "agent_skew", url: "https://hooks.example.test/agent",
    events: ["message.posted"], secret: "s".repeat(32) });
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('del_skew', 'idem_del_skew', ?, 'agent_skew', 'message.posted', '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
    .run(subscription.subscriptionId, T0, T0, T0);
  const rowA = plugin.db.prepare("SELECT * FROM agent_webhook_deliveries WHERE delivery_id='del_skew'").get();
  let release; const gate = new Promise(r => { release = r; });
  let posts = 0;
  const fetchImpl = async () => { posts++; if (posts === 1) await gate; return ok200(); };
  const attemptA = plugin.attemptStoredDelivery(rowA, { fetchImpl, now: T0, dnsResolvers: publicDns });
  const started = Date.now();
  while (posts !== 1 && Date.now() - started < 2000) await new Promise(r => setTimeout(r, 5));
  assert.equal(posts, 1);
  const rowB = plugin.db.prepare("SELECT * FROM agent_webhook_deliveries WHERE delivery_id='del_skew'").get();
  const attemptB = await plugin.attemptStoredDelivery(rowB,
    { fetchImpl, now: T0 + WEBHOOK_DELIVERY_CLAIM_LEASE_MS + 1000, dnsResolvers: publicDns });
  release();
  const resultA = await attemptA;
  assert.equal(attemptB, "skipped");
  assert.equal(resultA, "delivered");
  assert.equal(posts, 1, "exactly one POST for one delivery_id under a forward step over the claim lease");
  const finalRow = plugin.db.prepare("SELECT state, attempts FROM agent_webhook_deliveries WHERE delivery_id='del_skew'").get();
  assert.equal(finalRow.state, "delivered");
  assert.equal(finalRow.attempts, 1);
});

test("B3-5-F4: a sleeper wake aged out of the 24h window by a forward step is counted, not silent", t => {
  const store = freshStore(t);
  store.featureEnv = { ROOM_OWNER_ASLEEP_WAKE: "on" };
  store.agentPlugin.subscribeWebhook({ identityId: "agent_sleeper", url: "https://hooks.example.test/agent", events: ["agent.wake"], secret: "s".repeat(32) });
  store.db.prepare(`INSERT INTO agent_wake_signals (signal_id, agent_id, kind, room_id, message_id, created_at, delivered_at)
    VALUES ('sig1','agent_sleeper','mention','commons','msg1',?,NULL)`).run(T0);
  assert.equal(missedWakeDueAt(store, T0 + 25 * HOUR), null);
  assert.equal(agedOutMissedWakes(store, T0 + 25 * HOUR), 1);
  assert.deepEqual(catchUpMissedWakes(store, { now: T0 + 25 * HOUR }), { replayed: 0, agedOut: 1 });
  // Inside the window nothing is aged out.
  assert.equal(agedOutMissedWakes(store, T0 + HOUR), 0);
});

test("B3-1-F1: a commit reported as failed after it applied still publishes its append notification", t => {
  const store = freshStore(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const stampBefore = store.eventStamp("commons");
  let heard = 0; store.onEventAppended(() => { heard++; });
  let armed = true;
  const orig = store.storagePlatform;
  store.storagePlatform = { ...orig, transaction(db, fn, readOnly, opts) {
    const result = orig.transaction(db, fn, readOnly, opts);
    if (armed && !readOnly) { armed = false; const e = new Error("disk I/O error"); e.errcode = 10; throw e; }
    return result;
  } };
  assert.throws(() => store.command(ownerKey, "commons",
    { id: "cmd-f1", type: T.MESSAGE_POSTED, data: { messageId: "m-f1", body: "indeterminate commit probe" } }));
  // The commit is durable (the caller still sees the failure: the outcome
  // is indeterminate at that seam), and its append notification fired.
  assert.ok(store.headSequence("commons") > 0);
  assert.equal(store.eventStamp("commons"), stampBefore + 1);
  assert.equal(heard, 1);
  assert.equal(store._pendingAppends.size, 0);
});

test("B3-1-F1 control: a rolled-back transaction publishes no append notification", t => {
  const store = freshStore(t);
  const ownerKey = store.issueAccessKey("commons", "owner");
  const stampBefore = store.eventStamp("commons");
  let heard = 0; store.onEventAppended(() => { heard++; });
  assert.throws(() => store.transaction(() => {
    store.command(ownerKey, "commons",
      { id: "cmd-rb", type: T.MESSAGE_POSTED, data: { messageId: "m-rb", body: "rolled back" } });
    throw new Error("boom");
  }));
  assert.equal(store.eventStamp("commons"), stampBefore);
  assert.equal(heard, 0);
  assert.equal(store._pendingAppends.size, 0);
});
