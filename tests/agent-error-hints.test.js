// Lane E4: hint-quality contract for the MCP error surface.
// Following the #1547 pattern (PR #1560): an error's hint must tell the
// caller EXACTLY what to do next — a concrete recipe, endpoint, tool, or
// alternative path — never a vague pointer that strands the caller.
// Each test names the offender (file:line in src/agent-error.mjs) and the
// concrete token the fixed hint must carry.
import test from "node:test";
import assert from "node:assert/strict";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";

function assertHintContract(ax, { reason, contains = [], notContains = [] } = {}) {
  if (reason) assert.equal(ax.reason, reason);
  assert.equal(ax.status, "action_required");
  assert.equal(typeof ax.hint, "string");
  assert.ok(ax.hint.length > 0 && ax.hint.length < 160, "hint stays short");
  for (const token of contains) {
    assert.match(ax.hint, token, `hint must name the concrete next action: ${token}`);
  }
  for (const token of notContains) {
    assert.doesNotMatch(ax.hint, token, `hint must not regress to a vague pointer: ${token}`);
  }
  assert.ok(validAgentNext(ax.next), "next[] stays followable");
}

// Offender 1 (src/agent-error.mjs, default fallthrough): "Check access and
// current work." strands ANY caller hitting an unmapped code — no code named,
// no recovery named. Fixed hint names the unknown code and names the
// recovery: report code + full message to the room owner.
test("hint-quality: unmapped error code names the code and the report-to-owner recovery", () => {
  const ax = agentErrorAx({ httpStatus: 400, code: "some_future_code_xyz", message: "boom" });
  assertHintContract(ax, {
    reason: "some_future_code_xyz",
    contains: [/some_future_code_xyz/, /report/i, /owner/i],
    notContains: [/^Check access and current work\.$/],
  });
  assert.ok(ax.next.some(step => /report/.test(step.command || "")), "next[] carries the report step");
});

// Offender 2 (src/agent-error.mjs, rate_limited): "Wait, then retry the same
// request." never says how long to wait. Fixed hint names the Retry-After
// interval as the wait duration.
test("hint-quality: rate_limited names Retry-After as the wait duration", () => {
  const ax = agentErrorAx({ httpStatus: 429, code: "rate_limited", message: "slow down" });
  assertHintContract(ax, {
    reason: "rate_limited",
    contains: [/Retry-After/, /retry/i],
    notContains: [/^Wait, then retry the same request\.$/],
  });
});

// Offender 3 (src/agent-error.mjs, idempotency_conflict): "Recover the
// original." never says where the original is. Fixed hint says: read current
// work for the original outcome, never reuse the requestId for new input.
test("hint-quality: idempotency_conflict says where to recover the original", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "idempotency_conflict", message: "dup" });
  assertHintContract(ax, {
    reason: "idempotency_conflict",
    contains: [/requestId/, /original/i, /work/i],
    notContains: [/^This requestId belongs to different input\. Recover the original\.$/],
  });
});

// Offender 4 (src/agent-error.mjs, generic 403 access_denied): "Check access"
// is a vague pointer. Fixed hint names the room_check_access tool as the
// concrete check.
test("hint-quality: generic 403 names room_check_access as the check", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "access_denied", message: "nope" });
  assertHintContract(ax, {
    reason: "access_denied",
    contains: [/room_check_access/],
    notContains: [/^This credential cannot do that\. Check access; ask the owner if needed\.$/],
  });
});

// Offender 5 (src/agent-error.mjs, generic input_refused): "Fix the refused
// fields" never says where the fields are named. Fixed hint points at this
// error's message. The /Fix the refused fields/ substring is pinned by
// tests/message-posted-body.test.js and must survive.
test("hint-quality: input_refused points at the fields named in the message", () => {
  const ax = agentErrorAx({ httpStatus: 422, code: "invalid_query", message: "Invalid field: frobnicate" });
  assertHintContract(ax, {
    reason: "input_refused",
    contains: [/Fix the refused fields/, /named in.*message/i],
    notContains: [/^Fix the refused fields\. Keep any earlier uncertain requestId\.$/],
  });
});

// Offender 6 (src/agent-error.mjs, pilot_limit): the 409 capacity cap fell
// through to the unmapped-code branch — "Unknown error 'pilot_limit'.
// Re-check access and current work" told agents to debug a credential that
// was fine and to hammer retries against a hard cap. During the 2026-10-07
// muse-room projection-cap incident every state-changing write 409'd with
// exactly this strand. Fixed hint names the cap, forbids hammering, and
// names the real recovery: back off and retry the same write later, or ask
// the room owner to raise or compact the cap.
test("hint-quality: pilot_limit names the cap and the back-off recovery", () => {
  const ax = agentErrorAx({ httpStatus: 409, code: "pilot_limit", message: "Room projection limit reached; no data was changed" });
  assertHintContract(ax, {
    reason: "pilot_limit",
    contains: [/cap/i, /retry/i, /owner/i],
    notContains: [/Unknown error/, /Re-check access/],
  });
});
