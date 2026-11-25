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

test("a private work refusal is distinguished from a broken connection and never suggests retrying the same read", () => {
  const diagnostic = connectionDiagnostic(new RoomClientError(403, "work_private", "PRIVATE-PARTIES-SENTINEL"));
  assert.equal(diagnostic.code, "work_private");
  assert.equal(diagnostic.reason, "work_private");
  assert.equal(diagnostic.status, "action_required");
  assert.match(diagnostic.message, /private to its participants/);
  assert.doesNotMatch(diagnostic.message, /access was not accepted|check the service address/i);
  assert.match(diagnostic.hint, /[Dd]o not retry the same read/);
  assert.doesNotMatch(JSON.stringify(diagnostic), /PRIVATE-PARTIES-SENTINEL/);
  assert.equal(connectionDiagnostic(new RoomClientError(401, "work_private", "PRIVATE-PARTIES-SENTINEL")).code, "access_ended");
});
