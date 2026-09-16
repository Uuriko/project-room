// A007: connection health assessment. Fixture-driven; no network, store, or secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { assessConnectionHealth, summarizeConnectionHealth, healthStatuses, unreachableAfterFailures, lastSyncOutcome, healthConnection } from "../server/channel-health.mjs";
import { telegramContractFixture } from "../scripts/telegram-contract-fixture.mjs";
import { emailContractFixture } from "../scripts/email-contract-fixture.mjs";

const profile = telegramContractFixture().connection;
const emailProfile = emailContractFixture().connection;
const connection = (overrides = {}) => ({ id: "conn-1", authEpoch: 7, state: "active", profile, ...overrides });
const AT = "2026-09-16T06:00:00Z";

test("a fresh active connection with no sync history is healthy", () => {
  const health = assessConnectionHealth(connection(), 7);
  assert.equal(health.status, "healthy");
  assert.equal(health.reAuthRequired, false);
  assert.equal(health.lastSyncAt, null);
  assert.equal(health.channel, "telegram");
  assert.equal(health.provider, "telegram-bot");
});
test("a successful recent sync is healthy", () => {
  const health = assessConnectionHealth(connection(), 7, { at: AT, error: null, consecutiveFailures: 0 });
  assert.equal(health.status, "healthy");
  assert.equal(health.lastSyncAt, AT);
});
test("an owner-disconnected connection stays disconnected, never asks for re-auth", () => {
  const health = assessConnectionHealth(connection({ state: "disconnected" }), 7, { at: AT, error: { code: "unauthorized", status: 401 }, consecutiveFailures: 5 });
  assert.equal(health.status, "disconnected");
  assert.equal(health.reAuthRequired, false);
});
test("an authorization epoch change requires re-auth", () => {
  const health = assessConnectionHealth(connection(), 8);
  assert.equal(health.status, "auth_required");
  assert.equal(health.reAuthRequired, true);
});
test("a 401/403 sync failure requires re-auth", () => {
  for (const error of [{ code: "token_expired", status: 401 }, { code: "x", status: 403 }, { code: "invalid_grant" }]) {
    const health = assessConnectionHealth(connection(), 7, { at: AT, error, consecutiveFailures: 1 });
    assert.equal(health.status, "auth_required", JSON.stringify(error));
    assert.equal(health.reAuthRequired, true);
  }
});
test("a transient failure degrades; repeated failures mark unreachable", () => {
  const degraded = assessConnectionHealth(connection(), 7, { at: AT, error: { code: "timeout", status: 504 }, consecutiveFailures: 1 });
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.reAuthRequired, false);
  const unreachable = assessConnectionHealth(connection(), 7, { at: AT, error: { code: "timeout", status: 504 }, consecutiveFailures: unreachableAfterFailures });
  assert.equal(unreachable.status, "unreachable");
  assert.equal(unreachable.reAuthRequired, false);
});
test("email connections assess the same way", () => {
  const health = assessConnectionHealth(connection({ id: "conn-2", profile: emailProfile }), 7, { at: AT, error: null, consecutiveFailures: 0 });
  assert.equal(health.status, "healthy");
  assert.equal(health.channel, "email");
});
test("the account summary rolls up counts the inbox UI needs", () => {
  const summary = summarizeConnectionHealth(
    [connection({ id: "a" }), connection({ id: "b", profile: emailProfile }), connection({ id: "c", state: "disconnected" })], 7,
    { a: { at: AT, error: null, consecutiveFailures: 0 },
      b: { at: AT, error: { code: "token_expired", status: 401 }, consecutiveFailures: 2 },
      c: {} });
  assert.equal(summary.total, 3);
  assert.equal(summary.healthy, 1);
  assert.equal(summary.needsAttention, 2);
  assert.equal(summary.reAuthRequired, 1);
  assert.deepEqual(summary.rows.map(row => row.connectionId), ["a", "b", "c"]);
});
test("malformed inputs are contract errors, never a misread", () => {
  assert.throws(() => assessConnectionHealth({ ...connection(), profile: { ...profile, channel: "sms" } }, 7), /invalid_channel_health|unsupported_channel/);
  assert.throws(() => assessConnectionHealth(connection(), 7, { at: "not-a-date", error: null, consecutiveFailures: 0 }), /invalid_channel_health/);
  assert.throws(() => assessConnectionHealth(connection(), 7, { at: AT, error: null, consecutiveFailures: -1 }), /invalid_channel_health/);
  assert.throws(() => lastSyncOutcome(null), /invalid_channel_health/);
  assert.throws(() => healthConnection({ id: "x" }), /invalid_channel_health/);
  assert.deepEqual(healthStatuses, ["healthy", "degraded", "unreachable", "auth_required", "disconnected"]);
});
