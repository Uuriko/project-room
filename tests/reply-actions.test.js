import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyCommand, replyTools, validReplyArguments } from "../client/reply-actions.mjs";
import { MAX_MESSAGE_BODY_CHARS } from "../src/events.js";

// G-H2 regression (RC-2026-09-30-3624).
//
// Contract: room_reply's command id IS its idempotency key — the tool's own
// description promises "keep this requestId unchanged on retry". When
// requestId was optional, buildReplyCommand minted a fresh randomUUID() per
// call and used it as the command id and messageId seed, so a retry after
// an ambiguous result posted a duplicate message.
//
// Credible regression: on the pre-fix code, "schema requires requestId"
// fails (requestId was optional) and "rejected with a named error" fails
// (no throw — a UUID was minted and the duplicate-prone command succeeded).
// "reuses the supplied requestId" passes on both revisions: it pins the
// idempotent contract going forward (a future change that ignored a supplied
// requestId would fail it).
//
// Why new coverage: no test covered buildReplyCommand's requestId fallback
// or the room_reply schema's required fields. No production seams: the real
// buildReplyCommand boundary is exercised directly.
const identity = { roomId: "commons", memberId: "agent" };

test("room_reply schema requires requestId", () => {
  assert.equal(validReplyArguments("room_reply", { replyToId: "msg-1", body: "hello" }), false);
  assert.equal(validReplyArguments("room_reply", { requestId: "req-1", replyToId: "msg-1", body: "hello" }), true);
});

test("room_reply without requestId is rejected with a named error", () => {
  assert.throws(
    () => buildReplyCommand(identity, "room_reply", { replyToId: "msg-1", body: "hello" }),
    err => err.code === "missing_request_id" && /requestId/.test(err.message)
  );
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
