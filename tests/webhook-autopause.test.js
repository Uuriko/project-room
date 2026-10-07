// F4 lane (qa7-12-webhook-autopause): a dead webhook endpoint must not burn
// delivery attempts forever. After N consecutive terminal (dead-lettered)
// delivery failures the subscription auto-pauses (enabled=0, durable); the
// owner re-arms it with PATCH /api/agent-webhooks/{id} { enabled: true }.
// A delivered delivery resets the streak. Single-delivery receipts stay
// readable at GET /api/agent-webhooks/deliveries/{deliveryId} so a sender
// can confirm what happened to one delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { MAX_DELIVERY_ATTEMPTS } from "../server/webhook-dispatch.mjs";
import { WEBHOOK_AUTOPAUSE_AFTER_FAILURES } from "../server/agent-plugin-store.mjs";

const fakeLookup = async (host, options) => {
  assert.equal(options?.all, true);
  return [{ address: "93.184.216.34", family: 4 }];
};
const dnsResolvers = { lookup: fakeLookup };
const failFetch = async () => ({ status: 500, text: async () => "boom", headers: { get: () => null } });
const okFetch = async () => ({ status: 200, text: async () => "ok", headers: { get: () => null } });

async function setup(t, tag) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identity = f.store.identities.create(`autopause-${tag}`);
  const { subscription } = f.store.agentPlugin.subscribeWebhook({
    identityId: identity.identityId,
    url: "https://hooks.example/deliver",
    events: ["message.posted"],
  });
  const authed = (path, opts = {}) => fetch(`${origin}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${identity.secret}`, "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  return { f, origin, identity, subscriptionId: subscription.subscriptionId, authed };
}

// Drive one delivery to dead_letter: build it, then drain past every
// backoff step with a failing transport.
async function deadLetterOne(ap, subscriptionId, seed) {
  const delivery = ap.buildWebhookDelivery(subscriptionId,
    { eventType: "message.posted", data: { messageId: `m-${seed}` } });
  let now = Date.now();
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
    await ap.drainWebhookDeliveries({ fetchImpl: failFetch, now, dnsResolvers });
    now += 700_000;
  }
  const row = ap.store.db.prepare(
    "SELECT state FROM agent_webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId);
  assert.equal(row.state, "dead_letter", "test helper must actually dead-letter the delivery");
  return delivery.deliveryId;
}

const subRow = (f, subscriptionId) => f.store.db.prepare(
  "SELECT enabled, consecutive_failures FROM agent_webhook_subs WHERE subscription_id=?")
  .get(subscriptionId);

test("N consecutive dead-lettered deliveries auto-pause the subscription", async (t) => {
  const { f, subscriptionId } = await setup(t, "pause");
  const ap = f.store.agentPlugin;
  for (let i = 0; i < WEBHOOK_AUTOPAUSE_AFTER_FAILURES; i++) {
    await deadLetterOne(ap, subscriptionId, `pause-${i}`);
  }
  const row = subRow(f, subscriptionId);
  assert.equal(row.consecutive_failures, WEBHOOK_AUTOPAUSE_AFTER_FAILURES);
  assert.equal(row.enabled, 0, "subscription is auto-paused in the database");
  const view = ap.listWebhooks(ap.store.db.prepare(
    "SELECT agent_id FROM agent_webhook_subs WHERE subscription_id=?").get(subscriptionId).agent_id)
    .find(s => s.subscriptionId === subscriptionId);
  assert.equal(view.enabled, false, "the read view reflects the pause");
});

