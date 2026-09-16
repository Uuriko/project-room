// A014: newsletter/bulk-sender detection. Pure classifier tests.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyBulk, BulkDetectError } from "../server/bulk-detect.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof BulkDetectError && error.code === code);

test("bulk mail is detected with unsubscribe URL", () => {
  const result = classifyBulk({
    from: "news@mailchimp.example.com",
    subject: "Weekly digest",
    headers: {
      "List-Unsubscribe": "<https://example.com/unsub?id=123>",
      "List-ID": "weekly.example.com",
      "Precedence": "bulk",
    },
  });
  assert.equal(result.isBulk, true);
  assert.equal(result.unsubscribeUrl, "https://example.com/unsub?id=123");
  assert.ok(result.confidence > 0.5);
  assert.ok(result.signals.length >= 3);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.signals));
});
test("personal mail is not flagged", () => {
  const result = classifyBulk({
    from: "friend@example.com",
    subject: "dinner tonight?",
    headers: { "Message-ID": "<abc123@example.com>" },
  });
  assert.equal(result.isBulk, false);
  assert.equal(result.unsubscribeUrl, null);
  assert.equal(result.confidence, 0);
});
test("malformed inputs are refused", () => {
  throwsCode(() => classifyBulk(null), "invalid_bulk_detect");
  throwsCode(() => classifyBulk({ headers: null }), "invalid_bulk_detect");
});
