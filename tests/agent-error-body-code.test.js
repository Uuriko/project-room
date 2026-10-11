
// WAVE-500 G7 C17: the wire envelope's error.code must always be the valid
// public code the AX reason/status/hint/next were derived from — never
// undefined or an unusable code while reason falls back to "request_failed"
// or "internal_error". Consumers keying off error.code would otherwise
// disagree with reason in the same body.
//
// Test audit gate:
// 1. Protects: error.code is never absent on the wire and always matches the
//    normalized code agentErrorAx derived status/reason/hint/next (and the
//    trace fingerprint/console warn) from.
// 2. Fails when: a throw site emits an error without a code (plain
//    `new Error` + status, or an override path), and agentErrorBody passes
//    the raw code through while reason defaults.
// 3. No existing coverage: every existing agentErrorBody test passes an
//    explicit valid code; none exercise absent/invalid codes.
// 4. No production seam: publicCode() already exists in the module.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorBody } from "../src/agent-error.mjs";

const PUBLIC_CODE = /^[a-z][a-z0-9_]{0,64}$/;

test("agentErrorBody normalizes an absent error code to the public fallback", () => {
  const body = agentErrorBody({ httpStatus: 500, message: "boom" });
  assert.equal(body.error.code, "request_failed");
  assert.equal(body.reason, "internal_error");
  assert.equal(body.status, "failed");
});

test("agentErrorBody normalizes an unusable error code to the public fallback", () => {
  const body = agentErrorBody({ httpStatus: 400, code: "Bad Code!", message: "nope" });
  assert.equal(body.error.code, "request_failed");
  assert.equal(body.reason, "request_failed");
});

test("agentErrorBody keeps valid codes byte-identical", () => {
  for (const code of ["unauthenticated", "work_not_found", "rate_limited", "request_failed"]) {
    const body = agentErrorBody({ httpStatus: 401, code, message: "x" });
    assert.equal(body.error.code, code, `keeps ${code}`);
    assert.match(body.error.code, PUBLIC_CODE);
  }
});
