// Dispatch leg of the guest wake fix (issue #3881; bug sweep 2026-10-16
// lane 08 F-2, B7 acceptance verdict §4): #3799 made the webhook FAN-OUT
// guest-aware through the shared resolver (identity_links first,
// guest_members fallback — pinned by tests/guest-wake-resolution.test.js),
// but the two DISPATCH gates in server/agent-plugin-store.mjs kept
// consulting identity_links only:
//
//   1. the drain's due-row SELECT required an identity_links row, so a
//      queued delivery for a guest-seated identity was never selected;
//   2. #attemptClaimedDelivery's dispatch-time re-check did the same
//      lookup, so a guest row attempted anyway skip-looped forever
//      (10-minute defer, no attempt consumed, no terminal state — and
//      prune only removes delivered/dead_letter rows, so the stranded
//      rows accumulated unboundedly).
//
// Both gates now resolve through memberIdForWakeIdentity, the resolver
// the fan-out already uses. These tests pin the dispatch behavior end to
// end: a guest-seated identity's queued delivery drains to delivered, a
// link-seated control still drains, and an identity seated in NEITHER
// table still fails closed — its delivery is skipped, stays pending,
// and is delivered once the identity is seated later.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { SKIPPED_RECHECK_MS } from "../server/agent-plugin-store.mjs";

// Fake DNS so the dispatch-time SSRF guard re-validates without touching
// the network (same shape the other webhook tests inject).
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;
const ROOM = "commons";

const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });
const recordingFetch = posted => async (url, init) => {
  posted.push(init.headers["x-webhook-delivery"]);
  return ok200();
};

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}

// A linked member identity in the fixture room (identity_links seat).
function seatLinked(f, name) {
  const ownerKey = f.store.issueAccessKey(ROOM, "owner");
  const identity = f.store.identities.create(name);
  f.store.identities.link(ownerKey, ROOM, {
    identityId: identity.identityId, memberId: name, displayName: name, permissions: [],
  });
  return identity;
}

