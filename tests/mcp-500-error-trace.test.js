// T179 (johnstab-mcp-500-trace): every server 5xx error envelope carries a
// stable, quotable errorId plus a request fingerprint, and the errorId is
// emitted on a server log line so a pasted id is greppable in logs.
// Owner boundary: agentErrorBody in src/agent-error.mjs — the single builder
// behind the central HTTP 500 catch (server/http.mjs) and refusal bodies.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorBody, errorTrace } from "../src/agent-error.mjs";

const ERROR_ID_RE = /^eid_[A-Za-z0-9_-]{12}$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

function fiveHundred(overrides = {}) {
  return agentErrorBody({
    httpStatus: 500,
    code: "internal_error",
    message: "Service could not be completed; no success is claimed",
    ...overrides,
  });
}

test("5xx envelope carries a stable-format quotable errorId and fingerprint", () => {
  const body = fiveHundred();
  assert.match(body.errorId, ERROR_ID_RE, "errorId has the stable eid_ format");
  assert.match(body.fingerprint, FINGERPRINT_RE, "fingerprint is quotable hex");
});

test("errorId is unique per occurrence, fingerprint is stable per failure", () => {
  const a = fiveHundred();
  const b = fiveHundred();
  assert.notEqual(a.errorId, b.errorId, "each 500 gets its own errorId");
  assert.equal(a.fingerprint, b.fingerprint, "same failure fingerprints identically");
});

test("fingerprint changes when the failure changes", () => {
  const a = fiveHundred({ code: "internal_error" });
  const b = fiveHundred({ code: "db_unavailable" });
  assert.notEqual(a.fingerprint, b.fingerprint, "different codes fingerprint differently");
});

test("fingerprint survives retry noise (uuids, numbers, hex)", () => {
  const a = fiveHundred({ message: "claim 3f9a2c1e-9b4d-4a1e-8c7d-2e6f9a1b3c4d failed after 12 retries" });
  const b = fiveHundred({ message: "claim 7d1b8e2f-3c9a-4d5b-9e8f-1a2b3c4d5e6f failed after 3 retries" });
  assert.equal(a.fingerprint, b.fingerprint, "dynamic tokens do not split one failure into many");
});

test("non-5xx envelopes are untouched (backward compatible)", () => {
  for (const httpStatus of [400, 401, 404, 422, 429]) {
    const body = agentErrorBody({ httpStatus, code: "input_refused", message: "bad input" });
    assert.ok(!("errorId" in body), `no errorId on ${httpStatus}`);
    assert.ok(!("fingerprint" in body), `no fingerprint on ${httpStatus}`);
    assert.ok(body.error && body.status && body.reason, `existing ${httpStatus} shape intact`);
  }
});

test("5xx envelope keeps the existing fields (additive only)", () => {
  const body = fiveHundred({ roomId: "room1", workItemId: "w1" });
  assert.ok(body.error && body.error.code === "internal_error", "error.code intact");
  assert.equal(body.status, "failed", "AX status intact");
  assert.ok(typeof body.hint === "string" && body.hint.length > 0, "hint intact");
  assert.ok(Array.isArray(body.next) && body.next.length > 0, "next intact");
});

test("the errorId is emitted on a server log line", () => {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => { lines.push(args.join(" ")); };
  let body;
  try {
    body = fiveHundred();
  } finally {
    console.warn = original;
  }
  const hit = lines.find((line) => line.includes(body.errorId));
  assert.ok(hit, "a log line contains the errorId so it is greppable");
  assert.ok(hit.includes(body.fingerprint.slice(0, 16)), "the log line carries the fingerprint too");
});

test("errorTrace helper: null for non-5xx, trace for 5xx", () => {
  assert.equal(errorTrace({ httpStatus: 400, code: "x", message: "y" }), null);
  const trace = errorTrace({ httpStatus: 503, code: "maintenance", message: "down" });
  assert.match(trace.errorId, ERROR_ID_RE);
  assert.match(trace.fingerprint, FINGERPRINT_RE);
});
