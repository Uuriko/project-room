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
// covers fan-out, and this file borrows its seating harness).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { generateKeyPair, signCard } from "../server/agent-card-signing.mjs";

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;
const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

async function startServer(t, f) {
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (origin, path, body, secret) => fetch(`${origin}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
});

// Seat a trial-seat (guest) agent through the real mint -> redeem flow.
// The member lands in guest_members only — never identity_links.
async function seatGuest(f, origin, ownerKey, name) {
  const mint = await (await post(origin, "/api/rooms/commons/guest-invites",
    { requestId: randomUUID(), guestLabel: `guest ${name}`, expectedOwnerRevision: 0, credentialTtlMs: 3600_000 },
    ownerKey)).json();
  assert.ok(mint.code, `mint returns a code: ${JSON.stringify(mint).slice(0, 200)}`);
  const identity = f.store.identities.create(name);
  const kp = generateKeyPair();
  const cardBody = { name, description: "guest wake dispatch test", capabilities: ["chat"] };
  const card = { ...cardBody, publicKey: kp.publicKey,
    signature: signCard({ agentId: identity.identityId, card: cardBody, privateKey: kp.privateKey }) };
  const redeemed = await (await post(origin, "/api/guest-invites/redeem",
    { inviteCode: mint.code, card }, identity.secret)).json();
  assert.ok(redeemed.member?.id, `redeem seats a member: ${JSON.stringify(redeemed).slice(0, 200)}`);
  return { identity, memberId: redeemed.member.id };
}

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

async function setup(t) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const ownerKey = f.store.issueAccessKey("commons", "owner");
  const guest = await seatGuest(f, origin, ownerKey, "GuestDispatch");
  const linked = f.store.identities.create("dispatch-linked");
  f.store.identities.link(ownerKey, "commons", {
    identityId: linked.identityId, memberId: "dispatch-linked", displayName: "DispatchLinked", permissions: [],
  });
  const stranger = f.store.identities.create("dispatch-stranger");
  return { f, plugin: f.store.agentPlugin, guestId: guest.identity.identityId,
    linkedId: linked.identityId, strangerId: stranger.identityId };
}

test("a guest subscription's queued delivery drains to delivered; an unseated identity's row is never selected", async t => {
  const { plugin, guestId, linkedId, strangerId } = await setup(t);
  seedDelivery(plugin, { deliveryId: "del_guest", subscriptionId: subscribe(plugin, guestId).subscriptionId, agentId: guestId });
  seedDelivery(plugin, { deliveryId: "del_linked", subscriptionId: subscribe(plugin, linkedId).subscriptionId, agentId: linkedId });
  seedDelivery(plugin, { deliveryId: "del_stranger", subscriptionId: subscribe(plugin, strangerId).subscriptionId, agentId: strangerId });

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

test("the attempt-time re-check seats guests and still fails closed for the unseated", async t => {
  const { plugin, guestId, strangerId } = await setup(t);
  seedDelivery(plugin, { deliveryId: "del_guest_direct", subscriptionId: subscribe(plugin, guestId).subscriptionId, agentId: guestId });
  seedDelivery(plugin, { deliveryId: "del_stranger_direct", subscriptionId: subscribe(plugin, strangerId).subscriptionId, agentId: strangerId });

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
