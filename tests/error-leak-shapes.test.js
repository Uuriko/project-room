// #174 (burn crew Lane E — error-leak audit): the HTTP error envelope must
// never carry a stack trace, an absolute filesystem path, or an
// enumeration oracle. Owner boundary: src/agent-error.mjs (the envelope
// builder) plus the central HTTP catch in server/http.mjs that merges
// error.detail onto the envelope.
//
// Enumeration oracles for auth flows already have primary owners
// (tests/password-http.test.js "unknown email answers 401 with the same
// shape as a wrong password", tests/magic-links-http.test.js,
// tests/magic-invalidation.test.js, tests/recovery-codes-http.test.js
// "unknown email and wrong code return the same 401 shape"); this file
// owns only what those do not: the detail-spread blocklist and the
// envelope leak-shape invariant.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorBody, mergeErrorDetail } from "../src/agent-error.mjs";

const STACK_FRAME_RE = /\n\s*at\s+.*\([^)]*\)|\n\s*at\s+\S+\.(mjs|js|ts|cjs):\d+:\d+/;
const ABS_PATH_RE = /(^|["'\s(=])(\/(home|root|workspace|tmp|var|etc|opt|usr|data|app)\/|([A-Za-z]:)?[\\/][\w.-]+[\\/][\w.-]*\.(mjs|js|ts|cjs|json))/;

function everyString(value, visit) {
  if (typeof value === "string") visit(value);
  else if (Array.isArray(value)) value.forEach(item => everyString(item, visit));
  else if (value && typeof value === "object") Object.values(value).forEach(item => everyString(item, visit));
}

function assertNoLeakShape(body, label) {
  const seen = [];
  everyString(body, text => seen.push(text));
  for (const text of seen) {
    assert.ok(!STACK_FRAME_RE.test(text), `${label}: no stack-trace frame in ${JSON.stringify(text.slice(0, 120))}`);
    assert.ok(!ABS_PATH_RE.test(text), `${label}: no absolute path in ${JSON.stringify(text.slice(0, 120))}`);
  }
  assert.ok(!("stack" in body), `${label}: no top-level stack key`);
  assert.ok(!("stack" in (body.error ?? {})), `${label}: no error.stack key`);
}

// Fail-first (#174): a hostile error.detail must not overwrite envelope
// keys or smuggle a stack trace onto the wire. The current blocklist in
// server/http.mjs only reserves error/status/reason/hint/next/
// operationId/category, so these assertions fail before the fix.
test("mergeErrorDetail drops hostile detail keys (stack, message, code, cause, trace ids)", () => {
  const hostile = {
    stack: "Error: boom\n    at handler (/home/deploy/server/secret.mjs:42:7)",
    message: "attacker-controlled message",
    code: "pwned",
    cause: { message: "inner sqlite failure at /var/data/room.sqlite" },
    errorId: "eid_forged0001",
    fingerprint: "ff".repeat(32),
    trace: { errorId: "eid_forged0002" },
    // Benign keys keep flowing through (backward compatible).
    displayNameReason: "reserved",
    suggestion: "room-2",
  };
  const body = mergeErrorDetail({ error: { code: "x", message: "y" } }, hostile);
  for (const key of ["stack", "message", "code", "cause", "errorId", "fingerprint", "trace"]) {
    assert.ok(!(key in body), `detail must not set ${key} on the envelope`);
  }
  assert.equal(body.displayNameReason, "reserved", "benign detail keys still merge");
  assert.equal(body.suggestion, "room-2", "benign detail keys still merge");
  assert.equal(body.error.code, "x", "envelope error.code is not overwritten by detail");
  assert.equal(body.error.message, "y", "envelope error.message is not overwritten by detail");
});

test("mergeErrorDetail ignores non-object details (backward compatible)", () => {
  const body = { error: { code: "x", message: "y" } };
  assert.deepEqual(mergeErrorDetail(body, null), body);
  assert.deepEqual(mergeErrorDetail(body, undefined), body);
  assert.deepEqual(mergeErrorDetail(body, "oops"), body);
  assert.deepEqual(mergeErrorDetail(body, ["stack", "x"]), body);
});

test("5xx envelope carries no stack trace and no absolute path", () => {
  const body = agentErrorBody({
    httpStatus: 500,
    code: "internal_error",
    message: "Service could not complete the request; no success is claimed",
  });
  assertNoLeakShape(body, "5xx envelope");
  // The trace fields are quotable ids, not traces: no frames, no paths.
  assert.match(body.errorId, /^eid_[A-Za-z0-9_-]{12}$/);
  assert.match(body.fingerprint, /^[0-9a-f]{64}$/);
});

test("4xx envelope carries no stack trace and no absolute path", () => {
  for (const [httpStatus, code, message] of [
    [400, "invalid_request", "Could not parse the request URL"],
    [401, "invalid_credentials", "Invalid email or password"],
    [404, "invite_unavailable", "No invite was issued for this code. Ask the inviter for a fresh code"],
    [410, "invite_expired", "Invite code expired"],
    [422, "invalid_invite_name", "displayName must be 1-80 characters"],
    [429, "rate_limited", "Too many requests; retry after a minute"],
  ]) {
    const body = agentErrorBody({ httpStatus, code, message });
    assertNoLeakShape(body, `${httpStatus} ${code} envelope`);
  }
});

test("merged detail still cannot introduce a stack or path", () => {
  const body = mergeErrorDetail(
    agentErrorBody({ httpStatus: 422, code: "display_name_unavailable", message: "That name is taken" }),
    { displayNameReason: "reserved", suggestion: "room-2" },
  );
  assertNoLeakShape(body, "merged 422 envelope");
});
