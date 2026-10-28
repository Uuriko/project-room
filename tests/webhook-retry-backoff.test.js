// Hardening for the webhook retry scheduler (QA200-MUT-18 probe C).
//
// The retry discipline is "back off, never hammer": a retryable outcome
// (429/5xx) must reschedule the delivery at now + backoffDelayMs(attempts),
// not immediately. A mutant that set next_attempt_at = now (retry hammer,
// no backoff on 429) passed the whole suite uncaught — the only backoff
// coverage was the pure backoffDelayMs arithmetic, never its presence on
// the retry path. This test pins the scheduling behavior end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { backoffDelayMs } from "../server/webhook-dispatch.mjs";

// Fake DNS so the dispatch-time SSRF guard re-validates without touching
// the network (same shape the webhook-dispatch tests inject).
const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };
const T0 = 1_700_000_000_000;

test("a 429 retry reschedules with backoff, never immediately", async () => {
  const f = createAcceptanceFixture();
  const plugin = f.store.agentPlugin;
  const { subscription } = plugin.subscribeWebhook({
    identityId: "agent_backoff",
    url: "https://hooks.example.test/agent",
    events: ["message.posted"],
    secret: "test-secret-0123456789abcdef",
  });
  // One pending delivery, due now, with no room link to re-check.
  plugin.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json,
     signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES ('del_backoff1', 'idem_backoff1', ?, 'agent_backoff', 'message.posted',
     '{"data":{}}', '', 'pending', 0, ?, ?, ?)`)
    .run(subscription.subscriptionId, T0, T0, T0);

  const fetch429 = async () => ({ status: 429, headers: { get: () => null }, text: async () => "slow down" });
  const summary = await plugin.drainWebhookDeliveries({ fetchImpl: fetch429, now: T0, dnsResolvers: publicDns });
  assert.equal(summary.retried, 1, "the 429 delivery is retried, not dead-lettered");

  const row = plugin.db
    .prepare("SELECT state, attempts, next_attempt_at FROM agent_webhook_deliveries WHERE delivery_id='del_backoff1'")
    .get();
  assert.equal(row.state, "failed");
  assert.equal(row.attempts, 1);
  // The hammer mutant scheduled the retry at T0 (immediately). The
  // discipline is exponential backoff from the attempt count.
  assert.equal(row.next_attempt_at, T0 + backoffDelayMs(1),
    "a retryable failure must wait out the backoff before the next attempt");

  // And the drain must not pick it back up before the backoff elapses.
  const immediate = await plugin.drainWebhookDeliveries({ fetchImpl: fetch429, now: T0 + 1, dnsResolvers: publicDns });
  assert.equal(immediate.processed, 0, "no redelivery until the backoff expires");
});
