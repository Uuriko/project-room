import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { RoomAgentClient, RoomClientError, AGENT_ERRORS } from "../client/room-agent.mjs";
import { workActionRefusal } from "../client/work-actions.mjs";
import { connectionDiagnostic } from "../client/agent-connection.mjs";
import { serveRoomMcp } from "../client/mcp-stdio.mjs";
import { agentErrorAx, agentErrorBody, validAgentNext } from "../src/agent-error.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";

function assertAx(value, { reason, status = "action_required" } = {}) {
  assert.equal(value.status === status || value.errorStatus === status, true, "AX status");
  if (reason) assert.equal(value.reason, reason);
  assert.equal(typeof value.hint, "string");
  assert.ok(value.hint.length > 0 && value.hint.length < 160, "short hint");
  assert.doesNotMatch(value.hint, /plugin\.jup\.ag|potter[_-]?key|people-data/i);
  assert.ok(validAgentNext(value.next), "next[]");
  assert.ok(value.next.some(step => step.path || step.command || step.tool), "followable next");
}

async function live(t) {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const client = actor => new RoomAgentClient({ origin, roomId: "commons", token: f.keys[actor] });
  const request = (path, { method = "GET", token, data } = {}) => fetch(`${origin}${path}`, {
    method, headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { ...f, origin, client, request };
}

test("shared mapper keeps error.code/message and adds status/reason/hint/next", () => {
  const src = readFileSync(new URL("../src/agent-error.mjs", import.meta.url), "utf8");
  assert.match(src, /AGENT_ERRORS = "code\/message \+ status\/reason\/hint\/next"/);
  const key = agentErrorBody({ httpStatus: 401, code: "unauthenticated", message: "Sign in with an active room key or agent identity secret" });
  assert.deepEqual(key.error, { code: "unauthenticated", message: "Sign in with an active room key or agent identity secret" });
  assertAx(key, { reason: "unauthenticated" });
  assert.ok(key.next.some(step => step.tool === "room_check_access"));
  assert.ok(key.next.some(step => step.path === "/api/session"));
  const denied = agentErrorAx({ httpStatus: 403, code: "owner_required", message: "Only the signed-in room owner can manage agent connections" });
  assertAx(denied, { reason: "owner_required" });
  const wrongOrigin = agentErrorAx({ httpStatus: 403, code: "origin_denied", message: "Request origin is not allowed" });
  assertAx(wrongOrigin, { reason: "origin_denied" });
  assert.equal(wrongOrigin.hint, "Use Origin: https://room.trydemigod.com or omit the Origin header.");
  const requiredOrigin = agentErrorAx({ httpStatus: 403, code: "origin_denied", message: "Origin header is required" });
  assert.equal(requiredOrigin.hint, "Send Origin: https://room.trydemigod.com. This route does not accept a missing or different Origin header.");
  assert.equal(requiredOrigin.hint.includes("omit"), false);
  assert.equal(JSON.stringify(requiredOrigin.next).includes("Do not omit"), true);
  assert.equal(JSON.stringify(wrongOrigin).includes("guest invite"), false);
  assert.equal(JSON.stringify(wrongOrigin).includes("Add agent"), false);
  const stale = agentErrorAx({ httpStatus: 409, code: "command_rejected", message: "Stale Work Item revision: expected 1", workItemId: "test-handoff", roomId: "commons" });
  assertAx(stale, { reason: "stale_revision" });
  assert.ok(stale.next.some(step => step.tool === "room_read_work"));
  const credentialChanged = agentErrorAx({ httpStatus: 409, code: "identity_credential_changed", message: "Saved credential is stale" });
  assertAx(credentialChanged, { reason: "identity_credential_changed" });
  assert.ok(!credentialChanged.next.some(step => step.tool === "room_read_work"), "credential recovery is not a work revision retry");
  const missing = agentErrorAx({ httpStatus: 404, code: "work_not_found", message: "Work item not found in this Room", roomId: "commons" });
  assertAx(missing, { reason: "work_not_found" });
  assert.ok(missing.next.some(step => step.tool === "room_list_work"));
  // RC-2026-09-18-035: an unknown-member rejection teaches the member lookup,
  // not the stale-revision advice.
  const unknownMember = agentErrorAx({ httpStatus: 422, code: "command_rejected", message: "Unknown member: m_unknown", roomId: "commons" });
  assertAx(unknownMember, { reason: "unknown_member" });
  assert.ok(unknownMember.hint.includes("not in this room"));
  assert.ok(unknownMember.next.some(step => step.path === "/api/rooms/commons/presence"));
  assert.ok(!unknownMember.next.some(step => step.tool === "room_read_work"),
    "unknown member must not point at a work re-read");
  const trustOff = agentErrorAx({ httpStatus: 403, code: "trust_off", message: "Room Trust is off: cross-owner assign and wake are blocked (foreign). Ask the room owner to turn Trust on.", roomId: "commons" });
  assertAx(trustOff, { reason: "trust_off" });
  assert.match(trustOff.hint, /turn Trust on/);
  assert.match(trustOff.hint, /Same-owner/);
  assert.ok(trustOff.next.some(step => /room\.trust_set/.test(step.command)));
  const claimed = agentErrorAx({ httpStatus: 409, code: "session_claimed", message: "Claim held by agent-b", roomId: "commons", workItemId: "session-one" });
  assertAx(claimed, { reason: "session_claimed" });
  assert.match(claimed.hint, /agent-b holds this claim/);
  assert.match(claimed.hint, /stale heartbeat/);
  assert.match(claimed.hint, /supersede/);
  assert.ok(claimed.next.some(step => step.command?.includes("agent-b")));
  const claimedGeneric = agentErrorAx({ httpStatus: 409, code: "session_claimed", message: "Another member is working on this" });
  assert.match(claimedGeneric.hint, /Another member holds this claim/);
  const unsigned = agentErrorAx({ httpStatus: 422, code: "missing_signed_evidence", message: "unsigned external evidence is rejected", roomId: "commons", workItemId: "test-handoff" });
  assertAx(unsigned, { reason: "missing_signed_evidence" });
  assert.match(unsigned.hint, /evidenceKind room_text/);
  assert.match(unsigned.hint, /signedEvidence/);
  assert.doesNotMatch(unsigned.hint, /unsigned URL is (ok|accepted|enough)/i);
  const unsignedNext = JSON.stringify(unsigned.next);
  for (const field of ["evidenceKind", "room_text", "evidenceMessageId", "evidenceMessageEventId", "previousCompletionEventId", "producerId", "evidenceVersion", "signedEvidence"]) {
    assert.match(unsignedNext, new RegExp(field));
  }
  assert.match(unsignedNext, /unsigned evidenceUrl stays rejected/);
  assert.ok(unsigned.next.some(step => step.tool === "room_submit_text_result"));
  const refused = agentErrorAx({ httpStatus: 0, code: "invalid_work_action", message: "" });
  assertAx(refused, { reason: "input_refused" });
  assert.equal(agentErrorAx({ httpStatus: 500, code: "internal_error", message: "" }).status, "failed");
  const leaky = agentErrorAx({ httpStatus: 404, code: "PRIVATE_DETAIL token", message: "do not paste" });
  assert.equal(leaky.reason, "request_failed");
  assert.doesNotMatch(JSON.stringify(leaky), /PRIVATE_DETAIL|do not paste|plugin\.jup\.ag/);
});

test("live 401/403/stale-revision/unknown-work/input-refused return next agents can follow", async t => {
  const f = await live(t);
  const unauth = await f.request("/api/rooms/commons/work-context?workItemId=test-handoff");
  assert.equal(unauth.status, 401);
  const unauthBody = await unauth.json();
  assert.equal(unauthBody.error.code, "unauthenticated");
  assert.equal(typeof unauthBody.error.message, "string");
  assertAx(unauthBody, { reason: "unauthenticated" });

  // A saved credential rejected by the live service must not send an agent
  // into creating a replacement identity. Reading recovery steps changes no state.
  const beforeIdentities = f.store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n;
  const savedSecret = "pri_" + "z".repeat(43);
  const savedFailure = await f.request("/api/agent-rooms", { token: savedSecret });
  assert.equal(savedFailure.status, 401);
  const recovery = await savedFailure.json();
  assert.equal(recovery.next[0].tool, "room_check_access");
  assert.ok(recovery.next.some(step => step.path === "/api/agent-rooms"));
  assert.match(recovery.hint, /saved connection/i);
  assert.doesNotMatch(JSON.stringify(recovery), /self-mint|Mint an identity|pri_z/);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM agent_identities").get().n, beforeIdentities);

  const forbidden = await f.request("/api/rooms/commons/agent-connections", { token: f.keys.producer });
  assert.equal(forbidden.status, 403);
  const forbiddenBody = await forbidden.json();
  assert.equal(forbiddenBody.error.code, "owner_required");
  assertAx(forbiddenBody, { reason: "owner_required" });

  const missing = await f.request("/api/rooms/commons/work-context?workItemId=no-such-work", { token: f.keys.producer });
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, "work_not_found");
  assertAx(missingBody, { reason: "work_not_found" });
  assert.ok(missingBody.next.some(step => step.tool === "room_list_work"));

  const invalid = await f.request("/api/rooms/commons/work-context", { token: f.keys.producer });
  assert.equal(invalid.status, 422);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, "invalid_work_context");
  assertAx(invalidBody, { reason: "input_refused" });

  const producer = f.client("producer");
  const before = await producer.workContext("test-handoff");
  await producer.command({ id: "ax-accept", type: T.WORK_ACCEPTED, data: { workItemId: "test-handoff", expectedRevision: before.work.revision } });
  const stale = await f.request("/api/rooms/commons/commands", {
    method: "POST", token: f.keys.producer,
    data: { id: "ax-stale", type: T.WORK_STARTED, data: { workItemId: "test-handoff", expectedRevision: before.work.revision } }
  });
  assert.equal(stale.status, 409);
  const staleBody = await stale.json();
  assert.equal(staleBody.error.code, "command_rejected");
  assert.match(staleBody.error.message, /Stale/);
  assertAx(staleBody, { reason: "stale_revision" });
  assert.ok(staleBody.next.some(step => step.tool === "room_read_work"));

  await assert.rejects(producer.workContext("no-such-work"), error => {
    assert.ok(error instanceof RoomClientError);
    assert.equal(error.status, 404);
    assert.equal(error.code, "work_not_found");
    assertAx(error, { reason: "work_not_found" });
    return true;
  });
  await assert.rejects(producer.command({
    id: "ax-stale-client", type: T.WORK_STARTED, data: { workItemId: "test-handoff", expectedRevision: before.work.revision }
  }), error => {
    assert.equal(error.status, 409);
    assert.equal(error.code, "command_rejected");
    assertAx(error, { reason: "stale_revision" });
    return true;
  });
});

