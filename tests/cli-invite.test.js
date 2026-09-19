import test from "node:test";
import assert from "node:assert/strict";
import { RoomClientError, redeemAgentInvite } from "../client/room-agent.mjs";
import { connectionDiagnostic } from "../client/agent-connection.mjs";

// RC-2026-09-19-082: a one-time agent invite code redeemed twice answers
// HTTP 409 invite_already_used. The client used to map that to the generic
// service_unavailable "Check the service address and retry", sending the
// user chasing a network problem. It now surfaces an actionable message.
test("a 409 invite_already_used surfaces the already-used message, not the generic one", async () => {
  const diagnostic = connectionDiagnostic(
    new RoomClientError(409, "invite_already_used", "Invite code was already used"));
  assert.equal(diagnostic.type, "agent_connection_error");
  assert.equal(diagnostic.code, "invite_already_used");
  assert.equal(diagnostic.message, "This invite was already used — ask the room owner for a fresh one.");
  assert.doesNotMatch(diagnostic.message, /service address/);
});

test("the full redeem path maps a server 409 to the actionable diagnostic", async () => {
  const fetchImpl = async () => Response.json(
    { error: { code: "invite_already_used", message: "Invite code was already used" } }, { status: 409 });
  const failure = await redeemAgentInvite("https://room.example", "RM-USEDCODE0000001", "Peer", { fetchImpl })
    .then(() => null, error => error);
  assert.ok(failure instanceof RoomClientError, "redeem rejects");
  assert.equal(failure.status, 409);
  assert.equal(failure.code, "invite_already_used");
  const diagnostic = connectionDiagnostic(failure);
  assert.equal(diagnostic.code, "invite_already_used");
  assert.equal(diagnostic.message, "This invite was already used — ask the room owner for a fresh one.");
});

test("other 409s still fall back to service_unavailable", () => {
  const diagnostic = connectionDiagnostic(new RoomClientError(409, "some_other_conflict", "Conflict"));
  assert.equal(diagnostic.code, "service_unavailable");
  assert.equal(diagnostic.message, "Could not complete the request. Check the service address and retry.");
});
