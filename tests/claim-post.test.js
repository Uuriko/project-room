// B004: claim-enforcing room.post. Pure validator tests; no wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { validatePost, partitionPosts, PostError } from "../server/claim-post.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof PostError && error.code === code);
const claims = () => [
  { id: "a012", owner: "quill", state: "in_progress" },
  { id: "b005", owner: "grok", state: "claimed" },
  { id: "c001", owner: "quill", state: "done" },
];

test("free posts and owner posts pass without a claim", () => {
  const free = validatePost({ authorId: "quill", body: "hello" }, claims());
  assert.equal(free.enforced, false);
  const owner = validatePost({ authorId: "john", body: "note", workId: "a012" }, claims(), { ownerId: "john" });
  assert.equal(owner.enforced, false);
  assert.ok(Object.isFrozen(free));
});
test("claim holders may post against their work", () => {
  const accepted = validatePost({ authorId: "quill", body: "update", workId: "a012" }, claims());
  assert.equal(accepted.enforced, true);
  assert.equal(accepted.workId, "a012");
  // done work is postable by anyone
  const done = validatePost({ authorId: "grok", body: "nice", workId: "c001" }, claims());
  assert.equal(done.enforced, true);
});
test("unclaimed work and foreign claims are refused", () => {
  throwsCode(() => validatePost({ authorId: "quill", body: "x", workId: "zzz" }, claims()), "claim_required");
  throwsCode(() => validatePost({ authorId: "quill", body: "x", workId: "b005" }, claims()), "claim_required");
  throwsCode(() => validatePost({ authorId: "quill", body: "" }, claims()), "invalid_post");
  throwsCode(() => validatePost({ authorId: "quill", body: "x", workId: "a012" }, "nope"), "invalid_post");
});
test("partitionPosts splits accepted and refused", () => {
  const { accepted, refused } = partitionPosts([
    { authorId: "quill", body: "ok", workId: "a012" },
    { authorId: "quill", body: "free" },
    { authorId: "quill", body: "bad", workId: "b005" },
  ], claims());
  assert.equal(accepted.length, 2);
  assert.equal(refused.length, 1);
  assert.equal(refused[0].code, "claim_required");
});
