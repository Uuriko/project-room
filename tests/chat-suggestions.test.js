import test from "node:test";
import assert from "node:assert/strict";
import { replyChoices, chatSuggestions } from "../src/chat-suggestions.js";
const msg = (body, extra = {}) => ({ id: "m1", authorId: "sender", body, ...extra });
test("only sender-authored choices offer shortcuts", () => {
  assert.deepEqual(replyChoices(msg("Pick a format.\nOptions: Short | Detailed")), ["Short", "Detailed"]);
  assert.deepEqual(replyChoices(msg("Choices: red / blue")), ["Red", "Blue"]);
  for (const body of ["Should we ship?", "Short or detailed?", "Can someone build this by Friday?", "Where is the report?"]) {
    assert.equal(chatSuggestions(msg(body), { viewerId: "reader" }), null);
  }
});
test("choices remain bounded and do not invent malformed options", () => {
  for (const body of ["Options: One", "Options: One | one", "Options: A | B | C | D | E", "Options: A | " + "x".repeat(41), "Options: A | B\nNot the final line"]) assert.equal(replyChoices(msg(body)), null);
  assert.equal(replyChoices(msg(null)), null);
});
test("own, deleted and dismissed messages cannot offer replies", () => {
  const source = msg("Options: Short | Detailed");
  assert.equal(chatSuggestions(source, { viewerId: "sender" }), null);
  assert.equal(chatSuggestions({ ...source, deletedAt: "now" }, { viewerId: "reader" }), null);
  assert.equal(chatSuggestions(source, { viewerId: "reader", dismissed: new Set([source.id]) }), null);
});
test("reply shortcuts never cross public and private draft audiences", () => {
  const source = msg("Options: Short | Detailed");
  assert.deepEqual(chatSuggestions(source, { viewerId: "reader" }), { messageId: "m1", choices: ["Short", "Detailed"] });
  assert.equal(chatSuggestions(source, { viewerId: "reader", recipientId: "sender" }), null);
  const privateSource = { ...source, toMemberId: "reader" };
  assert.equal(chatSuggestions({ ...privateSource, toMemberId: "other" }, { viewerId: "reader", recipientId: "sender" }), null);
  assert.equal(chatSuggestions(privateSource, { viewerId: "reader" }), null);
  assert.equal(chatSuggestions(privateSource, { viewerId: "reader", recipientId: "other" }), null);
  assert.deepEqual(chatSuggestions(privateSource, { viewerId: "reader", recipientId: "sender" }), { messageId: "m1", choices: ["Short", "Detailed"] });
});
