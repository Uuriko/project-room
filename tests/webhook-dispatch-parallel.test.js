// WAVE-300 F2: bounded-parallel wake dispatch + coalescing
// (server/agent-plugin-store.mjs drainWebhookDeliveries). SIM: injected
// fetchImpl with artificial latency, no network, no credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { WAKE_PING_EVENT, buildWakePing } from "../server/outbound-webhooks.mjs";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const SECRET = "signing-secret-0123456789abcdef";
// QA-Sec 2026-09-19: dispatch re-validates the target (incl. DNS) before
// every POST, so drains inject a resolver that answers "public" for the
// test hostname. No network in tests.
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), "room-webhook-parallel-"));
  const store = new RoomStore(join(dir, "room.sqlite"), { now: () => NOW });
  try { return await fn(store); }
  finally {
    try { store.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

function subscribeWake(store, agentId, url) {
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: agentId, url, events: [WAKE_PING_EVENT], secret: SECRET,
  });
  return subscription.subscriptionId;
}

function enqueueWake(store, subscriptionId, agentId, eventId) {
  store.agentPlugin.buildWebhookDelivery(subscriptionId, {
    eventType: WAKE_PING_EVENT,
    data: buildWakePing({ agentId, signal: { signalId: eventId } }),
    eventId,
    roomId: null,
  });
}

function drainOptions(extra = {}) {
  return { fetchImpl: extra.fetchImpl, now: NOW, limit: 25, dnsResolvers: publicDns, ...extra };
}

function deliveryStates(store) {
  return store.db.prepare(
    "SELECT delivery_id, state, attempts FROM agent_webhook_deliveries ORDER BY delivery_id")
    .all();
}

test("drain dispatches with bounded parallelism: 10 deliveries beat sequential wall-clock", async () => {
  await withStore(async store => {
    const sub = subscribeWake(store, "wake-agent", "https://hooks.example.test/agent");
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(20); // artificial latency per POST
      inFlight--;
      return { status: 200, text: async () => "ok", headers: { get: () => null } };
    };
    // Solo baseline: one delivery through the same code path (warms every
    // cache too). Sequential 10x would cost ~10x this.
    enqueueWake(store, sub, "wake-agent", "evt-solo");
    const s0 = Date.now();
    const solo = await store.agentPlugin.drainWebhookDeliveries(drainOptions({ fetchImpl }));
    const singleMs = Date.now() - s0;
    assert.equal(solo.delivered, 1);
    assert.equal(maxInFlight, 1);
    // The parallel batch. Distinct eventIds => no coalescing.
    for (let i = 0; i < 10; i++) enqueueWake(store, sub, "wake-agent", `evt-${i}`);
    inFlight = 0; maxInFlight = 0;
    const t0 = Date.now();
    const summary = await store.agentPlugin.drainWebhookDeliveries(drainOptions({ fetchImpl }));
    const elapsed = Date.now() - t0;
    assert.equal(summary.processed, 10);
    assert.equal(summary.delivered, 10);
    for (const row of deliveryStates(store)) {
      assert.equal(row.state, "delivered", `${row.delivery_id} must be delivered`);
    }
    assert.ok(maxInFlight > 1, `expected overlap, saw maxInFlight=${maxInFlight}`);
    assert.ok(maxInFlight <= 8, `concurrency must stay bounded, saw ${maxInFlight}`);
    // 10 sequential attempts would cost ~10x one; the pool must beat that
    // by a clear margin (8-wide pool => ~2 waves).
    assert.ok(elapsed < singleMs * 8,
      `10 parallel drains took ${elapsed}ms, expected well under 8x one solo attempt (${singleMs}ms)`);
  });
});

test("drain coalesces duplicate wake pings: same URL + same eventId = one POST", async () => {
  await withStore(async store => {
    const shared = "https://hooks.example.test/shared";
    const subs = [
      subscribeWake(store, "agent-a", shared),
      subscribeWake(store, "agent-b", shared),
      subscribeWake(store, "agent-c", shared),
      subscribeWake(store, "agent-d", "https://hooks.example.test/other"),
    ];
    enqueueWake(store, subs[0], "agent-a", "evt-same");
    enqueueWake(store, subs[1], "agent-b", "evt-same");
    enqueueWake(store, subs[2], "agent-c", "evt-same");
    enqueueWake(store, subs[3], "agent-d", "evt-other");
    const posted = [];
    const fetchImpl = async url => {
      posted.push(url);
      await sleep(5);
      return { status: 200, text: async () => "ok", headers: { get: () => null } };
    };
    const summary = await store.agentPlugin.drainWebhookDeliveries(drainOptions({ fetchImpl }));
    assert.deepEqual([...posted].sort(), [shared, "https://hooks.example.test/other"].sort());
    assert.equal(posted.length, 2);
    assert.equal(summary.processed, 4);
    assert.equal(summary.delivered, 4);
    for (const row of deliveryStates(store)) {
      assert.equal(row.state, "delivered", `${row.delivery_id} must be delivered`);
    }
    // The coalesced followers carry the POSTed signal: every row's stored
    // envelope is a signed agent.wake envelope for the same event.
    const envelopes = store.db.prepare(
      "SELECT payload_json FROM agent_webhook_deliveries WHERE event_id='evt-same'")
      .all().map(r => JSON.parse(r.payload_json));
    assert.equal(envelopes.length, 3);
    for (const env of envelopes) assert.equal(env.eventType, "agent.wake");
  });
});

test("no coalescing across different eventIds on the same URL", async () => {
  await withStore(async store => {
    const sub = subscribeWake(store, "wake-agent", "https://hooks.example.test/agent");
    enqueueWake(store, sub, "wake-agent", "evt-one");
    enqueueWake(store, sub, "wake-agent", "evt-two");
    const posted = [];
    const fetchImpl = async url => {
      posted.push(url);
      return { status: 200, text: async () => "ok", headers: { get: () => null } };
    };
    const summary = await store.agentPlugin.drainWebhookDeliveries(drainOptions({ fetchImpl }));
    assert.equal(posted.length, 2);
    assert.equal(summary.delivered, 2);
  });
});

test("coalesced followers stay pending when the leader fails", async () => {
  await withStore(async store => {
    const shared = "https://hooks.example.test/shared";
    const subs = [
      subscribeWake(store, "agent-a", shared),
      subscribeWake(store, "agent-b", shared),
    ];
    enqueueWake(store, subs[0], "agent-a", "evt-same");
    enqueueWake(store, subs[1], "agent-b", "evt-same");
    const fetchImpl = async () => ({ status: 500, text: async () => "boom", headers: { get: () => null } });
    const summary = await store.agentPlugin.drainWebhookDeliveries(drainOptions({ fetchImpl }));
    // One POST (the leader); the leader is retried, the follower untouched.
    assert.equal(summary.processed, 1);
    assert.equal(summary.retried, 1);
    assert.equal(summary.delivered, 0);
    const states = deliveryStates(store).map(r => r.state).sort();
    assert.deepEqual(states, ["failed", "pending"]);
  });
});
