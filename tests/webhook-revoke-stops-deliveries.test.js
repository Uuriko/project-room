// R282-1 (John's Tab r282, owner ask Fo): revoking an identity secret must
// stop webhook deliveries. Before the fix the subscription stayed enabled,
// fanoutRoomEvent kept journaling message.posted deliveries to the URL the
// agent chose, and the revoked secret could not even unsubscribe (401), so
// room message bodies kept leaving after the leak response. deliverWakePing
// had the same gap. The revoke path already kills the identity's scoped API
// keys; its webhook subscriptions must die with it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { initialRoom } from "../server/bootstrap.mjs";
import { AccessRequests, accessRequestSchema } from "../server/access-requests.mjs";
import { createRateLimiter } from "../server/identity-ratelimit.mjs";
import { installFakeWebhookDns } from "./helpers/fake-webhook-dns.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "webhook-revoke-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const agent = store.identities.create("Wren");
  const request = requests.request("commons", {
    identityId: agent.identityId, displayName: "Wren",
    requestedPermissions: ["accept_work"], requestId: "ar_link"
  }, agent.secret);
  const decided = requests.decide(ownerToken, "commons", request.requestId, { decision: "approve" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, agent, ownerToken, memberId: decided.memberId };
}

const post = (store, ownerToken, body) =>
  store.command(ownerToken, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body } });

const deliveries = (store, subscriptionId) =>
  store.db.prepare("SELECT count(*) AS n FROM agent_webhook_deliveries WHERE subscription_id=?").get(subscriptionId).n;

test("a revoked identity's webhook stops journaling message deliveries", t => {
  const { store, agent, ownerToken } = setup(t);
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: "https://revoke.example.test/hook", events: ["message.posted"]
  });
  post(store, ownerToken, "before revoke");
  assert.equal(deliveries(store, subscription.subscriptionId), 1, "sanity: an enabled subscription journals the owner's message");
  const revoked = store.identities.revoke(agent.identityId, agent.secret);
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.disabledWebhooks, 1, "revoke must disable the identity's webhook subscriptions");
  const row = store.db.prepare("SELECT enabled FROM agent_webhook_subs WHERE subscription_id=?").get(subscription.subscriptionId);
  assert.equal(row.enabled, 0, "the durable row must read disabled");
  post(store, ownerToken, "after revoke");
  assert.equal(deliveries(store, subscription.subscriptionId), 1, "no delivery may be journaled after the revoke");
});

test("wake pings stop after revoke, and fanout skips a stale enabled row", t => {
  const { store, agent } = setup(t);
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: "https://revoke.example.test/wake", events: ["agent.wake"]
  });
  store.identities.revoke(agent.identityId, agent.secret);
  const wake = store.agentPlugin.deliverWakePing({ identityId: agent.identityId, signal: { signalId: "s1" } });
  assert.equal(wake.deliveries.length, 0, "a revoked identity must not get wake pings");
  // Belt-and-braces: a subscription that stayed enabled despite the revoke
  // (an older build revoked the identity) must still fan out nothing.
  store.db.prepare("UPDATE agent_webhook_subs SET enabled=1 WHERE subscription_id=?").run(subscription.subscriptionId);
  const fanned = store.agentPlugin.fanoutRoomEvent({
    roomId: "commons", event: { id: randomUUID(), type: "message.posted", actorId: "m1", data: {} }
  });
  assert.equal(fanned.deliveries, 0, "fanout must skip a revoked identity's subscription even if the row is still enabled");
});
