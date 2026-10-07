// Lane E3 (permissions legibility): denials must name the missing permission
// token and point at the real recovery (access-requests), instead of
// collapsing every 403 into a vague access_denied whose next step tells the
// agent to "ask the owner to mint a guest invite".
import test from "node:test";
import assert from "node:assert/strict";
import {
  agentErrorAx,
  agentErrorBody,
  validAgentNext,
  annotatePermissionDenial,
  ERROR_MISSING_PERMISSION,
} from "../src/agent-error.mjs";
import { PERMISSIONS } from "../src/events.js";
import { permissionDenial } from "../server/permission-denials.mjs";
import { ServiceError } from "../server/service-error.mjs";

const ROOM = "muse-room";

// 1. The annotation accepts every vocabulary token (a new PERMISSIONS token
//    without legibility support fails this test by construction).
for (const token of PERMISSIONS) {
  test(`annotatePermissionDenial accepts vocabulary token ${token}`, () => {
    const err = annotatePermissionDenial(new Error("x"), token);
    assert.equal(err[ERROR_MISSING_PERMISSION], token);
  });
}

// 2. Fail-closed: unknown / empty / non-string tokens leave the error alone.
for (const bad of ["read", "MANAGE_MEMBERS", "", null, undefined, 42, "manage_members "]) {
  test(`annotatePermissionDenial ignores non-vocabulary token ${JSON.stringify(bad)}`, () => {
    const err = new Error("x");
    const out = annotatePermissionDenial(err, bad);
    assert.equal(out, err);
    assert.equal(err[ERROR_MISSING_PERMISSION], undefined);
  });
}

// 3. The 403 AX names the missing permission and points at access-requests.
test("403 denial with missingPermission names the token and the request path", () => {
  const ax = agentErrorAx({
    httpStatus: 403,
    code: "access_denied",
    message: "Membership administration grant required",
    roomId: ROOM,
    missingPermission: "manage_members",
  });
  assert.equal(ax.status, "action_required");
  assert.equal(ax.reason, "access_denied");
  assert.match(ax.hint, /manage_members/);
  assert.ok(ax.hint.length < 160, "hint stays short");
  assert.doesNotMatch(ax.hint, /guest invite/i);
  assert.ok(validAgentNext(ax.next), "next[] stays followable");
  const paths = ax.next.filter(s => s.path).map(s => s.path);
  assert.ok(paths.includes(`/api/rooms/${ROOM}/access-requests`),
    `next must include the room access-requests path, got ${JSON.stringify(paths)}`);
  assert.ok(ax.next.some(s => s.tool === "room_check_access"));
  const cmds = ax.next.filter(s => s.command).map(s => s.command).join(" ");
  assert.match(cmds, /manage_members/);
  assert.doesNotMatch(cmds, /guest invite/i);
});

// 4. owner_required keeps its reason code when annotated.
test("owner_required denial with missingPermission keeps owner_required reason", () => {
  const ax = agentErrorAx({
    httpStatus: 403,
    code: "owner_required",
    message: "Only the room owner can manage agent connections",
    roomId: ROOM,
    missingPermission: "manage_members",
  });
  assert.equal(ax.reason, "owner_required");
  assert.match(ax.hint, /manage_members/);
  assert.ok(validAgentNext(ax.next));
});

// 5. Backward compatibility: unannotated 403s keep the legacy envelope.
test("unannotated 403 keeps the legacy access_denied AX", () => {
  const ax = agentErrorAx({ httpStatus: 403, code: "access_denied", message: "nope", roomId: ROOM });
  assert.equal(ax.reason, "access_denied");
  assert.doesNotMatch(ax.hint, /Missing permission/);
});

// 6. agentErrorBody threads the annotation through to the wire envelope.
test("agentErrorBody carries the permission-aware hint/next", () => {
  const body = agentErrorBody({
    httpStatus: 403,
    code: "access_denied",
    message: "Invite grant required",
    roomId: ROOM,
    missingPermission: "invite_member",
  });
  assert.match(body.hint, /invite_member/);
  assert.ok(validAgentNext(body.next));
  assert.equal(body.error.code, "access_denied");
});

// 7. permissionDenial builds an annotated ServiceError.
test("permissionDenial throws an annotated ServiceError", () => {
  assert.throws(
    () => { throw permissionDenial(403, "access_denied", "Invite grant required", "invite_member"); },
    err => {
      assert.ok(err instanceof ServiceError);
      assert.equal(err.status, 403);
      assert.equal(err.code, "access_denied");
      assert.equal(err.message, "Invite grant required");
      assert.equal(err[ERROR_MISSING_PERMISSION], "invite_member");
      return true;
    });
});

// 8. permissionDenial with an unknown token still throws a valid,
//    unannotated ServiceError (fail-closed at the helper too).
test("permissionDenial with unknown token throws unannotated ServiceError", () => {
  try {
    throw permissionDenial(403, "access_denied", "nope", "read");
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof ServiceError);
    assert.equal(err[ERROR_MISSING_PERMISSION], undefined);
  }
});

// 9. End to end: an annotated error through agentErrorBody reads like a
//    recovery recipe, not a dead end.
test("annotated denial envelope is a recovery recipe", () => {
  let err;
  try { throw permissionDenial(403, "access_denied", "Agent needs accept_work", "accept_work"); }
  catch (e) { err = e; }
  const body = agentErrorBody({
    httpStatus: err.status,
    code: err.code,
    message: err.message,
    roomId: ROOM,
    missingPermission: err[ERROR_MISSING_PERMISSION],
  });
  assert.match(body.hint, /accept_work/);
  assert.match(JSON.stringify(body.next), /access-requests/);
});
