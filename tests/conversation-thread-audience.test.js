import test from "node:test";
import assert from "node:assert/strict";
import { conversationIndex, conversationThreadMessages } from "../src/conversation.js";

test("private requests citing a public result do not inflate its public reply count", () => {
  const messages = [
    { id: "result", authorId: "owner", toMemberId: null },
    { id: "question-a", replyToId: "result", authorId: "owner", toMemberId: "alice" },
    { id: "question-b", replyToId: "result", authorId: "owner", toMemberId: "bob" },
    { id: "answer-a", replyToId: "question-a", authorId: "alice", toMemberId: "owner" },
    { id: "public-reply", replyToId: "result", authorId: "bob", toMemberId: null }
  ];
  const index = conversationIndex(messages);
  const ids = (viewer, peer) => conversationThreadMessages(index, "result", viewer, peer).map(message => message.id);
  assert.deepEqual(ids("owner"), ["result", "public-reply"]);
  assert.deepEqual(ids("owner", "alice"), ["question-a", "answer-a"]);
  assert.deepEqual(ids("alice", "owner"), ["question-a", "answer-a"]);
  assert.deepEqual(ids("owner", "bob"), ["question-b"]);
  assert.deepEqual(ids("outsider", "alice"), []);
  assert.equal(index.rootById.get("answer-a"), "result", "source linkage remains intact");
  assert.equal(index.byId.size, 5, "filtering never removes source data");
});

test("a result with only private replies has no public replies, including tombstones", () => {
  const index = conversationIndex([
    { id: "result", authorId: "owner" },
    { id: "question", replyToId: "result", authorId: "owner", toMemberId: "alice", deletedAt: "2026-10-28" }
  ]);
  assert.deepEqual(conversationThreadMessages(index, "result", "owner").map(message => message.id), ["result"]);
  assert.deepEqual(conversationThreadMessages(index, "missing", "owner"), []);
  assert.equal(conversationThreadMessages(index, "result", "owner", "alice").length, 1, "private tombstones remain in their own thread");
});
