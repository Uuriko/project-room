// Depth audit D4-2 F-1: a webhook delivery is a fan-out-time snapshot in
// agent_webhook_deliveries.payload_json. Before this cure the retry hop
// (#attemptClaimedDelivery) consulted subscription-enabled, room-seat and
// claim ownership, but never the triggering event's current state — so a
// message edited after a failed delivery was retried with its PRE-EDIT
// body verbatim, and a DELETED message's body was delivered verbatim on
// retry, to an endpoint the author had already withdrawn it from.
//
// Cure shape (D4-2 §6): the attempt hop consults the event's current
// state before POSTing. A deleted/redacted message's delivery
// dead-letters like an unsubscribed subscription's does (no POST); an
// edited message's delivery is re-snapshotted to the current body.
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

const publicDns = { resolve4: async () => ["93.184.216.34"], resolve6: async () => [] };

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "webhook-retry-state-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  installFakeWebhookDns(store);
  store.initialize(initialRoom("commons"));
  store.db.exec(accessRequestSchema);
  const requests = new AccessRequests(store, {
    rateLimiter: createRateLimiter({ capacity: 1000, refillPerSecond: 1000 })
  });
  const ownerToken = store.issueAccessKey("commons", "owner");
  const agent = store.identities.create("Hook");
  const request = requests.request("commons", {
    identityId: agent.identityId, displayName: "Hook",
    requestedPermissions: ["accept_work"], requestId: "ar_hook"
  }, agent.secret);
  requests.decide(ownerToken, "commons", request.requestId, { decision: "approve" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const { subscription } = store.agentPlugin.subscribeWebhook({
    identityId: agent.identityId, url: "https://hooks.example.test/retry-state", events: ["message.posted"]
  });
  return { store, ownerToken, subscriptionId: subscription.subscriptionId };
}

const post = (store, ownerToken, messageId, body) =>
  store.command(ownerToken, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId, body } });

const deliveryRow = (store, subscriptionId, messageId) => store.db.prepare(
  `SELECT d.* FROM agent_webhook_deliveries d WHERE d.subscription_id=?
   AND json_extract(d.payload_json,'$.data.messageId')=?`).get(subscriptionId, messageId);

function scriptedFetch(calls, status) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { status, headers: { get: () => null }, text: async () => "" };
  };
}

// Drive one failed (5xx) first attempt, then run fn(), then drain again
// after the backoff with a 2xx listener. Returns everything assertions need.
async function failThenRetry(t, { messageId, body, between }) {
  const { store, ownerToken, subscriptionId } = setup(t);
  post(store, ownerToken, messageId, body);
  const row0 = deliveryRow(store, subscriptionId, messageId);
  assert.ok(row0, "fan-out journaled a delivery for the posted message");
  const plugin = store.agentPlugin;
  const failedCalls = [];
  const t0 = Date.now() + 1000;
  const first = await plugin.drainWebhookDeliveries({
    fetchImpl: scriptedFetch(failedCalls, 500), now: t0, dnsResolvers: publicDns });
  assert.equal(first.retried, 1, "the 5xx first attempt is scheduled for retry");
  assert.equal(failedCalls.length, 1, "sanity: the first attempt did POST the snapshot");
  between(store, ownerToken);
  const retryCalls = [];
  const second = await plugin.drainWebhookDeliveries({
    fetchImpl: scriptedFetch(retryCalls, 200), now: t0 + 60_000, dnsResolvers: publicDns });
  const row = deliveryRow(store, subscriptionId, messageId);
  return { second, retryCalls, row };
}

test("retry after edit delivers the current (edited) body, never the pre-edit snapshot", async t => {
  const { second, retryCalls, row } = await failThenRetry(t, {
    messageId: "retry-edit-1",
    body: "D42CANARY-BODY-2 pre-edit text",
    between: (store, ownerToken) => store.command(ownerToken, "commons",
      { id: randomUUID(), type: T.MESSAGE_EDITED,
        data: { messageId: "retry-edit-1", body: "edited replacement, canary removed", expectedMessageRevision: 0 } }),
  });
  assert.equal(second.delivered, 1, "the retry still delivers — with current state");
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].data.body, "edited replacement, canary removed",
    "the retried payload is re-snapshotted from the event's current state");
  assert.ok(!JSON.stringify(retryCalls).includes("pre-edit text"),
    "the withdrawn pre-edit body must not leave on the retry");
  assert.equal(row.state, "delivered");
});

test("retry after delete dead-letters with no POST, like an unsubscribed subscription", async t => {
  const { second, retryCalls, row } = await failThenRetry(t, {
    messageId: "retry-delete-1",
    body: "D42CANARY-BODY-3 to-be-deleted",
    between: (store, ownerToken) => store.command(ownerToken, "commons",
      { id: randomUUID(), type: T.MESSAGE_DELETED,
        data: { messageId: "retry-delete-1", expectedMessageRevision: 0, reason: "withdrawn" } }),
  });
  assert.equal(retryCalls.length, 0, "a deleted message's body is never POSTed on retry");
  assert.equal(second.deadLettered, 1, "the delivery dead-letters");
  assert.equal(second.delivered, 0);
  assert.equal(row.state, "dead_letter");
  assert.match(row.last_error, /deleted/);
});

test("an unedited, undeleted message retries with its original body (control)", async t => {
  const { second, retryCalls, row } = await failThenRetry(t, {
    messageId: "retry-control-1",
    body: "unchanged body",
    between: () => {},
  });
  assert.equal(second.delivered, 1);
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].data.body, "unchanged body");
  assert.equal(row.state, "delivered");
});
