// Unit tests for the signed webhook dispatch engine
// (server/webhook-dispatch.mjs, RC-2026-09-19-064). Pure: no I/O, no
// network — the fetch implementation is injected into postDelivery.
import test from "node:test";
import assert from "node:assert/strict";
import {
  signDelivery, verifyDeliverySignature, isFresh, deliveryEnvelope, deliveryHeaders,
  classifyHttpStatus, postDelivery, backoffDelayMs, REPLAY_TOLERANCE_MS,
  MAX_DELIVERY_ATTEMPTS, DELIVERY_TIMEOUT_MS, WebhookDispatchError,
} from "../server/webhook-dispatch.mjs";

const SECRET = "signing-secret-0123456789abcdef";
const DELIVERY = { deliveryId: "del_abc123", eventType: "message.posted", issuedAt: 1_700_000_000_000, data: { messageId: "m1" } };

test("signDelivery is deterministic, hex, and binds deliveryId + timestamp + data", () => {
  const a = signDelivery(SECRET, DELIVERY);
  const b = signDelivery(SECRET, DELIVERY);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, deliveryId: "del_other" }), a);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, issuedAt: DELIVERY.issuedAt + 1 }), a);
  assert.notEqual(signDelivery(SECRET, { ...DELIVERY, data: { messageId: "m2" } }), a);
  assert.notEqual(signDelivery("another-secret-0123456789abcdef", DELIVERY), a);
});

test("signDelivery rejects bad input without signing", () => {
  assert.throws(() => signDelivery("", DELIVERY), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, deliveryId: "" }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, issuedAt: 0 }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, issuedAt: 1.5 }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, data: null }), WebhookDispatchError);
  assert.throws(() => signDelivery(SECRET, { ...DELIVERY, data: "string" }), WebhookDispatchError);
});

test("verifyDeliverySignature round-trips and fails closed", () => {
  const signature = signDelivery(SECRET, DELIVERY);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, DELIVERY), true);
  assert.equal(verifyDeliverySignature(SECRET, signature, DELIVERY), true); // bare hex also accepted
  assert.equal(verifyDeliverySignature("wrong-secret-0123456789abcdef", `sha256=${signature}`, DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, { ...DELIVERY, data: { messageId: "tampered" } }), false);
  assert.equal(verifyDeliverySignature(SECRET, "sha256=00", DELIVERY), false);
  assert.equal(verifyDeliverySignature("", `sha256=${signature}`, DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, "", DELIVERY), false);
  assert.equal(verifyDeliverySignature(SECRET, `sha256=${signature}`, { ...DELIVERY, deliveryId: "" }), false);
});

test("isFresh enforces the 5-minute replay tolerance", () => {
  const now = 1_700_000_000_000;
  assert.equal(REPLAY_TOLERANCE_MS, 5 * 60 * 1000);
  assert.equal(isFresh(now, now), true);
  assert.equal(isFresh(now - REPLAY_TOLERANCE_MS, now), true);
  assert.equal(isFresh(now - REPLAY_TOLERANCE_MS - 1, now), false);
  assert.equal(isFresh(now + 60_000, now), true); // small clock skew tolerated
  assert.equal(isFresh(0, now), false);
  assert.equal(isFresh(NaN, now), false);
});

test("deliveryEnvelope carries the wire contract and is frozen", () => {
  const envelope = deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "message.posted", issuedAt: 1_700_000_000_000, roomId: "commons", data: { a: 1 } });
  assert.equal(envelope.deliveryId, "del_1");
  assert.equal(envelope.subscriptionId, "sub_1");
  assert.equal(envelope.issuedAt, new Date(1_700_000_000_000).toISOString());
  assert.equal(envelope.roomId, "commons");
  assert.deepEqual(envelope.data, { a: 1 });
  assert.ok(Object.isFrozen(envelope));
  assert.equal(deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "agent.wake", issuedAt: 1_700_000_000_000, data: {} }).roomId, null);
  assert.throws(() => deliveryEnvelope({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "x", issuedAt: 1, roomId: 42, data: {} }), WebhookDispatchError);
});

