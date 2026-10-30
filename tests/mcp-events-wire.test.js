import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { deliverMcpEvent, eventSigningKey, signedEventRequest, verifyMcpEventCallback } from "../server/mcp-events-wire.mjs";

const secret = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const now = 1793390400000;
const subscription = { id: "sub_one", secret, url: "https://callback.example/events", name: "room.requested", expiresAt: now + 10000 };
const event = { eventId: "evt_one", name: "room.requested", timestamp: new Date(now).toISOString(), data: { roomId: "r", requestId: "q" }, cursor: "1" };
const dnsResolvers = { lookup: async () => [{ address: "8.8.8.8", family: 4 }] };
const response = (status, body = "{}") => ({ status, text: async () => body });

test("Standard Webhooks signature covers exact body, stable event ID and fresh attempt timestamp", () => {
  const body = JSON.stringify(event);
  const request = signedEventRequest({ subscriptionId: subscription.id, secret, eventId: event.eventId, body, now });
  const signature = createHmac("sha256", Buffer.alloc(32, 7)).update(`evt_one.1793390400.${body}`).digest("base64");
  assert.equal(request.headers["webhook-signature"], `v1,${signature}`);
  assert.equal(request.body, body);
  const retry = signedEventRequest({ subscriptionId: subscription.id, secret, eventId: event.eventId, body, now: now + 1000 });
  assert.equal(retry.headers["webhook-id"], request.headers["webhook-id"]);
  assert.notEqual(retry.headers["webhook-signature"], request.headers["webhook-signature"]);
});

test("invalid or oversized signing keys/payloads are rejected without echoing secrets", () => {
  for (const value of ["secret", "whsec_!!!!", `whsec_${Buffer.alloc(23).toString("base64")}`, `whsec_${Buffer.alloc(65).toString("base64")}`]) {
    assert.throws(() => eventSigningKey(value), /Invalid event signing secret/);
  }
  assert.throws(() => signedEventRequest({ subscriptionId: "s", secret, eventId: "e", body: "a".repeat(262145), now }), /limit/);
});

test("callback challenge is signed, random per attempt, validated before acceptance", async () => {
  const seen = [];
  const transport = async (url, addresses, request) => {
    assert.equal(url, subscription.url);
    assert.equal(addresses[0], "8.8.8.8");
    assert.ok(request.headers["webhook-signature"].startsWith("v1,"));
    const payload = JSON.parse(request.body); seen.push(payload.challenge);
    assert.equal(payload.type, "verification");
    return response(200, JSON.stringify({ challenge: payload.challenge }));
  };
  for (let i = 0; i < 2; i++) assert.deepEqual(await verifyMcpEventCallback({ ...subscription, subscriptionId: subscription.id, dnsResolvers, transport, now }), { verified: true });
  assert.notEqual(seen[0], seen[1]);
  await assert.rejects(verifyMcpEventCallback({ ...subscription, subscriptionId: subscription.id, dnsResolvers, transport: async () => response(200, '{"challenge":"wrong"}'), now }), error => error.code === -32015);
});

test("callback private DNS fails before network I/O", async () => {
  let calls = 0;
  await assert.rejects(verifyMcpEventCallback({ ...subscription, subscriptionId: subscription.id, now,
    dnsResolvers: { lookup: async () => [{ address: "127.0.0.1", family: 4 }] },
    transport: async () => { calls++; return response(200); },
  }), error => error.code === -32015);
  assert.equal(calls, 0);
});

test("redirect, gone and oversized response statuses are terminal; rate limit retries", async () => {
  for (const [status, expected] of [[302, "dead"], [410, "dead"], [413, "dead"], [429, "retry"], [503, "retry"], [204, "delivered"]]) {
    let calls = 0;
    const result = await deliverMcpEvent({ subscription, event, now, authorize: async () => true, dnsResolvers,
      transport: async () => { calls++; return response(status); },
    });
    assert.equal(result.classification, expected); assert.equal(calls, 1);
  }
});

test("revoked and expired subscriptions never contact callback", async () => {
  const transport = async () => { throw new Error("must not contact"); };
  assert.equal((await deliverMcpEvent({ subscription, event, now, authorize: async () => false, transport })).classification, "revoked");
  assert.equal((await deliverMcpEvent({ subscription: { ...subscription, expiresAt: now }, event, now, authorize: async () => true, transport })).classification, "expired");
});

test("signing-secret rotation sends both keys only within its bounded window", async () => {
  const rotating = { ...subscription, previousSecret: `whsec_${Buffer.alloc(32, 8).toString("base64")}`, previousSecretExpiresAt: now + 1000 };
  for (const [time, count] of [[now, 2], [now + 1000, 1]]) {
    let observed;
    const result = await deliverMcpEvent({ subscription: rotating, event, now: time, authorize: async () => true, dnsResolvers,
      transport: async (_url, _addresses, request) => { observed = request.headers["webhook-signature"].split(" ").length; return response(200); },
    });
    assert.equal(result.classification, "delivered");
    assert.equal(observed, count);
  }
});
