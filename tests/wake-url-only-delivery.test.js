// #3778: a wakeUrl-only host never received a wake ping. deliverWakePing
// built subscription deliveries first and ran the wakeUrl fan-out only
// as an adjunct to a subscription delivery (journaled ON the first
// subscription, signed with that subscription's secret), so an identity
// that registered a wakeUrl through POST /api/agent-heartbeats or the
// MCP wake_register tool — whose entire contract is the wakeUrl — but
// held no agent-webhook subscription got no delivery journaled at all,
// while wakeStatusOf still reported it wakeable.
//
// The fix: when no subscription delivery exists but wakeable hosts have
// registered wakeUrls, deliverWakePing ensures a dedicated agent.wake
// carrier subscription for the identity (created on the first such
// wake, url = the first wakeUrl, secret generated server-side like any
// subscription secret) and journals one signed delivery per distinct
// wakeUrl on it. The with-subscription adjunct path is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "wake-url-only-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const wakeRows = (store, identityId) => store.db.prepare(
  `SELECT d.event_id, d.event_type, d.state, d.signature,
          COALESCE(d.target_url, s.url) AS target_url, s.events_json
   FROM agent_webhook_deliveries d
   JOIN agent_webhook_subs s ON s.subscription_id = d.subscription_id
   WHERE d.agent_id = ? AND d.event_type = 'agent.wake'`).all(identityId);

const subCount = (store, identityId) => store.db.prepare(
  "SELECT count(*) AS n FROM agent_webhook_subs WHERE agent_id = ?").get(identityId).n;

test("wakeUrl-only identity: a wake ping is journaled to the registered wakeUrl", t => {
  const store = setup(t);
  const agent = store.identities.create("Wren Wakeonly");
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "wren-host", mode: "wakeable",
    wakeUrl: "https://wu.example.test/wake"
  });
  assert.equal(subCount(store, agent.identityId), 0, "premise: no webhook subscription exists");

  const result = store.agentPlugin.deliverWakePing({
    identityId: agent.identityId, signal: { signalId: "sig-wakeonly-1" }
  });
  assert.equal(result.deliveries.length, 1, "exactly one delivery is journaled for the wakeUrl");
  const rows = wakeRows(store, agent.identityId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_url, "https://wu.example.test/wake");
  assert.equal(rows[0].event_id, "sig-wakeonly-1");
  assert.equal(rows[0].state, "pending");
  assert.ok(rows[0].signature, "the delivery is signed (carrier subscription secret)");
  assert.deepEqual(JSON.parse(rows[0].events_json), ["agent.wake"],
    "the carrier subscription listens only for agent.wake, never room events");

  // Idempotency: replaying the same signal journals no second delivery.
  const replay = store.agentPlugin.deliverWakePing({
    identityId: agent.identityId, signal: { signalId: "sig-wakeonly-1" }
  });
  assert.equal(wakeRows(store, agent.identityId).length, 1, "same signal, still one delivery");
  void replay;
});

test("wakeUrl-only identity with two hosts: one delivery per distinct wakeUrl", t => {
  const store = setup(t);
  const agent = store.identities.create("Multi Host");
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "host-a", mode: "wakeable",
    wakeUrl: "https://a.example.test/wake"
  });
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "host-b", mode: "wakeable",
    wakeUrl: "https://b.example.test/wake"
  });
  const result = store.agentPlugin.deliverWakePing({
    identityId: agent.identityId, signal: { signalId: "sig-multi-1" }
  });
  assert.equal(result.deliveries.length, 2);
  assert.deepEqual(wakeRows(store, agent.identityId).map(r => r.target_url).sort(),
    ["https://a.example.test/wake", "https://b.example.test/wake"]);
});

test("with a subscription, the adjunct path is unchanged and no carrier is created", t => {
  const store = setup(t);
  const agent = store.identities.create("Has Sub");
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "sub-host", mode: "wakeable",
    wakeUrl: "https://wu2.example.test/wake"
  });
  store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: "https://hooks.example.test/agent", events: ["agent.wake"]
  });
  const result = store.agentPlugin.deliverWakePing({
    identityId: agent.identityId, signal: { signalId: "sig-sub-1" }
  });
  assert.equal(result.deliveries.length, 2, "subscription URL plus wakeUrl, as before");
  assert.equal(subCount(store, agent.identityId), 1, "no carrier subscription is added");
  assert.deepEqual(wakeRows(store, agent.identityId).map(r => r.target_url).sort(),
    ["https://hooks.example.test/agent", "https://wu2.example.test/wake"]);
});

test("no wakeUrl and no subscription: still no delivery (heartbeat queue carries it)", t => {
  const store = setup(t);
  const agent = store.identities.create("Poll Only");
  store.agentHeartbeats.heartbeat({
    agentId: agent.identityId, hostId: "poll-host", mode: "wakeable"
  });
  const result = store.agentPlugin.deliverWakePing({
    identityId: agent.identityId, signal: { signalId: "sig-poll-1" }
  });
  assert.equal(result.deliveries.length, 0);
  assert.equal(subCount(store, agent.identityId), 0, "no carrier is created without a wakeUrl");
});
