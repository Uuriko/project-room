// #3881 dispatch leg (B7 verdict §4, B4-BOARD-BATCH PR-C): #3799 made
// wake fan-out guest-aware through the shared resolver, but the
// dispatcher's own gates stayed identity_links-only:
//   (a) #attemptClaimedDelivery's re-check — a guest seat can never
//       satisfy it, so a queued guest delivery skip-looped forever
//       (10-minute defer, attempts never moved, no terminal state);
//   (b) the drain's due-row SELECT — its subscription-enabled branch
//       required an identity_links EXISTS, so guest rows were never
//       even selected for a normal drain.
// Both gates now use the resolver's seating (link OR guest seat); an
// identity seated in neither still skips, fail-closed. This is the
// dispatch-level test #3881's closure requires — it exercises drain +
// attempt, not fan-out counts (tests/guest-wake-resolution.test.js
// covers fan-out).
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

function seedDelivery(plugin, { deliveryId, subscriptionId, agentId, roomId = "commons", nextAttemptAt = T0 }) {
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, room_id, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'message.posted', ?, '{"data":{"messageId":"m1"}}', '', 'pending', 0, ?, ?, ?)`)
    .run(deliveryId, `idem_${deliveryId}`, subscriptionId, agentId, roomId, nextAttemptAt, T0, T0);
}

function subscribe(plugin, agentId) {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId, url: "https://hooks.example.test/agent",
    events: ["message.posted"], secret: "test-secret-value",
  });
  return subscription;
}

const rowOf = (plugin, deliveryId) => plugin.db.prepare(
  "SELECT * FROM agent_webhook_deliveries WHERE delivery_id=?").get(deliveryId);

function seat(plugin) {
  // A trial seat: guest_members only, never identity_links. A linked
  // member as control, and a stranger seated in neither table.
  plugin.db.prepare(`INSERT INTO guest_members
    (member_id, room_id, guest_identity_id, tier, invite_id, created_at)
    VALUES ('mem-guest', 'commons', 'guest-agent', 'contributor', 'inv-1', ?)`)
    .run(T0);
  plugin.db.prepare(`INSERT INTO identity_links (room_id, identity_id, member_id, linked_at)
    VALUES ('commons', 'linked-agent', 'mem-linked', ?)`)
    .run(T0);
}

test("a guest subscription's queued delivery drains to delivered; an unseated identity's row is never selected", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seat(plugin);
  const guestSub = subscribe(plugin, "guest-agent");
  const linkedSub = subscribe(plugin, "linked-agent");
  const strangerSub = subscribe(plugin, "stranger-agent");
  seedDelivery(plugin, { deliveryId: "del_guest", subscriptionId: guestSub.subscriptionId, agentId: "guest-agent" });
  seedDelivery(plugin, { deliveryId: "del_linked", subscriptionId: linkedSub.subscriptionId, agentId: "linked-agent" });
  seedDelivery(plugin, { deliveryId: "del_stranger", subscriptionId: strangerSub.subscriptionId, agentId: "stranger-agent" });

  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(init.headers["x-webhook-delivery"]); return ok200(); };
  const summary = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });

  assert.equal(summary.delivered, 2, "guest and linked deliveries both drain to delivered");
  assert.equal(rowOf(plugin, "del_guest").state, "delivered");
  assert.equal(rowOf(plugin, "del_linked").state, "delivered");
  assert.deepEqual(posted.sort(), ["del_guest", "del_linked"], "the unseated identity is never POSTed");
  const stranger = rowOf(plugin, "del_stranger");
  assert.equal(stranger.state, "pending", "the unseated row is not selected by the drain (gate b)");
  assert.equal(stranger.attempts, 0);
  assert.equal(stranger.next_attempt_at, T0, "…and its schedule is untouched");
});

test("the attempt-time re-check seats guests and still fails closed for the unseated", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  seat(plugin);
  const guestSub = subscribe(plugin, "guest-agent");
  const strangerSub = subscribe(plugin, "stranger-agent");
  seedDelivery(plugin, { deliveryId: "del_guest_direct", subscriptionId: guestSub.subscriptionId, agentId: "guest-agent" });
  seedDelivery(plugin, { deliveryId: "del_stranger_direct", subscriptionId: strangerSub.subscriptionId, agentId: "stranger-agent" });

  // Attempt the guest row directly (bypassing the drain SELECT): the
  // re-check (gate a) must seat the guest through guest_members.
  const guestResult = await plugin.attemptStoredDelivery(rowOf(plugin, "del_guest_direct"),
    { fetchImpl: async () => ok200(), now: T0, dnsResolvers: publicDns });
  assert.equal(guestResult, "delivered");
  assert.equal(rowOf(plugin, "del_guest_direct").state, "delivered");

  // The unseated identity still skips fail-closed: pending, no attempt
  // counted, deferred by the recheck interval — and a later seat would
  // still receive it.
  const strangerResult = await plugin.attemptStoredDelivery(rowOf(plugin, "del_stranger_direct"),
    { fetchImpl: async () => ok200(), now: T0, dnsResolvers: publicDns });
  assert.equal(strangerResult, "skipped");
  const stranger = rowOf(plugin, "del_stranger_direct");
  assert.equal(stranger.state, "pending");
  assert.equal(stranger.attempts, 0);
  assert.ok(stranger.next_attempt_at > T0, "the skip defers the next attempt instead of dropping the row");
});
