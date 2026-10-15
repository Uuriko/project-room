import test from "node:test";
import assert from "node:assert/strict";
import { connectionDiagnostic } from "../client/agent-connection.mjs";
import { RoomClientError } from "../client/room-agent.mjs";

test("insufficient scope preserves identity and requests only the required authority", () => {
  const diagnostic = connectionDiagnostic(new RoomClientError(403, "insufficient_scope", "PRIVATE endpoint and credential"));
  assert.equal(diagnostic.code, "insufficient_scope");
  assert.equal(diagnostic.reason, "insufficient_scope");
  assert.equal(diagnostic.status, "action_required");
  assert.match(diagnostic.message, /does not grant this operation/);
  assert.match(diagnostic.hint, /Keep the existing identity/);
  assert.match(diagnostic.hint, /only the scopes required/);
  assert.match(diagnostic.hint, /Do not escalate automatically/);
  assert.match(diagnostic.next[0].command, /credential owner/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE|heartbeat|membership.*revoked|replacement identity/);
});

test("revoked membership and other denials retain their existing recovery classification", () => {
  for (const code of ["scoped_key_room_refused", "access_denied", "unknown_denial"]) {
    const diagnostic = connectionDiagnostic(new RoomClientError(403, code, "PRIVATE"));
    assert.equal(diagnostic.code, "access_ended", code);
    assert.equal(diagnostic.reason, "access_denied", code);
  }
  assert.equal(connectionDiagnostic(new RoomClientError(401, "insufficient_scope", "PRIVATE")).code, "access_ended");
});
