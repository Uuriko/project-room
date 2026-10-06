// hw-sec-15 (SEC-15): registration-time SSRF guard for webhook subscriptions.
// A subscription URL must be rejected when its target resolves to
// private/loopback/link-local ranges or a cloud metadata endpoint. The
// check is rebind-aware: the hostname is resolved and EVERY returned IP is
// classified — string-matching the hostname is not enough. A normal public
// https URL keeps working (backward compatible).
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSubscriptionWebhookUrl,
  WebhookSubscriptionError,
} from "../server/agent-webhook-subscriptions.mjs";

const rejectsPublic = (promise, code) =>
  assert.rejects(
    promise,
    error => error instanceof WebhookSubscriptionError && error.code === code,
    `expected rejection with code ${code}`
  );

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = (address, family = 4) => async () => [{ address, family }];

test("hw-sec-15: http://127.0.0.1/ subscription is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("http://127.0.0.1/", { lookup: publicLookup }), "invalid_subscription");
});

test("hw-sec-15: http://169.254.169.254/ subscription is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("http://169.254.169.254/", { lookup: publicLookup }), "invalid_subscription");
});

test("hw-sec-15: http://10.0.0.5/ subscription is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("http://10.0.0.5/", { lookup: publicLookup }), "invalid_subscription");
});

test("hw-sec-15: https literal 127.0.0.1 is rejected as not public", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://127.0.0.1/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: https literal 169.254.169.254 (cloud metadata) is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://169.254.169.254/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: https literal 10.0.0.5 (RFC1918) is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://10.0.0.5/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: hostname resolving to private space is rejected with a clear error", async () => {
  let error = null;
  try {
    await assertSubscriptionWebhookUrl("https://hooks.internal.example/", { lookup: privateLookup("10.9.8.7") });
  } catch (err) { error = err; }
  assert.ok(error instanceof WebhookSubscriptionError, "expected a WebhookSubscriptionError");
  assert.equal(error.code, "webhook_url_not_public");
  assert.equal(error.status, 422);
  assert.match(error.message, /private or reserved/i);
});

test("hw-sec-15: rebind-aware — ANY private answer among several refuses the URL", async () => {
  const mixed = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ];
  await rejectsPublic(
    assertSubscriptionWebhookUrl("https://rebind.example/", { lookup: mixed }),
    "webhook_url_not_public"
  );
});

test("hw-sec-15: AAAA answer in ULA space is rejected", async () => {
  await rejectsPublic(
    assertSubscriptionWebhookUrl("https://v6.internal.example/", { lookup: privateLookup("fd00::1", 6) }),
    "webhook_url_not_public"
  );
});

test("hw-sec-15: IPv4-mapped private literal is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://[::ffff:10.0.0.5]/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: NAT64-wrapped cloud metadata literal is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://[64:ff9b::a9fe:a9fe]/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: cloud metadata hostname is rejected without needing DNS", async () => {
  await rejectsPublic(
    assertSubscriptionWebhookUrl("https://metadata.google.internal/", { lookup: publicLookup }),
    "webhook_url_not_public"
  );
});

test("hw-sec-15: localhost hostname is rejected", async () => {
  await rejectsPublic(assertSubscriptionWebhookUrl("https://localhost/", { lookup: publicLookup }), "webhook_url_not_public");
});

test("hw-sec-15: normal public https URL passes registration", async () => {
  const url = await assertSubscriptionWebhookUrl("https://hooks.example.com/room-events", { lookup: publicLookup });
  assert.equal(url, "https://hooks.example.com/room-events");
});

test("hw-sec-15: public IPv6 literal passes registration", async () => {
  const url = await assertSubscriptionWebhookUrl("https://[2606:4700:4700::1111]/hook", { lookup: publicLookup });
  assert.equal(url, "https://[2606:4700:4700::1111]/hook");
});
