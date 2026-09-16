// K021: action-item extraction. Pure heuristic tests.
import test from "node:test";
import assert from "node:assert/strict";
import { extractActionItems, ExtractionError } from "../server/action-extract.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ExtractionError && error.code === code);

test("extracts prefixed and imperative action items", () => {
  const items = extractActionItems({ messages: [
    { messageId: "m1", authorId: "ada", text: "Action: fix the login bug by Friday" },
    { messageId: "m2", authorId: "bob", text: "Review the PR @ada" },
    { messageId: "m3", authorId: "ada", text: "What do you think about the design?" },
    { messageId: "m4", authorId: "bob", text: "TODO - update the docs" },
  ]});
  assert.ok(items.length >= 3, `expected >=3, got ${items.length}`);
  assert.equal(items[0].messageId, "m1"); // highest score (prefix + due)
  assert.deepEqual(items[0].assignees, []);
  assert.ok(items[0].due !== null);
  const m2 = items.find(i => i.messageId === "m2");
  assert.deepEqual(m2.assignees, ["ada"]);
  assert.ok(!items.some(i => i.messageId === "m3")); // question filtered
  assert.ok(Object.isFrozen(items));
});
test("malformed inputs are refused", () => {
  throwsCode(() => extractActionItems({ messages: "nope" }), "invalid_extraction");
  throwsCode(() => extractActionItems({ messages: [{ text: "hi" }] }), "invalid_extraction");
});