test("orient advertises errors include next; MCP structured refusals follow the same shape", async t => {
  const f = await live(t);
  const orientation = await f.client("producer").orient();
  assert.equal(orientation.errors, AGENT_ERRORS);
  assert.equal(orientation.errors, "code/message + status/reason/hint/next");
  const focused = await f.client("producer").orient({ focus: "needs_me" });
  assert.equal(focused.errors, AGENT_ERRORS);

  const refused = workActionRefusal({ status: 0, code: "invalid_work_action", message: "PRIVATE SECRET" });
  assert.equal(refused.type, "work_input_refused");
  assert.equal(JSON.stringify(refused).includes("PRIVATE SECRET"), false);
  assertAx(refused, { reason: "input_refused" });
  assert.ok(refused.next.some(step => step.tool === "room_read_work"));

  const diagnostic = connectionDiagnostic(new RoomClientError(401, "unauthenticated", "PRIVATE SECRET"));
  assert.equal(diagnostic.code, "access_ended");
  assert.equal(JSON.stringify(diagnostic).includes("PRIVATE SECRET"), false);
  assertAx(diagnostic, { reason: "unauthenticated" });

  const input = new PassThrough(), output = new PassThrough(), pending = new Map();
  let text = "";
  const server = serveRoomMcp({
    client: { command: async () => { throw new RoomClientError(409, "command_rejected", "Stale Work Item revision: expected 1"); } },
    roomId: "commons", memberId: "agent", input, output
  });
  output.on("data", chunk => { text += chunk; let end; while ((end = text.indexOf("\n")) >= 0) {
    const reply = JSON.parse(text.slice(0, end)); text = text.slice(end + 1); pending.get(reply.id)?.(reply); pending.delete(reply.id);
  } });
  const rpc = (method, params, id) => new Promise(resolve => { pending.set(id, resolve); input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  t.after(() => { server.stop(); input.destroy(); output.destroy(); });
  const init = await rpc("initialize", { protocolVersion: "2099-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" } }, "init");
  assert.match(init.result.instructions, /status\/reason\/hint\/next/);
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await tick();
  const call = await rpc("tools/call", { name: "room_accept_work", arguments: { requestId: "accept", workItemId: "work", expectedRevision: 0 } }, "accept");
  const value = call.result.structuredContent;
  assert.equal(call.result.isError, true);
  assert.equal(value.code, "command_rejected");
  assert.equal(JSON.stringify(call).includes("Stale Work Item"), false);
  assertAx(value, { reason: "stale_revision" });
  assert.ok(value.next.some(step => step.tool === "room_read_work"));
});

test("unsigned work.completed names room_text fields, then a room_text completion succeeds", async t => {
  const f = await live(t);
  const producer = f.client("producer");
  const proposed = await producer.workContext("test-handoff");
  await producer.command({ id: "ax-ev-accept", type: T.WORK_ACCEPTED, data: { workItemId: "test-handoff", expectedRevision: proposed.work.revision } });
  const accepted = await producer.workContext("test-handoff");
  await producer.command({ id: "ax-ev-start", type: T.WORK_STARTED, data: { workItemId: "test-handoff", expectedRevision: accepted.work.revision } });
  const working = await producer.workContext("test-handoff");
  assert.equal(working.work.state, "working");

  const unsigned = await f.request("/api/rooms/commons/commands", {
    method: "POST", token: f.keys.producer,
    data: {
      id: "ax-ev-unsigned", type: T.WORK_COMPLETED,
      data: {
        workItemId: "test-handoff", expectedRevision: working.work.revision,
        summary: "unsigned url", evidenceUrl: "https://example.invalid/result",
        evidenceVersion: "v1", nextAction: "Review"
      }
    }
  });
  assert.equal(unsigned.status, 422);
  const unsignedBody = await unsigned.json();
  assert.equal(unsignedBody.error.code, "missing_signed_evidence");
  assert.match(unsignedBody.error.message, /unsigned external evidence is rejected/);
  assert.match(unsignedBody.error.message, /evidenceKind room_text/);
  for (const field of ["evidenceMessageId", "evidenceMessageEventId", "previousCompletionEventId", "producerId", "evidenceVersion"]) {
    assert.match(unsignedBody.error.message, new RegExp(field));
  }
  assertAx(unsignedBody, { reason: "missing_signed_evidence" });
  assert.match(unsignedBody.hint, /room_text/);
  const still = await producer.workContext("test-handoff");
  assert.equal(still.work.state, "working");
  assert.equal(still.work.revision, working.work.revision);

  const body = "the exact in-room result";
  const messageId = `ax-result-${randomUUID()}`;
  const posted = await producer.command({
    id: "ax-ev-post", type: T.MESSAGE_POSTED,
    data: { messageId, workItemId: "test-handoff", body }
  });
  const evidenceVersion = `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
  const done = await f.request("/api/rooms/commons/commands", {
    method: "POST", token: f.keys.producer,
    data: {
      id: "ax-ev-room-text", type: T.WORK_COMPLETED,
      data: {
        workItemId: "test-handoff", expectedRevision: still.work.revision,
        summary: "in-room result", nextAction: "Review the room message",
        evidenceKind: "room_text", evidenceMessageId: messageId,
        evidenceMessageEventId: posted.event.id, previousCompletionEventId: null,
        producerId: null, evidenceVersion
      }
    }
  });
  assert.equal(done.status, 201);
  const completed = await producer.workContext("test-handoff");
  assert.equal(completed.work.state, "completed");
  assert.equal(completed.work.receipt.evidenceVersion, evidenceVersion);
  assert.equal(completed.work.receipt.evidenceUrl, null);
  assert.equal(completed.work.receipt.nativeText.kind, "room_text");
  assert.equal(completed.work.receipt.nativeText.messageId, messageId);
  assert.equal(Object.hasOwn(completed.work.receipt, "signedEvidence"), false);
});
