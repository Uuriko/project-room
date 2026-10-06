// Owner-boundary tests for scripts/review-scope-check.mjs: the mechanical
// review pass's claim-scope verdict. The contract: given the PR's changed
// files and the files the claim declared, report `clean`, `drift` (touched
// but undeclared), or `undeclared` (no declared files to check against).
// A regression here silently drops the scope-drift signal reviewers rely on.
import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePath,
  parseDeclaredFiles,
  matchScope,
} from "../scripts/review-scope-check.mjs";

test("normalizePath trims, strips ./ and leading /, keeps the rest", () => {
  assert.equal(normalizePath("  ./scripts/foo.mjs "), "scripts/foo.mjs");
  assert.equal(normalizePath("/docs/X.md"), "docs/X.md");
  assert.equal(normalizePath("tests/a.test.js"), "tests/a.test.js");
});

test("parseDeclaredFiles reads the claim-files HTML comment", () => {
  const body = [
    "Some PR description.",
    "<!-- claim-files: server/a.mjs, tests/a.test.js -->",
    "More text.",
  ].join("\n");
  assert.deepEqual(parseDeclaredFiles(body), ["server/a.mjs", "tests/a.test.js"]);
});

test("parseDeclaredFiles supports newline-separated entries and several comments", () => {
  const body = [
    "<!-- claim-files:",
    "  server/a.mjs",
    "  tests/a.test.js",
    "-->",
    "<!-- claim-files: docs/x.md -->",
  ].join("\n");
  assert.deepEqual(parseDeclaredFiles(body), [
    "server/a.mjs",
    "tests/a.test.js",
    "docs/x.md",
  ]);
});

test("parseDeclaredFiles returns [] when the PR body declares nothing", () => {
  assert.deepEqual(parseDeclaredFiles("no comment here"), []);
  assert.deepEqual(parseDeclaredFiles(""), []);
  assert.deepEqual(parseDeclaredFiles(null), []);
});

test("parseDeclaredFiles dedupes and normalizes entries", () => {
  const body = "<!-- claim-files: ./server/a.mjs, server/a.mjs, /server/a.mjs -->";
  assert.deepEqual(parseDeclaredFiles(body), ["server/a.mjs"]);
});

test("matchScope is clean when every changed file was declared", () => {
  const r = matchScope(
    ["server/a.mjs", "tests/a.test.js"],
    ["server/a.mjs", "tests/a.test.js"],
  );
  assert.equal(r.verdict, "clean");
  assert.deepEqual(r.drift, []);
  assert.deepEqual(r.inScope.sort(), ["server/a.mjs", "tests/a.test.js"]);
});

test("matchScope flags touched-but-undeclared files as drift", () => {
  const r = matchScope(
    ["server/a.mjs", "server/surprise.mjs"],
    ["server/a.mjs"],
  );
  assert.equal(r.verdict, "drift");
  assert.deepEqual(r.drift, ["server/surprise.mjs"]);
  assert.deepEqual(r.inScope, ["server/a.mjs"]);
});

test("matchScope is undeclared when the claim declared no files", () => {
  const r = matchScope(["server/a.mjs"], []);
  assert.equal(r.verdict, "undeclared");
  assert.deepEqual(r.drift, []);
});

test("matchScope: a declared trailing-slash entry covers its directory only", () => {
  const r = matchScope(
    ["scripts/a.mjs", "scripts2/b.mjs"],
    ["scripts/"],
  );
  assert.equal(r.verdict, "drift");
  assert.deepEqual(r.inScope, ["scripts/a.mjs"]);
  assert.deepEqual(r.drift, ["scripts2/b.mjs"]);
});

test("matchScope: a bare directory name without trailing slash is exact-only", () => {
  // Guards the classic prefix bug: "scripts" must not cover "scripts2/x.mjs".
  const r = matchScope(["scripts2/x.mjs"], ["scripts"]);
  assert.equal(r.verdict, "drift");
  assert.deepEqual(r.drift, ["scripts2/x.mjs"]);
});

test("matchScope normalizes both sides before comparing", () => {
  const r = matchScope(["./server/a.mjs"], ["/server/a.mjs"]);
  assert.equal(r.verdict, "clean");
});

test("matchScope ignores undeclared-listed files that were never touched", () => {
  // Declaring extra files is not drift; touching undeclared ones is.
  const r = matchScope(["server/a.mjs"], ["server/a.mjs", "server/b.mjs"]);
  assert.equal(r.verdict, "clean");
  assert.deepEqual(r.drift, []);
});
