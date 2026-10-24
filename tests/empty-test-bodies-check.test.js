// Tests for the empty-test-body lint (#3681): a named test whose callback
// body is empty or comment-only must be flagged; a body with any code is
// the control and must pass; the grandfather list is shrink-only.
import test from "node:test";
import assert from "node:assert/strict";

import { findEmptyTestBodies, evaluate, skeleton } from "../scripts/empty-test-bodies-check.mjs";

test("flags an empty arrow body", () => {
  const hits = findEmptyTestBodies(`test("does the thing", () => {});`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "does the thing");
});

test("flags a comment-only body (the #2893 shape)", () => {
  const src = `test("M-29: subscriber isolation", () => {
    // TODO: write this regression test
    /* promised in the header */
  });`;
  const hits = findEmptyTestBodies(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "M-29: subscriber isolation");
});

test("flags empty function-expression and async bodies, and describe blocks", () => {
  const src = [
    `it("a", function () {});`,
    `test("b", async () => {\n// nothing\n});`,
    `describe("c", () => {});`,
  ].join("\n");
  assert.deepEqual(findEmptyTestBodies(src).map(h => h.name), ["a", "b", "c"]);
});

test("control: a body with an assertion is not flagged", () => {
  const src = `test("real", () => { assert.equal(1, 1); });`;
  assert.deepEqual(findEmptyTestBodies(src), []);
});

test("control: a body with only a non-assert statement is not flagged", () => {
  const src = `test("setup only", () => { doSetup(); });`;
  assert.deepEqual(findEmptyTestBodies(src), []);
});

test("control: braces inside strings and comments do not break body matching", () => {
  const src = `test("tricky } {", () => { const s = "}"; /* { */ assert.ok(s); });`;
  assert.deepEqual(findEmptyTestBodies(src), []);
  const hollow = `test("tricky2", () => { /* } */ });`;
  assert.equal(findEmptyTestBodies(hollow).length, 1);
});

test("control: expression-bodied arrows and test.todo are not flagged", () => {
  assert.deepEqual(findEmptyTestBodies(`test("expr", () => assert.ok(1));`), []);
  assert.deepEqual(findEmptyTestBodies(`test.todo("later");`), []);
});

test("test.skip with a hollow body is still a named promise — flagged", () => {
  const hits = findEmptyTestBodies(`test.skip("skipped hollow", () => {});`);
  assert.equal(hits.length, 1);
});

test("evaluate: unlisted hollow bodies fail, listed ones pass, stale entries fail", () => {
  const files = [{ file: "tests/x.test.js", source: `test("hollow", () => {}); test("real", () => { assert.ok(1); });` }];
  const bare = evaluate(files, []);
  assert.equal(bare.unlisted.length, 1);
  assert.deepEqual(bare.stale, []);
  const listed = evaluate(files, ["tests/x.test.js::hollow"]);
  assert.deepEqual(listed.unlisted, []);
  assert.deepEqual(listed.stale, []);
  const stale = evaluate(files, ["tests/x.test.js::hollow", "tests/x.test.js::gone"]);
  assert.deepEqual(stale.stale, ["tests/x.test.js::gone"]);
});

test("skeleton blanks comments and strings but keeps code and newlines", () => {
  const src = "const a = 1; // }\nconst s = '{';\n/* \n */ const b = 2;";
  const skel = skeleton(src);
  assert.equal(skel.length, src.length);
  assert.equal(skel.split("\n").length, src.split("\n").length);
  assert.ok(skel.includes("const a = 1;"));
  assert.ok(skel.includes("const b = 2;"));
  assert.ok(!skel.includes("'{'"));
});
