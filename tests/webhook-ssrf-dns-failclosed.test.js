// hw-sec-15-dns-failclosed (reviewer follow-up on the Node registration
// gate): a webhook-subscription URL whose hostname does not resolve — the
// DNS lookup throws (ENOTFOUND) or returns no records — must be rejected
// with a clear error, not accepted and stored. Before the fix, the gate and
// the dispatcher disagreed: delivery re-checks fail closed
// (resolveWebhookTarget refuses unresolvable names), so the stored URL could
// never fire, but the registration itself was a lie.
//
// The gate is fully fail-closed for EVERY name: there is no reserved-name
// exemption in production code (Instinct-3 seq 4267 review of PR #1590).
// Tests that need a resolvable fixture name inject a fake resolver through
// the `lookup` option instead of relying on real DNS behavior — the
// production module never touches the test seam.
//
// The Workers path is untouched (it already fails closed for every name;
// cloudflare/webhook-doh.check.mjs pins that).
import test from "node:test";
import assert from "node:assert/strict";
import {
  assertSubscriptionWebhookUrl,
  WebhookSubscriptionError,
} from "../server/agent-webhook-subscriptions.mjs";

const throwingLookup = (code = "ENOTFOUND") => async host => {
  const error = new Error(`${code} ${host}`);
  error.code = code;
  throw error;
};
const emptyLookup = async () => [];
const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = address => async () => [{ address, family: address.includes(":") ? 6 : 4 }];

const rejectsNotPublic = promise =>
  assert.rejects(
    promise,
    error => error instanceof WebhookSubscriptionError &&
      error.code === "webhook_url_not_public" &&
      error.status === 422 &&
      /does not resolve/i.test(error.message),
    "expected a 422 webhook_url_not_public rejection naming the resolution failure"
  );

test("hw-sec-15-dns-failclosed: a lookup throw rejects the subscription (fail closed)", async () => {
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://hooks.example.com/room-events", { lookup: throwingLookup() })
  );
});

test("hw-sec-15-dns-failclosed: a lookup with no records rejects the subscription (fail closed)", async () => {
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://hooks.example.com/room-events", { lookup: emptyLookup })
  );
});

test("hw-sec-15-dns-failclosed: a public answer still registers", async () => {
  const url = await assertSubscriptionWebhookUrl("https://hooks.example.com/room-events", { lookup: publicLookup });
  assert.equal(url, "https://hooks.example.com/room-events");
});

test("hw-sec-15-dns-failclosed: .test names fail closed too — no production exemption", async () => {
  // The production gate has no reserved-name carve-out: an unresolvable
  // .test name is refused exactly like any other name.
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://hooks.example.test/agent", { lookup: throwingLookup() })
  );
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://sub.hooks.test/agent", { lookup: emptyLookup })
  );
});

test("hw-sec-15-dns-failclosed: .example and .invalid names fail closed too", async () => {
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://x.example/hook", { lookup: emptyLookup })
  );
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://x.invalid/hook", { lookup: throwingLookup() })
  );
});

test("hw-sec-15-dns-failclosed: a reserved name resolving to private space is still refused", async () => {
  await assert.rejects(
    assertSubscriptionWebhookUrl("https://hooks.example.test/agent", { lookup: privateLookup("10.0.0.5") }),
    error => error instanceof WebhookSubscriptionError &&
      error.code === "webhook_url_not_public" &&
      /private or reserved/i.test(error.message),
    "a .test name resolving to private space must still be refused"
  );
});

test("hw-sec-15-dns-failclosed: a lookalike suffix is not a reserved name", async () => {
  // "notest" is a real registrable TLD, not the reserved .test — fail closed.
  await rejectsNotPublic(
    assertSubscriptionWebhookUrl("https://hooks.notest/agent", { lookup: throwingLookup() })
  );
});
