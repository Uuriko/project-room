import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyCommand, replyTools, validReplyArguments } from "../client/reply-actions.mjs";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

// G-H2 and NEXT-3: room_reply's command id IS its idempotency key. An
// omitted requestId is now derived from the tool, room, actor and unchanged
// input, then returned as the command id. The derivation must be stable so a
// retry after an uncertain result reuses the same message id.
const identity = { roomId: "commons", memberId: "agent" };

test("room_reply accepts an omitted requestId", () => {
  assert.equal(validReplyArguments("room_reply", { replyToId: "msg-1", body: "hello" }), true);
  assert.equal(validReplyArguments("room_reply", { requestId: "req-1", replyToId: "msg-1", body: "hello" }), true);
});

test("room_reply derives a stable id and message id when requestId is omitted", () => {
  const args = { replyToId: "msg-1", body: "hello" };
  const first = buildReplyCommand(identity, "room_reply", args);
  const retry = buildReplyCommand(identity, "room_reply", args);
  assert.match(first.id, /^mcp-[a-f0-9]{64}$/);
  assert.equal(first.id, retry.id);
  assert.equal(first.data.messageId, retry.data.messageId);
  const other = buildReplyCommand(identity, "room_reply", { ...args, body: "different" });
  assert.notEqual(other.id, first.id);
});

test("room_reply reuses the supplied requestId as the idempotent command id", () => {
  const args = { requestId: "req-1", replyToId: "msg-1", body: "hello" };
  const first = buildReplyCommand(identity, "room_reply", args);
  const retry = buildReplyCommand(identity, "room_reply", args);
  assert.equal(first.id, "req-1");
  assert.equal(retry.id, first.id);
  assert.equal(retry.data.messageId, first.data.messageId);
});

test("room_reply body matches the message cap and other reply text stays at 4096", () => {
  const reply = replyTools.find(tool => tool.name === "room_reply");
  assert.equal(reply.inputSchema.properties.body.maxLength, MAX_MESSAGE_BODY_CHARS);
  for (const name of ["room_request_reply", "room_respond_to_request", "room_cancel_request"]) {
    const tool = replyTools.find(item => item.name === name);
    const field = name === "room_cancel_request" ? "reason" : "body";
    assert.equal(tool.inputSchema.properties[field].maxLength, 4096, name);
  }
  const body = "a".repeat(MAX_MESSAGE_BODY_CHARS);
  const command = buildReplyCommand(identity, "room_reply", { requestId: "req-long", replyToId: "msg-1", body });
  assert.equal(command.data.body.length, MAX_MESSAGE_BODY_CHARS);
  assert.equal(validReplyArguments("room_reply", { requestId: "req-long", replyToId: "msg-1", body: `${body}b` }), false);
  assert.equal(validReplyArguments("room_request_reply", {
    requestId: "req-long", toMemberId: "owner", body,
  }), false);
});

// F-S6a-2 (narrowed, V2): a template-incomplete room_respond_to_request call —
// any of contextEventId / contextSequence / workItemId missing, all
// schema-optional — used to throw replyPostMode's bare Error out of
// buildReplyCommand, which the hosted MCP door maps to 500 "internal".
// The builder must refuse it up front as a 422 invalid_reply_action naming
// the missing field(s), before any command exists (hence before the
// server-side participant gate, which complete calls still reach unchanged).
const respondBase = { requestId: "req-f6a", responseToRequestId: "reply-abc",
  expectedRequestRevision: 0, responseOutcome: "answered", toMemberId: "requester", body: "done" };
const respondComplete = { ...respondBase, contextEventId: "event-1", contextSequence: 7, workItemId: "wi-1" };
const thrownBy = args => {
  try { buildReplyCommand(identity, "room_respond_to_request", args); } catch (error) { return error; }
  throw new Error("expected buildReplyCommand to throw");
};
// The missing-field list is the segment before the copy instructions, which
// themselves name every template field.
const missingSegment = error => error.message.split(". Copy ")[0];

test("respond with required fields only refuses 422 naming all three template fields", () => {
  const error = thrownBy(respondBase);
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_reply_action");
  for (const field of ["contextEventId", "contextSequence", "workItemId"])
    assert.match(error.message, new RegExp(field), field);
});

test("respond without the context pair refuses 422 naming only the context fields", () => {
  const error = thrownBy({ ...respondBase, workItemId: "wi-1" });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_reply_action");
  assert.match(missingSegment(error), /contextEventId/);
  assert.match(missingSegment(error), /contextSequence/);
  assert.doesNotMatch(missingSegment(error), /workItemId/);
});

test("respond without workItemId refuses 422 naming workItemId", () => {
  const error = thrownBy({ ...respondBase, contextEventId: "event-1", contextSequence: 7 });
  assert.equal(error.status, 422);
  assert.equal(error.code, "invalid_reply_action");
  assert.match(missingSegment(error), /workItemId/);
  assert.doesNotMatch(missingSegment(error), /contextEventId/);
  assert.doesNotMatch(missingSegment(error), /contextSequence/);
});

test("template-complete respond still builds the identical command shape", () => {
  const command = buildReplyCommand(identity, "room_respond_to_request", respondComplete);
  assert.equal(command.type, "message.posted");
  assert.equal(command.data.responseToRequestId, "reply-abc");
  assert.equal(command.data.replyToId, "reply-abc");
  assert.equal(command.data.contextEventId, "event-1");
  assert.equal(command.data.contextSequence, 7);
  assert.equal(command.data.workItemId, "wi-1");
});

test("template-complete respond with a null workItemId still builds (null is present, not missing)", () => {
  const command = buildReplyCommand(identity, "room_respond_to_request", { ...respondComplete, workItemId: null });
  assert.equal(command.data.workItemId, null);
});

test("the incomplete respond shapes stay schema-valid (the fix is handler-side, not a schema change)", () => {
  for (const args of [respondBase, { ...respondBase, workItemId: "wi-1" },
    { ...respondBase, contextEventId: "event-1", contextSequence: 7 }])
    assert.equal(validReplyArguments("room_respond_to_request", args), true);
});
