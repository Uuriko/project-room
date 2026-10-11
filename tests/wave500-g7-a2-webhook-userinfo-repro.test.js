// WAVE-500 guild-7 worker A2 — fail-first repro supporting Grok Bot's lane
// (grok-webhook-url-credentials-1010 / PR #2549): webhook URLs that carry
// userinfo, e.g. https://user:pass@hooks.example.com/hook.
//
// Human-side consequences probed:
//   1. validateWebhookUrl must reject userinfo before anything is stored.
//      On current main it does not: the hostname is public, so the SSRF
//      guard passes, and node:https/fetch would then send the credentials
//      as Basic auth on every delivery.
//   2. register()/subscribe() must not store a userinfo URL — a success
//      answer while credentials sit server-side would be a lie.
//   3. When rejected, the error code must be catalog-documented (the errors
//      catalog must map a recovery, not dead-end on "no mapped recovery"),
//      and the browser error surface must show the specific server message,
//      never "Unknown error" / "Request failed".
//   4. No UI string may promise webhook URLs "just work" without naming the
//      restriction.
//
// NEW FILE ONLY. Does not touch server/outbound-webhooks.mjs or
// tests/webhook-url-credentials.test.js (Grok Bot's lane owns those).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateWebhookUrl, createWebhooks, WebhookError } from "../server/outbound-webhooks.mjs";
import { createAgentWebhookSubscriptions } from "../server/agent-webhook-subscriptions.mjs";
import { humanErrorMessage } from "../src/error-copy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USERINFO_URLS = [
  "https://ops:s3cret@hooks.example.com/hook",
  "https://ops@hooks.example.com/hook",
  "https://:s3cret@hooks.example.com:8443/hook",
];

const thrownError = fn => {
  try { fn(); } catch (error) { return error; }
  return null;
};

test("validateWebhookUrl rejects https userinfo (repro of the credential-in-URL hole)", () => {
  for (const url of USERINFO_URLS) {
    const error = thrownError(() => validateWebhookUrl(url));
    assert.ok(error, `expected rejection, got acceptance: ${url}`);
    assert.ok(error instanceof WebhookError, `expected WebhookError, got ${error?.constructor?.name}`);
    assert.equal(typeof error.code, "string", "rejection must carry a machine-readable error code");
  }
});

test("createWebhooks().register does not store a userinfo URL", () => {
  const hooks = createWebhooks();
  for (const url of USERINFO_URLS) {
    const error = thrownError(() => hooks.register({
      webhookId: "userinfo-repro", url, events: ["agent.wake"], secret: "x".repeat(16),
    }));
    assert.ok(error, `expected registration refusal, got success: ${url}`);
  }
  assert.equal(hooks.size(), 0, "no userinfo URL may be stored");
});

test("agent subscription rejects userinfo URLs with a catalog-documented code", () => {
  const subs = createAgentWebhookSubscriptions();
  for (const url of USERINFO_URLS) {
    const error = thrownError(() => subs.subscribe({
      agentId: "ai_wave500_g7_a2", url, events: ["agent.wake"], secret: "x".repeat(16),
    }));
    assert.ok(error, `expected subscription refusal, got success: ${url}`);
    assert.equal(error.code, "invalid_subscription",
      `expected catalog-documented invalid_subscription, got ${error.code}`);
    assert.match(error.message, /without credentials/i,
      "the human must learn what to fix from the message");
  }
});

test("the rejection code has a mapped recovery in the errors catalog (no dead end)", () => {
  const catalog = readFileSync(join(ROOT, "skills/project-room/references/errors-catalog.md"), "utf8");
  const row = catalog.split("\n").find(line => /\|\s*`invalid_subscription`\s*\|/.test(line));
  assert.ok(row, "invalid_subscription must be documented in the errors catalog");
  assert.ok(!/no mapped recovery/.test(row),
    `the catalog must map a recovery, not dead-end: ${row.trim()}`);
});

test("the browser error surface shows the specific rejection, never a generic fallthrough", () => {
  const message = "url must be an https URL without credentials";
  const shown = humanErrorMessage({ status: 422, code: "invalid_subscription", message });
  assert.ok(!/unknown error|request failed/i.test(shown),
    `must not dead-end on a generic sentence, got: ${shown}`);
  assert.match(shown, /without credentials/i,
    `the human must learn what to fix, got: ${shown}`);
});

test("no UI string promises webhook URLs just work without naming the restriction", () => {
  const strings = JSON.parse(readFileSync(join(ROOT, "strings/en.json"), "utf8"));
  const webhookUrlCopy = Object.entries(strings)
    .filter(([, value]) => typeof value === "string"
      && /webhook/i.test(value) && /url/i.test(value));
  for (const [key, value] of webhookUrlCopy) {
    assert.ok(/credential|public|https|refus|not be/i.test(value),
      `UI copy ${key} mentions webhook URLs without naming the restriction: ${value}`);
  }
});
