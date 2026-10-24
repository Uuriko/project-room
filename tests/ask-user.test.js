// room_ask_user: an agent asks a person a question on the existing reply
// request (ask card). The hosted server defaults the recipient to the owner.
import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { buildReplyCommand, askUserBody, replyTools } from "../client/reply-actions.mjs";
import { callHostedStdioTool } from "../server/mcp-full-profile.mjs";

test("askUserBody lists numbered options under the question", () => {
  assert.equal(askUserBody("Ship it?"), "Ship it?");
  assert.equal(askUserBody("Ship it?", ["yes", "no"]), "Ship it?\n\nOptions:\n1. yes\n2. no\nReply with a number or your own answer.");
  assert.ok(replyTools.some(tool => tool.name === "room_ask_user"));
});

test("room_ask_user builds the same command as room_request_reply", () => {
  const identity = { roomId: "commons", memberId: "agent" };
  const command = buildReplyCommand(identity, "room_ask_user", { requestId: "ask-1", question: "Which branch?", options: ["main", "dev"], toMemberId: "owner" });
  assert.equal(command.type, "message.posted");
  assert.equal(command.data.requestKind, "reply");
  assert.equal(command.data.toMemberId, "owner");
  assert.match(command.data.body, /^Which branch\?\n\nOptions:\n1\. main\n2\. dev/);
  assert.throws(() => buildReplyCommand(identity, "room_ask_user", { requestId: "ask-2", question: "x" }), { code: "ask_user_needs_member" });
  assert.throws(() => buildReplyCommand(identity, "room_ask_user", { requestId: "ask-3", question: "x", toMemberId: "owner", options: ["only one"] }), { code: "invalid_reply_action" });
});

test("hosted room_ask_user asks the room owner by default and opens a request", async () => {
  const f = createAcceptanceFixture();
  try {
    const identity = f.store.identities.create("asker");
    f.store.identities.link(f.keys.owner, "commons", { identityId: identity.identityId, memberId: "asker", displayName: "Asker", permissions: ["accept_work"] });
    const out = await callHostedStdioTool(f.store, identity.secret, "room_ask_user", { roomId: "commons", requestId: "ask-owner-1", question: "Merge now?", options: ["yes", "wait"] });
    assert.equal(out.isError, false, JSON.stringify(out.value));
    assert.equal(out.value.status, "recorded");
    assert.equal(out.value.next.tool, "room_read_request");
    const ownerId = f.store.roomAuthority("commons").ownerId;
    const open = Object.values(f.store.room("commons").state.replyRequests ?? {}).find(request => request.id === out.value.requestMessageId);
    assert.ok(open, "a reply request is open");
    assert.equal(open.recipientId, ownerId);
    assert.equal(open.status, "open");
  } finally { f.store.close(); }
});
