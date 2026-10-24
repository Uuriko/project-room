// #3881: webhook dispatch must honor guest (trial-seat) seating.
//
// The fan-out leg resolves subscribers through the shared guest-aware
// resolver (identity_links first, guest_members fallback — #3777), so a
// trial seat's subscription receives queued deliveries. But BOTH
// dispatch-side gates still probed identity_links only:
//   1. the drain's due-row selection excluded any delivery whose agent
//      had no identity_links row, so guest rows never entered a batch;
//   2. #attemptClaimedDelivery's dispatch-time re-check skipped any
//      delivery whose identity had no identity_links row.
// A guest seat's deliveries therefore sat pending forever — never
// delivered, never dead-lettered (the skip path just re-queues +10min).
// These tests pin the composed rule: a seat in EITHER table dispatches;
// a seat in NEITHER still fails closed (the row is not selected and
// stays pending for a later re-link).
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });
const ROOM = "room3881";

function seedRoomAndSeats(f) {
  const db = f.store.db;
  db.prepare("INSERT INTO rooms (id, sequence, projection, archived_at) VALUES (?, 0, '{}', NULL)").run(ROOM);
  const guest = f.store.identities.create("Guest 3881");
  const linked = f.store.identities.create("Linked 3881");
  const unseated = f.store.identities.create("Unseated 3881");
  // The guest seat: guest_invites + guest_members only, never identity_links.
  db.prepare(`INSERT INTO guest_invites (id, code_hash, room_id, tier, credential_ttl_ms, guest_label,
      minted_by_member_id, issue_request_id, created_at, redeem_by, status)
    VALUES ('inv_3881', ?, ?, 'contributor', 3600000, 'guest 3881', 'owner', 'req_3881', ?, ?, 'redeemed')`)
    .run("a".repeat(64), ROOM, T0, T0 + 3600000);
  db.prepare(`INSERT INTO guest_members (member_id, room_id, guest_identity_id, tier, invite_id, created_at)
    VALUES ('mem_guest3881', ?, ?, 'contributor', 'inv_3881', ?)`)
    .run(ROOM, guest.identityId, T0);
  // The linked seat: identity_links only.
  db.prepare("INSERT INTO identity_links (room_id, identity_id, member_id, linked_at) VALUES (?, ?, 'mem_linked3881', ?)")
    .run(ROOM, linked.identityId, T0);
  return { guest, linked, unseated };
}

function subscribe(plugin, agentId) {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
secret: "test-secret-3881"
  });
  return subscription;
}

function seedRow(plugin, { deliveryId, subscriptionId, agentId }) {
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, room_id, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'message.posted', ?, '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
    .run(deliveryId, `idem_${deliveryId}`, subscriptionId, agentId, ROOM, T0, T0, T0);
}

const rowOf = (plugin, deliveryId) => plugin.db.prepare(
  "SELECT state, attempts, next_attempt_at FROM agent_webhook_deliveries WHERE delivery_id=?")
  .get(deliveryId);

test("#3881: a guest-seated identity's queued delivery dispatches; an unseated one still fails closed", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const { guest, linked, unseated } = seedRoomAndSeats(f);
  seedRow(plugin, { deliveryId: "del_guest", subscriptionId: subscribe(plugin, guest.identityId).subscriptionId, agentId: guest.identityId });
  seedRow(plugin, { deliveryId: "del_linked", subscriptionId: subscribe(plugin, linked.identityId).subscriptionId, agentId: linked.identityId });
  seedRow(plugin, { deliveryId: "del_unseated", subscriptionId: subscribe(plugin, unseated.identityId).subscriptionId, agentId: unseated.identityId });

  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(init.headers["x-webhook-delivery"]); return ok200(); };
  const summary = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });

  assert.deepEqual(posted.sort(), ["del_guest", "del_linked"],
    "guest-seated and linked deliveries are both POSTed; the unseated one is not");
  assert.equal(summary.delivered, 2);
  assert.equal(rowOf(plugin, "del_guest").state, "delivered");
  assert.equal(rowOf(plugin, "del_linked").state, "delivered");
  // Fail closed preserved: the unseated row was never attempted and
  // stays pending (a later re-link can still receive it).
  const un = rowOf(plugin, "del_unseated");
  assert.equal(un.state, "pending");
  assert.equal(un.attempts, 0);
});
