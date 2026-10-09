import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { agentErrorAx, validAgentNext } from "../src/agent-error.mjs";
import { rmSync } from "node:fs";

// qa200-EP-03 (2026-10-08): POST /api/agent-invites/redeem with a garbage
// invite code returned 404 invite_unavailable, but the hint fell through to
// the unmapped-code branch — "Unknown error 'invite_unavailable'. Re-check
// access..." — sending a stranger down an access wild-goose chase for a
// code-format problem. The 404 message already names the exact recovery; the
// hint must match it.

function assertHint(ax) {
  assert.equal(ax.reason, "invite_unavailable");
  assert.equal(ax.status, "action_required");
  assert.ok(typeof ax.hint === "string" && ax.hint.length > 0 && ax.hint.length < 160, "short hint");
  assert.doesNotMatch(ax.hint, /Unknown error/, "no unmapped-code fallthrough");
  assert.doesNotMatch(ax.hint, /[Rr]e-check access/, "no access wild-goose chase");
  assert.match(ax.hint, /format|typo/i, "names the format problem");
  assert.match(ax.hint, /fresh code|inviter/i, "names the recovery");
  assert.ok(validAgentNext(ax.next), "next[]");
}

test("agentErrorAx: invite_unavailable (format) gets a dedicated hint", () => {
  const ax = agentErrorAx({
    httpStatus: 404,
    code: "invite_unavailable",
    message: "Invite code has the wrong format: invite codes are two letters, a dash, then 16 characters (no I, L, O, or U). Check for typos or ask the inviter for a fresh code"
  });
  assertHint(ax);
});

test("agentErrorAx: invite_unavailable (no invite issued) gets a dedicated hint", () => {
  const ax = agentErrorAx({
    httpStatus: 404,
    code: "invite_unavailable",
    message: "No invite was issued for this code. Ask the inviter for a fresh code"
  });
  assertHint(ax);
});

test("live: redeem garbage invite code -> 404 with dedicated hint (not fallthrough)", async (t) => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "QA200-EP03-GARBAGE-xxxx", displayName: "EP03-ghost" })
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.code, "invite_unavailable");
  assertHint({ reason: body.reason, status: body.status, hint: body.hint, next: body.next });
});
