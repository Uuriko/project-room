// B020: outbound webhooks. Pure webhook manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { validateWebhookUrl, createWebhooks, WebhookError } from "../server/outbound-webhooks.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof WebhookError && error.code === code);

test("validateWebhookUrl requires https", () => {
  assert.equal(validateWebhookUrl("https://example.com/hook"), "https://example.com/hook");
  throwsCode(() => validateWebhookUrl("http://example.com/hook"), "invalid_webhook");
  throwsCode(() => validateWebhookUrl("not-a-url"), "invalid_webhook");
});
test("register/match/buildPayload lifecycle", () => {
  const hooks = createWebhooks();
  hooks.register({ webhookId: "w1", url: "https://a.example/hook",
    events: ["message.posted"], secret: "supersecret12345678" });
  hooks.register({ webhookId: "w2", url: "https://b.example/hook", events: ["*"] });
  const matched = hooks.match("message.posted");
  assert.equal(matched.length, 2);
  assert.ok(Object.isFrozen(matched));
  const specific = hooks.match("room.created");
  assert.equal(specific.length, 1); // only the wildcard
  assert.equal(specific[0].webhookId, "w2");
  const payload = hooks.buildPayload("w1", { eventType: "message.posted", data: { id: "m1" } });
  assert.equal(payload.state, "pending");
  assert.ok(Object.isFrozen(payload));
  hooks.setEnabled("w2", false);
  assert.equal(hooks.match("room.created").length, 0);
});
test("malformed inputs are refused", () => {
  const hooks = createWebhooks();
  throwsCode(() => hooks.register({ webhookId: "w", url: "https://x.example",
    events: [], }), "invalid_webhook");
  throwsCode(() => hooks.buildPayload("ghost", { eventType: "e", data: {} }), "invalid_webhook");
});
