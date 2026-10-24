// FIX-3778 (ruling on #3778, Lane C1): registering a wakeUrl IS a
// subscription. A wakeUrl-only host used to receive no wake ping at all:
// deliverWakePing journaled wakeUrl rows only as an adjunct to an existing
// subscription delivery. Registration now ensures an agent.wake webhook
// subscription at the wakeUrl through subscribeWebhook (origin
// "wake-auto"), the duplicate rule keeps exactly one POST per
// (signal, URL), and lifecycle changes disable only auto-created
// subscriptions. These tests pin the FIX-3778 charter's acceptance tests
// (1)-(6); (7) is the existing wake suites staying green.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { verifyDeliverySignature } from "../server/webhook-dispatch.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

const WAKE_A = "https://a.example.test/wake";
const WAKE_B = "https://b.example.test/wake";
const HOOK_C = "https://c.example.test/hook";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "wake-auto-sub-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  store.initialize(initialRoom("commons"));
  const agent = store.identities.create("Wake agent");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, agent };
}

const beat = (store, agent, hostId, wakeUrl, mode = "wakeable") =>
  store.agentHeartbeats.heartbeat({ agentId: agent.identityId, hostId, mode, wakeUrl });

const subs = (store, agentId) => store.db.prepare(
  "SELECT subscription_id AS id, url, events_json AS eventsJson, enabled, origin FROM agent_webhook_subs WHERE agent_id=? ORDER BY url")
  .all(agentId).map(row => ({ ...row, events: JSON.parse(row.eventsJson) }));

const deliveries = (store, agentId) => store.db.prepare(
  `SELECT d.delivery_id AS deliveryId, d.signature, d.created_at AS createdAt, d.payload_json AS payloadJson,
     COALESCE(d.target_url, s.url) AS targetUrl, s.secret
   FROM agent_webhook_deliveries d JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id
   WHERE d.agent_id=? AND d.event_type='agent.wake' ORDER BY d.created_at`).all(agentId);

// A mention's fan-out, exactly as store.command runs it: enqueue the
// durable signal, then journal the wake ping's deliveries.
let wakeCounter = 0;
const wake = (store, agent) => {
  const { signal } = store.agentHeartbeats.wakeIfOffline({
    agentId: agent.identityId, kind: "mention", roomId: "commons",
    messageId: `mention-${++wakeCounter}`,
  });
  assert.ok(signal, "a registered host gets a durable wake signal");
  return store.agentPlugin.deliverWakePing({ identityId: agent.identityId, signal });
};

const disableSub = (store, agent, subscriptionId) => {
  store.agentPlugin.webhooks.setEnabled(subscriptionId, { agentId: agent.identityId, enabled: false });
  store.db.prepare("UPDATE agent_webhook_subs SET enabled=0 WHERE subscription_id=?").run(subscriptionId);
  store.agentPlugin.subs.get(subscriptionId).enabled = false;
};

test("(1) wakeUrl-only identity: registration auto-subscribes and a mention journals exactly one signed delivery at the wakeUrl", t => {
  const { store, agent } = setup(t);
  beat(store, agent, "host-1", WAKE_A);
  const created = subs(store, agent.identityId);
  assert.equal(created.length, 1, "one auto subscription is created");
  assert.equal(created[0].url, WAKE_A);
  assert.deepEqual(created[0].events, ["agent.wake"]);
  assert.equal(created[0].origin, "wake-auto");
  assert.equal(created[0].enabled, 1);

  const result = wake(store, agent);
  assert.equal(result.deliveries.length, 1, "exactly one journaled delivery");
  const rows = deliveries(store, agent.identityId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].targetUrl, WAKE_A);
  const envelope = JSON.parse(rows[0].payloadJson);
  // The envelope renders issuedAt as ISO; signing used the integer ms
  // stamp the row was created with (buildWebhookDelivery's issuedAt).
  assert.equal(verifyDeliverySignature(rows[0].secret, rows[0].signature, {
    deliveryId: envelope.deliveryId, eventType: envelope.eventType,
    issuedAt: rows[0].createdAt, data: envelope.data,
  }), true, "the delivery signature verifies with the subscription secret");
});

test("(2) a pre-existing agent.wake subscription at a different URL and the wakeUrl each receive exactly one delivery", t => {
  const { store, agent } = setup(t);
  store.agentPlugin.subscribeWebhook({ identityId: agent.identityId, url: HOOK_C, events: ["agent.wake"] });
  beat(store, agent, "host-1", WAKE_A);
  assert.equal(subs(store, agent.identityId).length, 2, "agent sub plus auto sub");
  const result = wake(store, agent);
  assert.equal(result.deliveries.length, 2, "no adjunct duplicate for the wakeUrl");
  assert.deepEqual(deliveries(store, agent.identityId).map(row => row.targetUrl).sort(), [WAKE_A, HOOK_C].sort());
});

test("(2b) an agent subscription at the wakeUrl itself covering agent.wake blocks auto-creation and delivers once", t => {
  const { store, agent } = setup(t);
  store.agentPlugin.subscribeWebhook({ identityId: agent.identityId, url: WAKE_A, events: ["agent.wake"] });
  beat(store, agent, "host-1", WAKE_A);
  const all = subs(store, agent.identityId);
  assert.equal(all.length, 1, "no second subscription at the same URL");
  assert.equal(all[0].origin, "agent");
  const result = wake(store, agent);
  assert.equal(result.deliveries.length, 1, "exactly one POST per (signal, URL)");
  assert.equal(deliveries(store, agent.identityId)[0].targetUrl, WAKE_A);
});

