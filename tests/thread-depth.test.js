// K011: threaded reply depth. Pure tree tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildThreadTree, flattenThreads, ThreadError } from "../server/thread-tree.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ThreadError && error.code === code);

test("builds tree with depth", () => {
  const tree = buildThreadTree({ messages: [
    { messageId: "m1", replyTo: null, text: "root" },
    { messageId: "m2", replyTo: "m1", text: "reply" },
    { messageId: "m3", replyTo: "m2", text: "nested" },
    { messageId: "m4", replyTo: null, text: "root2" },
  ]});
  assert.equal(tree.length, 2);
  assert.equal(tree[0].depth, 0);
  assert.equal(tree[0].children[0].depth, 1);
  assert.equal(tree[0].children[0].children[0].depth, 2);
  assert.ok(Object.isFrozen(tree));
});
test("flatten respects collapse", () => {
  const tree = buildThreadTree({ messages: [
    { messageId: "m1", replyTo: null, text: "root" },
    { messageId: "m2", replyTo: "m1", text: "reply" },
  ]});
  const flat = flattenThreads({ tree, collapsedIds: new Set(["m1"]) });
  assert.equal(flat.length, 2);
  assert.equal(flat[0].visible, true);
  assert.equal(flat[1].visible, false); // hidden by collapse
});
test("malformed inputs are refused", () => {
  throwsCode(() => buildThreadTree({ messages: "nope" }), "invalid_thread");
  throwsCode(() => buildThreadTree({ messages: [{ messageId: "m1" }, { messageId: "m1" }] }),
    "invalid_thread");
});