test("a delivered delivery resets the consecutive-failure streak", async (t) => {
  const { f, subscriptionId } = await setup(t, "reset");
  const ap = f.store.agentPlugin;
  await deadLetterOne(ap, subscriptionId, "reset-0");
  await deadLetterOne(ap, subscriptionId, "reset-1");
  assert.equal(subRow(f, subscriptionId).consecutive_failures, 2);
  // One success in the middle: the streak restarts.
  const delivery = ap.buildWebhookDelivery(subscriptionId,
    { eventType: "message.posted", data: { messageId: "m-reset-ok" } });
  await ap.drainWebhookDeliveries({ fetchImpl: okFetch, now: Date.now(), dnsResolvers });
  const state = ap.store.db.prepare(
    "SELECT state FROM agent_webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId).state;
  assert.equal(state, "delivered");
  const row = subRow(f, subscriptionId);
  assert.equal(row.consecutive_failures, 0, "streak resets on delivery");
  assert.equal(row.enabled, 1, "no pause after a reset streak");
});

test("an auto-paused subscription stops consuming drain attempts", async (t) => {
  const { f, subscriptionId } = await setup(t, "quiet");
  const ap = f.store.agentPlugin;
  for (let i = 0; i < WEBHOOK_AUTOPAUSE_AFTER_FAILURES; i++) {
    await deadLetterOne(ap, subscriptionId, `quiet-${i}`);
  }
  assert.equal(subRow(f, subscriptionId).enabled, 0);
  const delivery = ap.buildWebhookDelivery(subscriptionId,
    { eventType: "message.posted", data: { messageId: "m-quiet-after" } });
  const summary = await ap.drainWebhookDeliveries({ fetchImpl: okFetch, now: Date.now(), dnsResolvers });
  assert.equal(summary.processed, 0, "paused subscriptions are excluded from the drain batch");
  const state = ap.store.db.prepare(
    "SELECT state, attempts FROM agent_webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId);
  assert.equal(state.state, "pending");
  assert.equal(state.attempts, 0);
});

test("PATCH re-enables an auto-paused subscription and clears the streak", async (t) => {
  const { f, subscriptionId, authed } = await setup(t, "rearm");
  const ap = f.store.agentPlugin;
  for (let i = 0; i < WEBHOOK_AUTOPAUSE_AFTER_FAILURES; i++) {
    await deadLetterOne(ap, subscriptionId, `rearm-${i}`);
  }
  assert.equal(subRow(f, subscriptionId).enabled, 0);
  const res = await authed(`/api/agent-webhooks/${subscriptionId}`,
    { method: "PATCH", body: JSON.stringify({ enabled: true }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.subscription.enabled, true);
  const row = subRow(f, subscriptionId);
  assert.equal(row.enabled, 1);
  assert.equal(row.consecutive_failures, 0, "re-arm clears the failure streak");
  // The drain picks the paused backlog back up.
  const delivery = ap.buildWebhookDelivery(subscriptionId,
    { eventType: "message.posted", data: { messageId: "m-rearm-after" } });
  const summary = await ap.drainWebhookDeliveries({ fetchImpl: okFetch, now: Date.now(), dnsResolvers });
  assert.equal(summary.delivered, 1);
  const state = ap.store.db.prepare(
    "SELECT state FROM agent_webhook_deliveries WHERE delivery_id=?").get(delivery.deliveryId).state;
  assert.equal(state, "delivered");
});

test("PATCH validates input and stays identity-scoped", async (t) => {
  const { f, subscriptionId, authed, origin } = await setup(t, "patch");
  const bad = await authed(`/api/agent-webhooks/${subscriptionId}`,
    { method: "PATCH", body: JSON.stringify({ enabled: "yes" }) });
  assert.equal(bad.status, 422);
  const missing = await authed(`/api/agent-webhooks/sub_doesnotexist01`,
    { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(missing.status, 404);
  // Another identity's subscription reads as 404, never an oracle.
  const other = f.store.identities.create("autopause-patch-other");
  const crossRes = await fetch(`${origin}/api/agent-webhooks/${subscriptionId}`,
    { method: "PATCH", headers: { authorization: `Bearer ${other.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }) });
  assert.equal(crossRes.status, 404);
  // Manual pause works through the same route.
  const pause = await authed(`/api/agent-webhooks/${subscriptionId}`,
    { method: "PATCH", body: JSON.stringify({ enabled: false }) });
  assert.equal(pause.status, 200);
  assert.equal((await pause.json()).subscription.enabled, false);
  assert.equal(subRow(f, subscriptionId).enabled, 0);
});

test("GET single delivery receipt is identity-scoped", async (t) => {
  const { f, subscriptionId, authed, origin } = await setup(t, "receipt");
  const ap = f.store.agentPlugin;
  const delivery = ap.buildWebhookDelivery(subscriptionId,
    { eventType: "message.posted", data: { messageId: "m-receipt" } });
  const res = await authed(`/api/agent-webhooks/deliveries/${delivery.deliveryId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.delivery.deliveryId, delivery.deliveryId);
  assert.equal(body.delivery.subscriptionId, subscriptionId);
  assert.equal(body.delivery.state, "pending");
  const unknown = await authed(`/api/agent-webhooks/deliveries/dl_doesnotexist01`);
  assert.equal(unknown.status, 404);
  const other = f.store.identities.create("autopause-receipt-other");
  const cross = await fetch(`${origin}/api/agent-webhooks/deliveries/${delivery.deliveryId}`,
    { headers: { authorization: `Bearer ${other.secret}` } });
  assert.equal(cross.status, 404, "another identity's delivery reads as 404");
});
