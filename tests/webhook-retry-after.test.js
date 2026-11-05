import test from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfterMs, MAX_RETRY_AFTER_MS, classifyHttpStatus, postDelivery } from "../server/webhook-dispatch.mjs";

test("parseRetryAfterMs reads delta-seconds and caps at one hour", () => {
  assert.equal(parseRetryAfterMs("12"), 12_000);
  assert.equal(parseRetryAfterMs("99999"), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfterMs(""), null);
  assert.equal(parseRetryAfterMs(null), null);
  assert.equal(parseRetryAfterMs("nope"), null);
});

test("parseRetryAfterMs reads HTTP-date relative to now", () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const header = new Date(now + 30_000).toUTCString();
  assert.equal(parseRetryAfterMs(header, now), 30_000);
  assert.equal(parseRetryAfterMs(new Date(now - 5_000).toUTCString(), now), 0);
});

test("postDelivery surfaces retryAfterMs on HTTP 429", async () => {
  const fetchImpl = async () => ({
    status: 429,
    headers: { get: (name) => String(name).toLowerCase() === "retry-after" ? "45" : null },
    text: async () => "slow down",
  });
  const result = await postDelivery({
    fetchImpl,
    url: "https://example.com/hooks/wake",
    envelope: { deliveryId: "del_x", eventType: "message.posted", data: {} },
    headers: { "content-type": "application/json" },
    // Skip real DNS: provide a fetchImpl so pinning path is not used; still
    // needs resolveWebhookTarget — use a public example.com which may DNS.
    // Prefer injecting dnsResolvers that return a public address.
    dnsResolvers: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 429);
  assert.equal(result.classification, "retry");
  assert.equal(result.retryAfterMs, 45_000);
  assert.equal(classifyHttpStatus(429), "retry");
});
