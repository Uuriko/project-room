// UFO-steal slice 2 (RC-2026-09-27-2729): sentinel-swapped secrets for
// webhook subscription signing secrets.
//
// Contract under test: an agent never holds a raw signing secret. Every
// agent-visible read carries only the opaque sentinel
// `pr_sentinel_<subscriptionId>`; the single trusted boundary
// (resolveSentinel) swaps it for the real value at dispatch/verify time,
// server-side; unknown sentinels fail closed. The dispatch path signs
// with the real value; server-side verification answers valid/invalid.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentWebhookSubscriptions, signPayload, verifySignature, WebhookSubscriptionError,
} from "../server/agent-webhook-subscriptions.mjs";

const fresh = () => createAgentWebhookSubscriptions({ clock: () => 1_700_000_000_000 });
const SECRET = "signing-secret-0123456789";
// The sentinel format is a user-facing handle contract: hardcode the
// literal prefix, not the module's own helper, so the test fails if the
// format changes.
const sentinel = subscriptionId => `pr_sentinel_${subscriptionId}`;
const SUB = { subscriptionId: "sub_one", agentId: "ai_agent1",
  url: "https://agents.example/hook", events: ["message.posted"], secret: SECRET };

test("subscribe view carries the sentinel handle, never the raw secret", () => {
  const subs = fresh();
  const view = subs.subscribe(SUB);
  assert.equal(view.secretRef, sentinel("sub_one"));
  assert.ok(!("secret" in view), "no raw secret key on the agent-visible view");
  assert.ok(!JSON.stringify(view).includes(SECRET), "raw value absent from the view JSON");
});

test("agent-visible reads (list, match, journal) return the sentinel only", () => {
  const subs = fresh();
  subs.subscribe(SUB);
  const viewPayloads = [
    subs.forAgent("ai_agent1"),
    subs.match("ai_agent1", "message.posted"),
  ];
  subs.buildDelivery("sub_one", { eventType: "message.posted", data: { threadId: "t-1" } });
  for (const payload of viewPayloads) {
    const json = JSON.stringify(payload);
    assert.ok(!json.includes(SECRET), "raw secret in an agent-visible read");
    assert.ok(json.includes(sentinel("sub_one")), "sentinel handle present on subscription reads");
  }
  const journalJson = JSON.stringify(subs.journal("sub_one"));
  assert.ok(!journalJson.includes(SECRET), "raw secret in the delivery journal");
  assert.ok(subs.journal("sub_one").every(j => !("signature" in j)), "journal carries no signatures");
});

test("dispatch resolves the sentinel to the real secret at the boundary", () => {
  const subs = fresh();
  subs.subscribe(SUB);
  const delivery = subs.buildDelivery("sub_one",
    { eventType: "message.posted", data: { threadId: "t-1" } });
  // The signature must be the HMAC of the REAL secret: proves the swap
  // happened at the boundary, not a null/empty fallback.
  assert.equal(delivery.signature, signPayload(SECRET, { eventType: "message.posted", data: { threadId: "t-1" } }));
  assert.ok(verifySignature(SECRET, delivery.signature,
    { eventType: "message.posted", data: { threadId: "t-1" } }));
  assert.ok(!verifySignature("", delivery.signature,
    { eventType: "message.posted", data: { threadId: "t-1" } }),
    "an empty-string fallback would not verify");
});

test("server-side verification answers valid/invalid without the raw secret", () => {
  const subs = fresh();
  subs.subscribe(SUB);
  // The agent's position: it holds only the sentinel and the inbound
  // payload + signature, never the raw secret. It asks the room.
  const delivery = subs.buildDelivery("sub_one",
    { eventType: "message.posted", data: { threadId: "t-1" } });
  assert.equal(
    subs.verifyDelivery("sub_one",
      { eventType: "message.posted", data: { threadId: "t-1" }, signature: delivery.signature }),
    true);
  assert.equal(
    subs.verifyDelivery("sub_one",
      { eventType: "message.posted", data: { threadId: "t-2" }, signature: delivery.signature }),
    false, "tampered payload fails");
  assert.equal(
    subs.verifyDelivery("sub_one",
      { eventType: "message.posted", data: { threadId: "t-1" }, signature: "0".repeat(64) }),
    false, "forged signature fails");
});

test("unknown or malformed sentinels fail closed — never null, empty, or another secret", () => {
  const subs = fresh();
  subs.subscribe(SUB);
  subs.subscribe({ ...SUB, subscriptionId: "sub_two", secret: "second-secret-0123456789" });
  const expectClosed = (sentinelValue, label) => {
    assert.throws(() => subs.resolveSentinel(sentinelValue),
      err => err instanceof WebhookSubscriptionError && err.code === "unknown_sentinel",
      label);
  };
  expectClosed(sentinel("nope"), "unknown subscription");
  expectClosed(sentinel("sub_two").slice(0, -1), "truncated id");
  expectClosed("garbage", "no prefix");
  expectClosed("", "empty string");
  expectClosed(null, "null");
  expectClosed("PR_SENTINEL_sub_one", "wrong case");
  expectClosed(`${sentinel("sub_one")} `, "trailing space");
  // Never resolves to another subscription's secret.
  assert.notEqual(subs.resolveSentinel(sentinel("sub_one")), "second-secret-0123456789");
});

test("verifyDelivery on an unknown subscription fails closed, not false", () => {
  const subs = fresh();
  assert.throws(
    () => subs.verifyDelivery("sub_missing",
      { eventType: "message.posted", data: {}, signature: "0".repeat(64) }),
    err => err instanceof WebhookSubscriptionError && err.code === "unknown_sentinel");
});

test("unsubscribe retires the secret: the sentinel stops resolving", () => {
  const subs = fresh();
  subs.subscribe(SUB);
  assert.equal(typeof subs.resolveSentinel(sentinel("sub_one")), "string");
  subs.unsubscribe("sub_one", { agentId: "ai_agent1" });
  assert.throws(() => subs.resolveSentinel(sentinel("sub_one")),
    err => err instanceof WebhookSubscriptionError && err.code === "unknown_sentinel");
});
