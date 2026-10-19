import test from "node:test";
import assert from "node:assert/strict";
import { RoomClient } from "../src/client.js";
import { agentErrorBody } from "../src/agent-error.mjs";
import { humanErrorMessage } from "../src/error-copy.js";

// SEAMS-FIX-TRANSPORT pinning tests (HUNT-SEAMS List 2.1): the server's error
// envelope carries recovery guidance (reason/hint/next) that the agent door
// consumes. RoomClient.request used to keep only message + status + code, so
// every web user hit a bare, unactionable error. These tests feed the client
// envelopes built by the real agentErrorBody and pin that the guidance now
// survives onto the thrown error and into its display text.
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const failingClient = body => new RoomClient({ fetcher: async () => response(body, body.statusCode ?? 409) });
const envelope = ({ httpStatus, ...rest }) => ({ ...agentErrorBody({ httpStatus, ...rest }), statusCode: httpStatus });

test("409 session_claimed: hint, next and reason survive onto the thrown error", async () => {
  const body = envelope({ httpStatus: 409, code: "session_claimed", message: "Claim held by worker-7", roomId: "commons", workItemId: "w1" });
  assert.ok(body.hint, "fixture envelope must carry a hint");
  assert.equal(body.next.length, 2, "fixture envelope must carry two next steps");
  const error = await failingClient(body).request("/api/rooms/commons/commands", { method: "POST", data: {} }).catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "session_claimed");
  assert.equal(error.reason, "session_claimed");
  assert.equal(error.hint, body.hint);
  assert.deepEqual(error.next, body.next);
  // The display text keeps the human message and renders the hint, so the
  // guidance is visible at every surface that renders error.message.
  assert.match(error.message, /^Claim held by worker-7/);
  assert.ok(error.message.includes("worker-7 holds this claim"), "hint holder text rendered");
  assert.ok(error.message.includes("stale heartbeat (10 min)"), "hint recovery window rendered");
  // The command step restates the hint almost verbatim; it must not be
  // rendered a second time as a near-duplicate.
  assert.ok(!error.message.includes("Wait for worker-7 to release this claim"), "near-duplicate next step not repeated");
});

test("403 member_required: a second 4xx class carries its next actions too", async () => {
  const body = envelope({ httpStatus: 403, code: "member_required", message: "A member is required", roomId: "commons" });
  assert.deepEqual(body.next, [{ tool: "room_check_access" }], "fixture envelope shape");
  const error = await failingClient(body).request("/api/rooms/commons/commands", { method: "POST", data: {} }).catch(e => e);
  assert.equal(error.status, 403);
  assert.equal(error.code, "member_required");
  assert.equal(error.reason, "member_required");
  assert.equal(error.hint, "Set the expected agent member, then room_check_access.");
  assert.deepEqual(error.next, body.next);
  assert.ok(error.message.includes("Set the expected agent member"), "hint rendered in display text");
});

test("a next step that extends the hint is rendered, not swallowed", async () => {
  const body = envelope({ httpStatus: 409, code: "identity_credential_changed", message: "Credential changed", roomId: "commons" });
  const step = body.next.find(entry => typeof entry.command === "string");
  assert.ok(step?.command.includes("Locate the current saved identity credential"), "fixture step shape");
  const error = await failingClient(body).request("/api/rooms/commons/commands", { method: "POST", data: {} }).catch(e => e);
  assert.equal(error.hint, body.hint);
  assert.deepEqual(error.next, body.next);
  assert.ok(error.message.includes("saved credential has changed or was revoked"), "hint rendered");
  assert.ok(error.message.includes("Locate the current saved identity credential"), "extending next step rendered");
  assert.ok(error.message.includes("Do not rotate"), "extending next step rendered in full");
});

test("bare error bodies without an envelope keep the previous behaviour exactly", async () => {
  const body = { error: { code: "room_archived", message: "archived" } };
  const error = await failingClient(body).request("/api/session").catch(e => e);
  assert.equal(error.status, 409);
  assert.equal(error.code, "room_archived");
  assert.equal(error.reason, null);
  assert.equal(error.hint, null);
  assert.equal(error.next, null);
  assert.equal(error.message, humanErrorMessage({ status: 409, code: "room_archived", message: "archived" }));
});

test("successful requests are untouched by the envelope handling", async () => {
  const payload = { sequence: 7, roomId: "commons" };
  const client = new RoomClient({ fetcher: async () => response(payload) });
  assert.deepEqual(await client.request("/api/session"), payload);
});
