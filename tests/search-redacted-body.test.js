// A live redacted message keeps a null body and no deletedAt. Room search
// must skip that text instead of throwing, and still return other matches.
import test from "node:test";
import assert from "node:assert/strict";
import { searchMessages } from "../src/conversation.js";

const state = {
  messages: [
    { id: "redacted-msg", body: null, redacted: true, authorId: "owner", createdAt: "2026-10-08T00:00:00.000Z" },
    { id: "live-msg", body: "hello from the room", authorId: "owner", createdAt: "2026-10-08T00:01:00.000Z" },
  ],
  members: { owner: { id: "owner", displayName: "Owner", active: true } },
  pins: [],
};

test("searchMessages skips a redacted null body and still returns other matches", () => {
  const result = searchMessages(state, "hello");
  assert.deepEqual(result.messages.map(message => message.id), ["live-msg"]);
  assert.equal(result.total, 1);
  assert.equal(result.messages.some(message => message.id === "redacted-msg"), false);
});

test("searchMessages does not throw when the only hit candidate has a null body", () => {
  const only = { ...state, messages: [state.messages[0]] };
  const result = searchMessages(only, "hello");
  assert.deepEqual(result.messages, []);
  assert.equal(result.total, 0);
});