test("deliveryHeaders carries all signature headers", () => {
  const headers = deliveryHeaders({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "message.posted", issuedAt: 1_700_000_000_000, signature: "ab".repeat(32) });
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers["x-webhook-delivery"], "del_1");
  assert.equal(headers["x-webhook-subscription"], "sub_1");
  assert.equal(headers["x-webhook-event"], "message.posted");
  assert.equal(headers["x-webhook-timestamp"], new Date(1_700_000_000_000).toISOString());
  assert.equal(headers["x-webhook-signature"], `sha256=${"ab".repeat(32)}`);
  assert.ok(Object.isFrozen(headers));
  assert.throws(() => deliveryHeaders({ deliveryId: "del_1", subscriptionId: "sub_1",
    eventType: "x", issuedAt: 1, signature: "not-hex" }), WebhookDispatchError);
});

test("classifyHttpStatus: 2xx delivered, 429/5xx/0 retry, other 4xx dead", () => {
  assert.equal(classifyHttpStatus(200), "delivered");
  assert.equal(classifyHttpStatus(201), "delivered");
  assert.equal(classifyHttpStatus(204), "delivered");
  assert.equal(classifyHttpStatus(429), "retry");
  assert.equal(classifyHttpStatus(500), "retry");
  assert.equal(classifyHttpStatus(503), "retry");
  assert.equal(classifyHttpStatus(0), "retry");
  assert.equal(classifyHttpStatus(400), "dead");
  assert.equal(classifyHttpStatus(404), "dead");
  assert.equal(classifyHttpStatus(422), "dead");
  assert.throws(() => classifyHttpStatus(-1), WebhookDispatchError);
});

test("postDelivery returns ok on 2xx without throwing", async () => {
  const seen = [];
  const result = await postDelivery({
    fetchImpl: async (url, opts) => {
      seen.push({ url, opts });
      return { status: 201, text: async () => "created" };
    },
    url: "https://hooks.example.test/agent",
    envelope: { deliveryId: "del_1" },
    headers: { "x-webhook-delivery": "del_1" },
  });
  assert.deepEqual(result, { ok: true, status: 201, error: null });
  assert.equal(seen[0].url, "https://hooks.example.test/agent");
  assert.equal(seen[0].opts.method, "POST");
  assert.equal(JSON.parse(seen[0].opts.body).deliveryId, "del_1");
});

test("postDelivery classifies retryable failures and dead rejections", async () => {
  const retry = await postDelivery({ fetchImpl: async () => ({ status: 503, text: async () => "busy" }),
    url: "https://x", envelope: {}, headers: {} });
  assert.equal(retry.ok, false);
  assert.equal(retry.status, 503);
  assert.equal(retry.classification, "retry");
  assert.match(retry.error, /HTTP 503/);

  const dead = await postDelivery({ fetchImpl: async () => ({ status: 400, text: async () => "bad signature" }),
    url: "https://x", envelope: {}, headers: {} });
  assert.equal(dead.ok, false);
  assert.equal(dead.classification, "dead");
  assert.match(dead.error, /bad signature/);
});

test("postDelivery never throws on transport failure; errors are capped", async () => {
  const down = await postDelivery({ fetchImpl: async () => { throw new Error("connect ECONNREFUSED"); },
    url: "https://x", envelope: {}, headers: {} });
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  assert.equal(down.classification, "retry");
  assert.match(down.error, /ECONNREFUSED/);

  const timeout = await postDelivery({ fetchImpl: async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; },
    url: "https://x", envelope: {}, headers: {} });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error, /timed out/);

  const long = await postDelivery({ fetchImpl: async () => ({ status: 500, text: async () => "x".repeat(10_000) }),
    url: "https://x", envelope: {}, headers: {} });
  assert.ok(long.error.length <= 500);

  assert.rejects(() => postDelivery({ fetchImpl: "nope", url: "https://x", envelope: {}, headers: {} }), WebhookDispatchError);
});

test("backoffDelayMs doubles from 5s and caps at 10 minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(backoffDelayMs), [5000, 10000, 20000, 40000, 80000]);
  assert.equal(backoffDelayMs(10), 600_000);
  assert.equal(backoffDelayMs(100), 600_000);
  assert.throws(() => backoffDelayMs(-1), WebhookDispatchError);
  assert.throws(() => backoffDelayMs(1.5), WebhookDispatchError);
});

test("dispatch constants match the claimed policy", () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 5);
  assert.equal(DELIVERY_TIMEOUT_MS, 10_000);
});
