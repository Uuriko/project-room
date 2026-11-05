import { test } from "node:test";
import assert from "node:assert/strict";
import { deadLetterReason } from "../server/agent-plugin-store.mjs";

test("dead-letter reasons fall into fixed buckets", () => {
  assert.equal(deadLetterReason("subscription removed"), "subscription_removed");
  assert.equal(deadLetterReason("receiver rejected the delivery (HTTP 410); not retried"), "receiver_rejected");
  assert.equal(deadLetterReason("receiver rejected the delivery (HTTP 0); not retried — webhook_url_not_public"), "url_not_public");
  assert.equal(deadLetterReason("gave up after 5 attempts; last error: timeout"), "retries_exhausted");
  assert.equal(deadLetterReason("stored delivery cannot be attempted: bad url"), "not_attemptable");
  assert.equal(deadLetterReason(null), "other");
  assert.equal(deadLetterReason("something new"), "other");
});
