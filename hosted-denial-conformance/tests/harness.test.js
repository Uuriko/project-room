import assert from "node:assert/strict";
import { test } from "node:test";
import { publicHealthContract, runHostedDenialHarness, STAGING } from "../src/index.js";

test("default harness skips and does not invent a token", () => {
  const result = runHostedDenialHarness({});
  assert.equal(result.executed, false);
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /HOSTED_DENIAL_RUN is unset/);
  assert.equal(result.origin, STAGING.origin);
  assert.equal(result.rows.length, 5);
  assert.ok(result.rows.every((row) => row.result === "skipped"));
  assert.equal(Object.hasOwn(result, "tokenValue"), false);
});

test("run flag without operator token still skips", () => {
  const result = runHostedDenialHarness({ HOSTED_DENIAL_RUN: "1" });
  assert.equal(result.executed, false);
  assert.equal(result.status, "skipped");
  assert.match(result.reason, /never invent tokens/);
});

test("blank token is treated as missing", () => {
  const result = runHostedDenialHarness({
    HOSTED_DENIAL_RUN: "1",
    HOSTED_DENIAL_OPERATOR_TOKEN: "   "
  });
  assert.equal(result.executed, false);
  assert.equal(result.status, "skipped");
});

test("token present still refuses to probe staging denial endpoints", () => {
  const result = runHostedDenialHarness({
    HOSTED_DENIAL_RUN: "1",
    HOSTED_DENIAL_OPERATOR_TOKEN: "operator-supplied-placeholder",
    HOSTED_DENIAL_ORIGIN: "https://project-room-staging.getdasha.workers.dev"
  });
  assert.equal(result.executed, false);
  assert.equal(result.status, "operator_required");
  assert.match(result.reason, /will not send hosted denial/);
  assert.equal(result.tokenPresent, true);
  assert.equal(result.tokenValue, null);
  assert.ok(result.rows.every((row) => row.result === "not_probed"));
});

test("public health contract documents /api/health, /api/ready, and bare /health 404", () => {
  const health = publicHealthContract();
  assert.equal(health.health.path, "/api/health");
  assert.equal(health.health.expectedStatus, 200);
  assert.equal(health.ready.path, "/api/ready");
  assert.equal(health.bareHealth.path, "/health");
  assert.equal(health.bareHealth.expectedStatus, 404);
  assert.equal(health.observed.health.body.mode, "cloudflare-staging");
});
