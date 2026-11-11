import test from "node:test";
import assert from "node:assert/strict";
import { issueApprovalToken, consumeApprovalToken } from "../server/approval-tokens.mjs";

test("#5384 approval tokens: hash only, single use, expiry", () => {
  const { token, tokenHash } = issueApprovalToken();
  assert.ok(!tokenHash.includes(token) && tokenHash.length === 64);
  const record = { tokenHash, exp: 1000, used: false };
  assert.equal(JSON.stringify(record).includes(token), false, "raw token is never stored");
  assert.equal(consumeApprovalToken(record, "apv_wrong", 10), "invalid");
  assert.equal(consumeApprovalToken(record, token, 10), "ok");
  assert.equal(consumeApprovalToken(record, token, 10), "used");
  const late = { tokenHash, exp: 5, used: false };
  assert.equal(consumeApprovalToken(late, token, 10), "expired");
  assert.equal(consumeApprovalToken(null, token, 10), "invalid");
});

test("#5384 burn:false leaves the token retryable until the caller marks it used", () => {
  const { token, tokenHash } = issueApprovalToken();
  const record = { tokenHash, exp: 1000, used: false };
  assert.equal(consumeApprovalToken(record, token, 10, { burn: false }), "ok");
  assert.equal(consumeApprovalToken(record, token, 10, { burn: false }), "ok");
  record.used = true;
  assert.equal(consumeApprovalToken(record, token, 10, { burn: false }), "used");
});
