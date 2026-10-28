// Owner: client/wake-retry.mjs — the transient/fatal classification the
// always-on wake loops (scripts/room-listen.mjs poll mode,
// client/claude-channel.mjs) use to decide between back-off-and-retry and
// stop-and-report.
// Contract: a transient failure (network down, 429, 5xx during a redeploy,
// a request timeout) is retried; a fatal failure (broken local config,
// rejected credentials, identity problems, malformed responses) stops the
// loop exactly as it did before the retry existed.
// Credible regression: a classification drift that retries a revoked
// credential forever (presence lies, hot loop) or stops on a 500 (the
// always-on listener dies on the first blip — the bug this file fixes).
import test from "node:test";
import assert from "node:assert/strict";
import { ConnectionError } from "../client/agent-connection.mjs";
import { RoomClientError } from "../client/room-agent.mjs";
import { isTransientWakeError, wakeRetryDelayMs } from "../client/wake-retry.mjs";

test("5xx, network, 429 and timeout failures are transient", () => {
  assert.equal(isTransientWakeError(new RoomClientError(500, "internal", "x")), true);
  assert.equal(isTransientWakeError(new RoomClientError(503, "service_unavailable", "x")), true);
  assert.equal(isTransientWakeError(new RoomClientError(0, "service_unavailable", "x")), true);
  assert.equal(isTransientWakeError(new RoomClientError(429, "rate_limited", "x", 5000)), true);
  assert.equal(isTransientWakeError(new RoomClientError(0, "request_timeout", "x")), true);
  assert.equal(isTransientWakeError(new ConnectionError("request_timeout")), true);
  assert.equal(isTransientWakeError(new DOMException("timed out", "TimeoutError")), true);
});

test("auth, identity, config and shape failures are fatal", () => {
  assert.equal(isTransientWakeError(new RoomClientError(401, "unauthenticated", "x")), false);
  assert.equal(isTransientWakeError(new RoomClientError(403, "access_denied", "x")), false);
  assert.equal(isTransientWakeError(new RoomClientError(404, "unavailable_route", "x")), false);
  assert.equal(isTransientWakeError(new RoomClientError(422, "invalid_wake_poll", "x")), false);
  assert.equal(isTransientWakeError(new RoomClientError(200, "invalid_response", "x")), false);
  assert.equal(isTransientWakeError(new RoomClientError(409, "identity_credential_changed", "x")), false);
  assert.equal(isTransientWakeError(new ConnectionError("invalid_config")), false);
  assert.equal(isTransientWakeError(new ConnectionError("config_not_found")), false);
  assert.equal(isTransientWakeError(new ConnectionError("ambiguous_config")), false);
  assert.equal(isTransientWakeError(new ConnectionError("usage_error")), false);
  assert.equal(isTransientWakeError(new Error("boom")), false);
  assert.equal(isTransientWakeError(undefined), false);
});

test("backoff doubles from 1s, caps at 30s, and honors a 429 retryAfterMs floor", () => {
  assert.equal(wakeRetryDelayMs(0, null), 1000);
  assert.equal(wakeRetryDelayMs(1, null), 2000);
  assert.equal(wakeRetryDelayMs(2, null), 4000);
  assert.equal(wakeRetryDelayMs(5, null), 30000);
  assert.equal(wakeRetryDelayMs(12, null), 30000);
  const limited = new RoomClientError(429, "rate_limited", "x", 60000);
  assert.equal(wakeRetryDelayMs(0, limited), 60000);
  assert.equal(wakeRetryDelayMs(0, new RoomClientError(429, "rate_limited", "x", 999999999)), 300000);
  assert.equal(wakeRetryDelayMs(3, new RoomClientError(500, "internal", "x")), 8000);
});
