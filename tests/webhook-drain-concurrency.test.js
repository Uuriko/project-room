// Regression for #3251: concurrent webhook drains double-POST one delivery.
//
// AgentPluginStore.drainWebhookDeliveries selected due rows without
// claiming them and wrote completion state unconditionally from the
// drain-start snapshot. The dispatch kick, the per-minute cron and the
// agent-triggered process endpoint can all run a drain at once; while
// drain A awaited its POST the row was still pending, so drain B selected
// the same row, POSTed it again, and whichever completion write landed
// last won — a delivered row could be overwritten back to 'failed' by a
// slower stale attempt and then POSTed a third time.
//
// These tests force the interleavings deterministically: the fetch stub
// is gated on a deferred, so the first drain is provably parked inside
// its POST when the second drain starts. No sequential double-drain can
// reproduce this — the overlap is the bug.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { AgentPluginStore } from "../server/agent-plugin-store.mjs";
import { backoffDelayMs } from "../server/webhook-dispatch.mjs";

// Fake DNS so the dispatch-time SSRF guard re-validates without touching
// the network (same shape the other webhook tests inject).
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;

const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });
const err500 = () => ({ status: 500, headers: { get: () => null }, text: async () => "boom" });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(cond, timeoutMs = 2000) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(5);
  }
  return true;
}

function seedDelivery(plugin, deliveryId, agentId) {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "test-secret-0123456789abcdef",
  });
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'message.posted', '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
    .run(deliveryId, `idem_${deliveryId}`, subscription.subscriptionId, agentId, T0, T0, T0);
  return subscription;
}

const rowOf = (plugin, deliveryId) => plugin.db.prepare(
  "SELECT state, attempts, next_attempt_at FROM agent_webhook_deliveries WHERE delivery_id=?")
  .get(deliveryId);

test("two concurrent drains POST one pending delivery exactly once", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDelivery(plugin, "del_race_dup", "agent_race_dup");

  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls.push(1); await gate; return ok200(); };

  // Drain A parks inside its gated POST; drain B starts while A is
  // provably still in flight.
  const drainA = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(await until(() => calls.length === 1), true, "first drain reached its POST");
  const drainB = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  // On the buggy code drain B re-selects the still-pending row and POSTs
  // it too, arriving here almost immediately. Give it a bounded window to
  // do so before releasing A — on fixed code it must never arrive.
  await until(() => calls.length === 2, 500);
  release();
  const [sumA, sumB] = await Promise.all([drainA, drainB]);

  assert.equal(calls.length, 1, "one pending delivery is POSTed exactly once across concurrent drains");
  assert.equal(sumA.delivered + sumB.delivered, 1, "exactly one drain reports the delivery");
  assert.deepEqual({ ...rowOf(plugin, "del_race_dup") },
    { state: "delivered", attempts: 1, next_attempt_at: T0 });
});

test("a stale concurrent failure cannot resurrect a delivered row to 'failed'", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDelivery(plugin, "del_race_resurrect", "agent_race_resurrect");

  const calls = [];
  let releaseFirst;
  const gateFirst = new Promise(resolve => { releaseFirst = resolve; });
  // Call #1 (the first drain) is gated and will FAIL after release; a
  // second drain's call would succeed immediately — exactly the ordering
  // that used to land success first and the stale failure write last.
  const fetchImpl = async () => {
    calls.push(1);
    if (calls.length === 1) { await gateFirst; return err500(); }
    return ok200();
  };

  const drainB = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(await until(() => calls.length === 1), true, "first drain reached its POST");
  const drainA = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  await until(() => calls.length === 2, 500);
  releaseFirst();
  const [sumB, sumA] = await Promise.all([drainB, drainA]);

  // Only one attempt may happen: the second drain must not POST the same
  // delivery while the first owns it, so there is no stale success or
  // failure write that can overwrite the first drain's outcome. The sole
  // attempt failed retryably, so the row waits out its backoff — it is
  // never a delivered row flipped back to 'failed'.
  assert.equal(calls.length, 1, "the concurrent drain must not re-POST an in-flight delivery");
  assert.equal(sumA.processed, 0, "the concurrent drain finds no claimable copy of the delivery");
  assert.equal(sumB.retried, 1);
  assert.deepEqual({ ...rowOf(plugin, "del_race_resurrect") },
    { state: "failed", attempts: 1, next_attempt_at: T0 + backoffDelayMs(1) });
});

test("a delivery deleted mid-flight is not resurrected by the completion write", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDelivery(plugin, "del_race_deleted", "agent_race_deleted");

  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls.push(1); await gate; return ok200(); };

  const drainA = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(await until(() => calls.length === 1), true, "first drain reached its POST");
  // The row disappears while the POST is in flight (retention / operator
  // removal): the in-flight attempt's completion write must not bring it
  // back, and no later drain may send it.
  plugin.db.prepare("DELETE FROM agent_webhook_deliveries WHERE delivery_id=?")
    .run("del_race_deleted");
  release();
  await drainA;

  assert.equal(rowOf(plugin, "del_race_deleted"), undefined,
    "the completion write does not resurrect a deleted delivery");
  const again = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(calls.length, 1, "a deleted delivery is never sent twice");
  assert.equal(again.processed, 0);
});

test("drains on two store instances sharing one database cannot both claim a delivery", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seedDelivery(plugin, "del_race_instances", "agent_race_instances");
  // A second store over the same database shares no in-memory drain
  // mutex with the first; only the durable claim on the row itself can
  // keep the two apart.
  const other = new AgentPluginStore(f.store);
  other.load();

  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => { calls.push(1); await gate; return ok200(); };

  const drainA = plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(await until(() => calls.length === 1), true, "first drain reached its POST");
  const drainB = other.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  await until(() => calls.length === 2, 500);
  release();
  const [sumA, sumB] = await Promise.all([drainA, drainB]);

  assert.equal(calls.length, 1, "the delivery is claimed once even across store instances");
  assert.equal(sumA.delivered + sumB.delivered, 1);
  assert.equal(rowOf(plugin, "del_race_instances").state, "delivered");
  assert.equal(rowOf(plugin, "del_race_instances").attempts, 1);
});
