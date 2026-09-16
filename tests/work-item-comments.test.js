// K026: work-item comments with @mentions. Pure manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createComments, extractMentions, CommentError } from "../server/work-comments.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof CommentError && error.code === code);

test("add/list with mention extraction", () => {
  const cm = createComments();
  const c1 = cm.add("wi-1", { authorId: "ada", text: "Hey @bob, can you review this? @bob" });
  assert.ok(c1.commentId.startsWith("c-"));
  assert.deepEqual(c1.mentions, ["bob"]);
  assert.ok(Object.isFrozen(c1));
  cm.add("wi-1", { authorId: "bob", text: "On it!" });
  assert.equal(cm.list("wi-1").length, 2);
  assert.equal(cm.list("wi-2").length, 0);
});
test("extractMentions handles edge cases", () => {
  assert.deepEqual(extractMentions("no mentions"), []);
  assert.deepEqual(extractMentions("@ada and @bob_123"), ["ada", "bob_123"]);
});
test("malformed inputs are refused", () => {
  const cm = createComments();
  throwsCode(() => cm.add("wi-1", { authorId: "a", text: "" }), "invalid_comment");
  throwsCode(() => extractMentions(123), "invalid_comment");
});
