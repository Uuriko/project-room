// Regression for bug sweep 2026-10-16 lane 11 F1 (#3893): the webhook
// drain loop had no per-row exception isolation.
//
// #drainWebhookDeliveriesOnce awaited attemptStoredDelivery per row with
// no guard, and attemptStoredDelivery throws deterministically on a
// stored row whose payload_json no longer parses, whose payload has no
// object data, or whose stored secret/event fails the dispatch module's
// validation — after the row is claimed but before any outcome write, so
// next_attempt_at never advanced. One such row aborted every drain batch
// at the same position forever: rows behind it in the batch were
// skipped, the webhook-dispatch job reported failure on every tick, and
// the row could never dead-letter. This is the claim-prs poison shape
// (#3495), one layer down.
//
// The fix isolates the row (the claim-prs convention, #3464): the
// attempt records the outcome itself — dead-letter for errors that are
// permanent as stored, a backed-off failed attempt otherwise — the row
// is counted and named in the drain summary's isolated items, and the
// batch moves on. These tests pin that behavior end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { backoffDelayMs } from "../server/webhook-dispatch.mjs";
import { compactSummary, summaryFailure } from "../cloudflare/job-heartbeat.mjs";

// Fake DNS so the dispatch-time SSRF guard re-validates without touching
// the network (same shape the other webhook tests inject).
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;

const ok200 = () => ({ status: 200, headers: { get: () => null }, text: async () => "ok" });