// A trial-seat (guest) identity: guest_members only, never identity_links
// (rows inserted directly, the identity-mint-capacity pattern).
function seatGuest(f, name) {
  const identity = f.store.identities.create(name);
  f.store.db.prepare(`INSERT INTO guest_invites(
      id, code_hash, room_id, tier, credential_ttl_ms, guest_label, minted_by_member_id,
      issue_request_id, created_at, redeem_by, status, redeemed_at, redeemed_by_identity_id, redeemed_member_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(`inv-${name}`, "a".repeat(64), ROOM, "contributor", 3_600_000, name, "owner",
      `req-${name}`, T0, T0 + 3_600_000, "redeemed", T0, identity.identityId, name);
  f.store.db.prepare(`INSERT INTO guest_members(member_id, room_id, guest_identity_id, tier, invite_id, created_at)
    VALUES(?,?,?,?,?,?)`)
    .run(name, ROOM, identity.identityId, "contributor", `inv-${name}`, T0);
  assert.equal(f.store.db.prepare(
    "SELECT COUNT(*) AS n FROM identity_links WHERE room_id=? AND identity_id=?")
    .get(ROOM, identity.identityId).n, 0, "trial seat has no identity_links row");
  return identity;
}

function subscribe(plugin, identityId) {
  const { subscription } = plugin.subscribeWebhook({
    identityId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "guest-dispatch-test-secret",
    roomId: ROOM,
  });
  return subscription;
}

function seedRow(plugin, { deliveryId, subscriptionId, agentId, nextAttemptAt = T0 }) {
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, room_id, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'message.posted', ?, '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
    .run(deliveryId, `idem_${deliveryId}`, subscriptionId, agentId, ROOM, nextAttemptAt, T0, T0);
}

const rowOf = (plugin, deliveryId) => plugin.db.prepare(
  "SELECT * FROM agent_webhook_deliveries WHERE delivery_id=?").get(deliveryId);

test("drain delivers a guest-seated identity's queued delivery; an unseated identity's row is left pending, unselected", async t => {
  const f = fixture(t);
  const plugin = f.store.agentPlugin;
  const guest = seatGuest(f, "dispatch-guest");
  const linked = seatLinked(f, "dispatch-linked");
  const stranger = f.store.identities.create("dispatch-stranger");

  seedRow(plugin, { deliveryId: "del_guest", subscriptionId: subscribe(plugin, guest.identityId).subscriptionId, agentId: guest.identityId, nextAttemptAt: T0 });
  seedRow(plugin, { deliveryId: "del_linked", subscriptionId: subscribe(plugin, linked.identityId).subscriptionId, agentId: linked.identityId, nextAttemptAt: T0 + 1 });
  seedRow(plugin, { deliveryId: "del_stranger", subscriptionId: subscribe(plugin, stranger.identityId).subscriptionId, agentId: stranger.identityId, nextAttemptAt: T0 + 2 });

  const posted = [];
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl: recordingFetch(posted), now: T0 + 2, dnsResolvers: publicDns,
  });

  assert.equal(summary.delivered, 2, "guest and linked deliveries both drain");
  assert.deepEqual(posted.sort(), ["del_guest", "del_linked"]);
  assert.equal(rowOf(plugin, "del_guest").state, "delivered");
  assert.equal(rowOf(plugin, "del_linked").state, "delivered");

  // Seated in neither table: fail closed. The row is not even selected,
  // so it keeps its queue position untouched and stays deliverable
  // after a later seat (pinned end to end in the re-seat test below).
  assert.equal(summary.processed, 2, "the unseated row never enters the batch");
  const strangerRow = rowOf(plugin, "del_stranger");
  assert.equal(strangerRow.state, "pending");
  assert.equal(strangerRow.next_attempt_at, T0 + 2, "unselected row is not deferred or consumed");
  assert.equal(strangerRow.claim_expires_at, null);
});

test("dispatch re-check: a guest-seated delivery attempted directly is delivered, not skip-looped", async t => {
  const f = fixture(t);
  const plugin = f.store.agentPlugin;
  const guest = seatGuest(f, "dispatch-guest-direct");
  seedRow(plugin, { deliveryId: "del_guest_direct", subscriptionId: subscribe(plugin, guest.identityId).subscriptionId, agentId: guest.identityId });

  const posted = [];
  const result = await plugin.attemptStoredDelivery(rowOf(plugin, "del_guest_direct"), {
    fetchImpl: recordingFetch(posted), now: T0, dnsResolvers: publicDns,
  });

  assert.equal(result, "delivered", "the resolver seats the guest at dispatch time");
  assert.deepEqual(posted, ["del_guest_direct"]);
  assert.equal(rowOf(plugin, "del_guest_direct").state, "delivered");
});

test("dispatch re-check stays fail-closed for an identity seated in neither table, and a later re-seat still receives the delivery", async t => {
  const f = fixture(t);
  const plugin = f.store.agentPlugin;
  const stranger = f.store.identities.create("dispatch-late-seat");
  seedRow(plugin, { deliveryId: "del_late_seat", subscriptionId: subscribe(plugin, stranger.identityId).subscriptionId, agentId: stranger.identityId });

  const posted = [];
  const fetchImpl = recordingFetch(posted);
  const result = await plugin.attemptStoredDelivery(rowOf(plugin, "del_late_seat"), {
    fetchImpl, now: T0, dnsResolvers: publicDns,
  });

  assert.equal(result, "skipped", "seated nowhere -> fail closed, not sent");
  assert.deepEqual(posted, []);
  const skipped = rowOf(plugin, "del_late_seat");
  assert.equal(skipped.state, "pending", "the delivery survives for a later seat");
  assert.equal(skipped.attempts, 0, "a re-check skip consumes no attempt");
  assert.equal(skipped.next_attempt_at, T0 + SKIPPED_RECHECK_MS, "deferred by the re-check interval");
  assert.equal(skipped.claim_expires_at, null, "the claim is released by the skip");

  // Seat the identity (link) and drain once the deferral expires: the
  // same pending row is delivered — fail-closed never meant dropped.
  const ownerKey = f.store.issueAccessKey(ROOM, "owner");
  f.store.identities.link(ownerKey, ROOM, {
    identityId: stranger.identityId, memberId: "dispatch-late-seat", displayName: "dispatch-late-seat", permissions: [],
  });
  const summary = await plugin.drainWebhookDeliveries({
    fetchImpl, now: T0 + SKIPPED_RECHECK_MS, dnsResolvers: publicDns,
  });
  assert.equal(summary.delivered, 1);
  assert.deepEqual(posted, ["del_late_seat"]);
  assert.equal(rowOf(plugin, "del_late_seat").state, "delivered");
});
