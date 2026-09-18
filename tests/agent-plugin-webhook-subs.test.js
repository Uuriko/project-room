import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentWebhookSubscriptions, signPayload, verifySignature, WebhookSubscriptionError,
} from "../server/agent-webhook-subscriptions.mjs";

const fresh = () => createAgentWebhookSubscriptions({ clock: () => 1_700_000_000_000 });
const SECRET = "signing-secret-0123456789";
const SUB = { subscriptionId: "sub_one", agentId: "ai_agent1", url: "https://agents.example/hook", events: ["thread.created", "mention.added"], secret: SECRET };

test("subscribe validates, stores no secret on the view, and dedups events", t => {
  const subs = fresh();
  const view = subs.subscribe(SUB);
  assert.equal(view.subscriptionId, "sub_one");
  assert.equal(view.agentId, "ai_agent1");
  assert.deepEqual([...view.events], ["thread.created", "mention.added"]);
  assert.equal(view.enabled, true);
  assert.equal(view.createdAt, 1_700_000_000_000);
  assert.ok(!("secret" in view));
  assert.ok(Object.isFrozen(view));

  const own = subs.forAgent("ai_agent1");
  assert.equal(own.length, 1);
  assert.equal(subs.forAgent("ai_other").length, 0);

  // duplicates rejected
  assert.throws(() => subs.subscribe(SUB), WebhookSubscriptionError);
  // validation
  assert.throws(() => subs.subscribe({ ...SUB, subscriptionId: "s2", url: "http://x.example" }), WebhookSubscriptionError);
  assert.throws(() => subs.subscribe({ ...SUB, subscriptionId: "s2", secret: "short" }), WebhookSubscriptionError);
  assert.throws(() => subs.subscribe({ ...SUB, subscriptionId: "s2", events: [] }), WebhookSubscriptionError);
  assert.throws(() => subs.subscribe({ ...SUB, subscriptionId: "s2", agentId: "BAD ID" }), WebhookSubscriptionError);
});

test("match supports wildcard and honors enabled flag", t => {
  const subs = fresh();
  subs.subscribe({ ...SUB });
  subs.subscribe({ subscriptionId: "sub_all", agentId: "ai_agent1", url: "https://agents.example/all",
    events: ["*"], secret: SECRET });
  subs.subscribe({ subscriptionId: "sub_off", agentId: "ai_agent1", url: "https://agents.example/off",
    events: ["thread.created"], secret: SECRET });
  subs.setEnabled("sub_off", { agentId: "ai_agent1", enabled: false });
  const matched = subs.match("ai_agent1", "thread.created").map(s => s.subscriptionId).sort();
  assert.deepEqual(matched, ["sub_all", "sub_one"]);
  const none = subs.match("ai_agent1", "work.completed");
  assert.deepEqual(none.map(s => s.subscriptionId), ["sub_all"]);
  assert.throws(() => subs.match("", "thread.created"), WebhookSubscriptionError);
});

test("ownership: agents cannot touch other agents' subscriptions", t => {
  const subs = fresh();
  subs.subscribe({ ...SUB });
  assert.throws(() => subs.unsubscribe("sub_one", { agentId: "ai_other" }), /access_denied/);
  assert.throws(() => subs.setEnabled("sub_one", { agentId: "ai_other", enabled: false }), /access_denied/);
  assert.throws(() => subs.setEnabled("sub_one", { agentId: "ai_agent1", enabled: "yes" }), WebhookSubscriptionError);
  assert.throws(() => subs.unsubscribe("sub_missing", { agentId: "ai_agent1" }), WebhookSubscriptionError);
  const gone = subs.unsubscribe("sub_one", { agentId: "ai_agent1" });
  assert.deepEqual(gone, { subscriptionId: "sub_one", unsubscribed: true });
  assert.equal(subs.forAgent("ai_agent1").length, 0);
});

test("buildDelivery signs payloads; journal records attempts", t => {
  const subs = fresh();
  subs.subscribe({ ...SUB });
  const delivery = subs.buildDelivery("sub_one", { eventType: "thread.created", data: { threadId: "t1" } });
  assert.equal(delivery.state, "pending");
  assert.equal(delivery.attempts, 0);
  assert.equal(delivery.agentId, "ai_agent1");
  assert.ok(Object.isFrozen(delivery) && Object.isFrozen(delivery.data));
  assert.ok(delivery.signature && delivery.signature.length === 64);

  // the agent verifies the delivery with its own secret
  assert.ok(verifySignature(SECRET, delivery.signature, { eventType: "thread.created", data: { threadId: "t1" } }));
  assert.ok(!verifySignature(SECRET, delivery.signature, { eventType: "thread.created", data: { threadId: "t2" } }));
  assert.ok(!verifySignature("wrong-secret-0123456789", delivery.signature, { eventType: "thread.created", data: { threadId: "t1" } }));

  const r1 = subs.recordAttempt(delivery.deliveryId, { ok: true });
  assert.equal(r1.state, "delivered");
  assert.equal(r1.attempts, 1);

  const d2 = subs.buildDelivery("sub_one", { eventType: "mention.added", data: {} });
  subs.recordAttempt(d2.deliveryId, { ok: false, error: "connection refused" });
  const journal = subs.journal("sub_one");
  assert.equal(journal.length, 2);
  assert.equal(journal[1].state, "failed");
  assert.equal(journal[1].error, "connection refused");
  assert.ok(journal.every(j => !("signature" in j))); // journal carries no secrets
  assert.throws(() => subs.buildDelivery("sub_missing", { eventType: "x", data: {} }), WebhookSubscriptionError);
  assert.throws(() => subs.recordAttempt("del_missing", { ok: true }), /unknown delivery/);
});

test("signPayload/verifySignature are timing-safe and strict", t => {
  const sig = signPayload(SECRET, { eventType: "e", data: { a: 1 } });
  assert.ok(verifySignature(SECRET, sig, { eventType: "e", data: { a: 1 } }));
  assert.ok(!verifySignature(SECRET, sig, { eventType: "e", data: { a: 2 } }));
  assert.ok(!verifySignature(SECRET, "00", { eventType: "e", data: { a: 1 } }));
  assert.ok(!verifySignature(SECRET, "", { eventType: "e", data: { a: 1 } }));
  assert.ok(!verifySignature("", sig, { eventType: "e", data: { a: 1 } }));
  assert.ok(!verifySignature(null, sig, { eventType: "e", data: { a: 1 } }));
  assert.throws(() => signPayload("", { eventType: "e", data: {} }), WebhookSubscriptionError);
});