function seedRow(plugin, { deliveryId, subscriptionId, agentId, payloadJson = "{\"data\":{}}",
  eventType = "message.posted", nextAttemptAt = T0 }) {
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '', 'pending', 0, ?, ?, ?)`)
    .run(deliveryId, `idem_${deliveryId}`, subscriptionId, agentId, eventType,
      payloadJson, nextAttemptAt, T0, T0);
}

function subscribe(plugin, agentId) {
  const { subscription } = plugin.subscribeWebhook({
    identityId: agentId,
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "test-secret-value",
  });
  return subscription;
}

const rowOf = (plugin, deliveryId) => plugin.db.prepare(
  "SELECT state, attempts, next_attempt_at, claim_expires_at, last_error FROM agent_webhook_deliveries WHERE delivery_id=?")
  .get(deliveryId);

test("a poison row amid good rows drains the good ones and dead-letters the poison", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_poison_batch");
  // The poison row sits in the middle of the batch (due order is
  // next_attempt_at ASC): rows behind it must still drain.
  seedRow(plugin, { deliveryId: "del_good_head", subscriptionId: sub.subscriptionId, agentId: "agent_poison_batch", nextAttemptAt: T0 });
  seedRow(plugin, { deliveryId: "del_poison", subscriptionId: sub.subscriptionId, agentId: "agent_poison_batch",
    payloadJson: "{not json", nextAttemptAt: T0 + 1 });
  seedRow(plugin, { deliveryId: "del_good_tail", subscriptionId: sub.subscriptionId, agentId: "agent_poison_batch", nextAttemptAt: T0 + 2 });

  const posted = [];
  const fetchImpl = async (url, init) => { posted.push(init.headers["x-webhook-delivery"]); return ok200(); };
  const summary = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0 + 2, dnsResolvers: publicDns });

  assert.equal(summary.processed, 3);
  assert.equal(summary.delivered, 2, "both good rows deliver despite the poison between them");
  assert.equal(summary.deadLettered, 1);
  assert.equal(summary.retried, 0);
  assert.deepEqual(posted.sort(), ["del_good_head", "del_good_tail"], "the poison row is never POSTed");

  // The row is counted and named, claim-prs style.
  assert.equal(summary.isolated, 1);
  assert.equal(summary.isolatedItems.length, 1);
  assert.equal(summary.isolatedItems[0].deliveryId, "del_poison");
  assert.equal(typeof summary.isolatedItems[0].error, "string");

  // The numeric count survives compactSummary into the job heartbeat,
  // and the tick is NOT a failed tick: an isolated row is a successful
  // drain that stepped over poison, not a job failure.
  assert.equal(compactSummary(summary).isolated, 1);
  assert.equal(summaryFailure(summary), null);

  const poison = rowOf(plugin, "del_poison");
  assert.equal(poison.state, "dead_letter");
  assert.equal(poison.attempts, 1);
  assert.equal(poison.claim_expires_at, null, "the claim is released by the outcome write");
  assert.match(poison.last_error, /^stored delivery cannot be attempted: /);
});

test("stored payloads without an object data dead-letter on the first attempt", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_poison_data");
  seedRow(plugin, { deliveryId: "del_no_data", subscriptionId: sub.subscriptionId, agentId: "agent_poison_data",
    payloadJson: "{\"note\":\"no data field\"}", nextAttemptAt: T0 });
  seedRow(plugin, { deliveryId: "del_null_payload", subscriptionId: sub.subscriptionId, agentId: "agent_poison_data",
    payloadJson: "null", nextAttemptAt: T0 + 1 });

  let calls = 0;
  const fetchImpl = async () => { calls++; return ok200(); };
  const summary = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0 + 1, dnsResolvers: publicDns });

  assert.equal(calls, 0, "neither row reaches the POST");
  assert.equal(summary.deadLettered, 2);
  assert.equal(summary.isolated, 2);
  for (const id of ["del_no_data", "del_null_payload"]) {
    const row = rowOf(plugin, id);
    assert.equal(row.state, "dead_letter");
    assert.match(row.last_error, /stored delivery cannot be attempted: .*data must be an object/);
  }
});

test("a stored row failing dispatch validation (empty event_type) dead-letters", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_poison_event");
  seedRow(plugin, { deliveryId: "del_bad_event", subscriptionId: sub.subscriptionId, agentId: "agent_poison_event",
    eventType: "", nextAttemptAt: T0 });

  const summary = await plugin.drainWebhookDeliveries({ fetchImpl: async () => ok200(), now: T0, dnsResolvers: publicDns });

  assert.equal(summary.deadLettered, 1);
  assert.equal(summary.isolated, 1);
  const row = rowOf(plugin, "del_bad_event");
  assert.equal(row.state, "dead_letter");
  assert.match(row.last_error, /stored delivery cannot be attempted: .*eventType must be a non-empty string/);
});

test("repeated ticks do not re-wedge: an isolated row stays out of later drains", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_poison_repeat");
  seedRow(plugin, { deliveryId: "del_poison_once", subscriptionId: sub.subscriptionId, agentId: "agent_poison_repeat",
    payloadJson: "{broken", nextAttemptAt: T0 });

  const fetchImpl = async () => ok200();
  const first = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0, dnsResolvers: publicDns });
  assert.equal(first.isolated, 1);
  assert.equal(first.deadLettered, 1);

  // A later drain sees nothing to do: the dead-lettered row is terminal,
  // so it is never re-selected, never re-counted, never re-named.
  const second = await plugin.drainWebhookDeliveries({ fetchImpl, now: T0 + 60_000, dnsResolvers: publicDns });
  assert.equal(second.processed, 0);
  assert.equal(second.isolated, undefined, "the summary only carries isolated when a row was isolated");
  assert.equal(second.isolatedItems, undefined);
  assert.equal(summaryFailure(second), null);
});

test("a transient throw during an attempt is a backed-off failed attempt, and the row recovers", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_transient");
  seedRow(plugin, { deliveryId: "del_transient", subscriptionId: sub.subscriptionId, agentId: "agent_transient", nextAttemptAt: T0 });

  // Fault injection: the subscription cache throws once, mid-attempt,
  // after the row is claimed. Not a stored-data error, so the row must
  // get the ordinary retry discipline, not a dead letter.
  const realGet = plugin.subs.get.bind(plugin.subs);
  let armed = true;
  plugin.subs.get = id => {
    if (armed && id === sub.subscriptionId) { armed = false; throw new Error("subscription cache exploded"); }
    return realGet(id);
  };
  let summary;
  try {
    summary = await plugin.drainWebhookDeliveries({ fetchImpl: async () => ok200(), now: T0, dnsResolvers: publicDns });
  } finally {
    delete plugin.subs.get;
  }

  assert.equal(summary.retried, 1);
  assert.equal(summary.deadLettered, 0);
  assert.equal(summary.isolated, 1, "the row is still counted and named");
  assert.equal(summary.isolatedItems[0].deliveryId, "del_transient");
  const failed = rowOf(plugin, "del_transient");
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal(failed.claim_expires_at, null, "the claim is released so the retry can be claimed");
  assert.equal(failed.next_attempt_at, T0 + backoffDelayMs(1), "the retry waits out the backoff");
  assert.match(failed.last_error, /delivery attempt failed before dispatch: subscription cache exploded/);

  // After the backoff the same row delivers normally.
  const recovered = await plugin.drainWebhookDeliveries({
    fetchImpl: async () => ok200(), now: T0 + backoffDelayMs(1), dnsResolvers: publicDns,
  });
  assert.equal(recovered.delivered, 1);
  assert.equal(recovered.isolated, undefined);
  assert.equal(rowOf(plugin, "del_transient").state, "delivered");
});

test("a throw before the claim completes is isolated by the drain loop and retried next drain", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const sub = subscribe(plugin, "agent_claim_boom");
  seedRow(plugin, { deliveryId: "del_claim_boom", subscriptionId: sub.subscriptionId, agentId: "agent_claim_boom", nextAttemptAt: T0 });
  seedRow(plugin, { deliveryId: "del_claim_fine", subscriptionId: sub.subscriptionId, agentId: "agent_claim_boom", nextAttemptAt: T0 + 1 });

  // Fault injection: the claim itself throws for one row (the claim
  // transaction failing is the one throw the attempt layer cannot
  // record an outcome for — the drain loop's guard owns it).
  const realClaim = plugin.claimWebhookDelivery.bind(plugin);
  plugin.claimWebhookDelivery = (row, now) => {
    if (row.delivery_id === "del_claim_boom") throw new Error("claim store unavailable");
    return realClaim(row, now);
  };
  let summary;
  try {
    summary = await plugin.drainWebhookDeliveries({ fetchImpl: async () => ok200(), now: T0 + 1, dnsResolvers: publicDns });
  } finally {
    delete plugin.claimWebhookDelivery;
  }

  assert.equal(summary.delivered, 1, "the healthy row behind it still drains");
  assert.equal(summary.isolated, 1);
  assert.equal(summary.isolatedItems[0].deliveryId, "del_claim_boom");
  assert.match(summary.isolatedItems[0].error, /claim store unavailable/);
  const stuck = rowOf(plugin, "del_claim_boom");
  assert.equal(stuck.state, "pending", "no outcome was written, so the row keeps its queue position");
  assert.equal(stuck.attempts, 0);
  assert.equal(stuck.next_attempt_at, T0);

  const next = await plugin.drainWebhookDeliveries({ fetchImpl: async () => ok200(), now: T0 + 1, dnsResolvers: publicDns });
  assert.equal(next.delivered, 1, "the next drain delivers it once the claim works again");
  assert.equal(next.isolated, undefined);
});
