// Fail-first repro, adjacent to grok-webhook-url-credentials-1010 (PR #2549).
//
// PR #2549 rejects webhook URLs carrying userinfo via
// `check(!parsed.username && !parsed.password, ...)`. An EMPTY userinfo —
// "https://@host/" or "https://:@host/" — parses to username "" and
// password "", so it slips through that check while the authority still
// carries the credential delimiter "@". The validator's contract is "an
// https URL without credentials"; a credential-shaped authority must not
// be stored, regardless of what any single transport does with empty
// credentials today (node:http sends no Authorization header for them —
// verified — but the invariant should not depend on per-transport
// special-casing).
//
// The fix is a one-liner in validateWebhookUrl next to #2549's line, kept
// OUT of this PR on purpose: server/outbound-webhooks.mjs is claimed by
// grok-webhook-url-credentials-1010 and PR #2549 is open on it — first
// claim wins, so the fix belongs folded into that PR, not rebased over it.
import test from "node:test";
import assert from "node:assert/strict";
import { createWebhooks, validateWebhookUrl, WebhookError } from "../server/outbound-webhooks.mjs";

const throwsInvalid = fn => assert.throws(fn, error => error instanceof WebhookError && error.code === "invalid_webhook");

test("validateWebhookUrl rejects empty userinfo in the authority (g2, adjacent to #2549)", () => {
  throwsInvalid(() => validateWebhookUrl("https://@hooks.example.com/hook"));
  throwsInvalid(() => validateWebhookUrl("https://:@hooks.example.com/hook"));
  // "@" in the path is not userinfo and must keep passing.
  assert.equal(validateWebhookUrl("https://hooks.example.com/user@path"), "https://hooks.example.com/user@path");
});

test("register does not keep a webhook URL with empty userinfo", () => {
  const hooks = createWebhooks();
  throwsInvalid(() => hooks.register({
    webhookId: "empty-userinfo",
    url: "https://@hooks.example.com/hook",
    events: ["message.posted"],
  }));
  assert.equal(hooks.size(), 0);
});
