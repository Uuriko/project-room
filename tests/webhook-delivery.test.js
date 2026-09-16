// G013: webhook delivery for alert events. Pure payload tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildWebhook, verifyWebhook, WebhookError } from "../server/webhook-delivery.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof WebhookError && error.code === code);

test("builds signed webhook payload", () => {
  const payload = buildWebhook({
    alert: { alertId: "a1", ruleId: "r1", roomId: "room-1", message: "Spike!", severity: "high" },
    url: "https://example.com/hook", secret: "s3cr3t" });
  assert.equal(payload.url, "https://example.com/hook");
  assert.ok(payload.headers["X-Webhook-Signature"].startsWith("sha256="));
  assert.equal(payload.headers["X-Webhook-Event"], "alert.fired");
  const body = JSON.parse(payload.body);
  assert.equal(body.alertId, "a1");
  assert.ok(verifyWebhook({ body: payload.body,
    signature: payload.headers["X-Webhook-Signature"], secret: "s3cr3t" }));
  assert.ok(!verifyWebhook({ body: payload.body,
    signature: payload.headers["X-Webhook-Signature"], secret: "wrong" }));
  assert.ok(Object.isFrozen(payload));
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildWebhook({ alert: { alertId: "a" }, url: "http://x.com", secret: "s" }),
    "invalid_webhook");
  throwsCode(() => buildWebhook({ alert: { alertId: "a1", ruleId: "r1" },
    url: "https://x.com", secret: "" }), "invalid_webhook");
});