test("(3) re-registering the same wakeUrl creates no second subscription and no duplicate delivery", t => {
  const { store, agent } = setup(t);
  beat(store, agent, "host-1", WAKE_A);
  beat(store, agent, "host-1", WAKE_A);
  beat(store, agent, "host-2", WAKE_A);
  assert.equal(subs(store, agent.identityId).length, 1);
  const result = wake(store, agent);
  assert.equal(result.deliveries.length, 1);
  assert.equal(deliveries(store, agent.identityId).length, 1);
});

test("(4) wakeUrl change A->B moves delivery to B; pull-only stops POSTs; a URL still used by another host stays live", t => {
  const { store, agent } = setup(t);
  beat(store, agent, "host-1", WAKE_A);
  beat(store, agent, "host-2", WAKE_A);
  beat(store, agent, "host-1", WAKE_B);
  const byUrl = new Map(subs(store, agent.identityId).map(row => [row.url, row]));
  assert.equal(byUrl.get(WAKE_A).enabled, 1, "host-2 still uses A, so A's auto subscription stays enabled");
  assert.equal(byUrl.get(WAKE_B).enabled, 1);
  beat(store, agent, "host-2", null);
  assert.equal(subs(store, agent.identityId).find(row => row.url === WAKE_A).enabled, 0,
    "once no host uses A, its auto subscription is disabled");

  const moved = wake(store, agent);
  assert.deepEqual(deliveries(store, agent.identityId).map(row => row.targetUrl), [WAKE_B],
    "after the change only B receives the wake");
  assert.equal(moved.deliveries.length, 1);

  beat(store, agent, "host-1", null, "pull-only");
  assert.equal(subs(store, agent.identityId).find(row => row.url === WAKE_B).enabled, 0,
    "switching to pull-only disables the auto subscription");
  const stopped = wake(store, agent);
  assert.equal(stopped.deliveries.length, 0, "pull-only hosts receive no POSTs");
});

test("(5) a revoked identity receives no delivery and registering after revoke creates no subscription", t => {
  const { store, agent } = setup(t);
  beat(store, agent, "host-1", WAKE_A);
  store.identities.revoke(agent.identityId, agent.secret);
  const result = wake(store, agent);
  assert.equal(result.deliveries.length, 0);
  assert.equal(deliveries(store, agent.identityId).length, 0);
  beat(store, agent, "host-1", WAKE_B);
  assert.equal(subs(store, agent.identityId).filter(row => row.url === WAKE_B).length, 0,
    "no auto subscription is created for a revoked identity");
});

test("(6) an agent-disabled auto subscription is not re-enabled by a heartbeat with no wakeUrl change; a fresh re-registration re-enables it", t => {
  const { store, agent } = setup(t);
  beat(store, agent, "host-1", WAKE_A);
  const auto = subs(store, agent.identityId)[0];
  disableSub(store, agent, auto.id);
  beat(store, agent, "host-1", WAKE_A);
  beat(store, agent, "host-2", null);
  assert.equal(subs(store, agent.identityId)[0].enabled, 0,
    "chosen behaviour: only a wakeUrl change re-runs ensure; re-reporting the same URL does not");
  const silent = wake(store, agent);
  assert.equal(silent.deliveries.length, 0, "a disabled auto subscription journals nothing");

  beat(store, agent, "host-1", null, "pull-only");
  beat(store, agent, "host-1", WAKE_A);
  assert.equal(subs(store, agent.identityId)[0].enabled, 1,
    "registering the wakeUrl again after clearing it re-enables the auto subscription");
  const rearmed = wake(store, agent);
  assert.equal(rearmed.deliveries.length, 1);
});

test("(7-lifecycle) lifecycle changes never disable an agent-created subscription, including one that adopted the auto subscription", t => {
  const { store, agent } = setup(t);
  const other = store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: HOOK_C, events: ["agent.wake"],
  }).subscription;
  beat(store, agent, "host-1", WAKE_A);
  // The agent explicitly subscribes the wakeUrl with the same event set:
  // the auto subscription is adopted as the agent's own.
  store.agentPlugin.subscribeWebhook({ identityId: agent.identityId, url: WAKE_A, events: ["agent.wake"] });
  assert.equal(subs(store, agent.identityId).find(row => row.url === WAKE_A).origin, "agent");

  beat(store, agent, "host-1", null, "pull-only");
  const after = subs(store, agent.identityId);
  assert.equal(after.find(row => row.url === WAKE_A).enabled, 1, "the adopted subscription survives the wakeUrl clear");
  assert.equal(after.find(row => row.id === other.subscriptionId).enabled, 1, "unrelated agent subscriptions are untouched");
  const result = wake(store, agent);
  assert.deepEqual(deliveries(store, agent.identityId).map(row => row.targetUrl).sort(), [WAKE_A, HOOK_C].sort());
  assert.equal(result.deliveries.length, 2);
});
