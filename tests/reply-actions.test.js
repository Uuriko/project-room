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
