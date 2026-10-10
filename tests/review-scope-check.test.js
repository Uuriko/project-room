// Owner-boundary tests for scripts/review-scope-check.mjs: the mechanical
// review pass's claim-scope verdict. The contract: given the PR's changed
// files and the files the claim declared, report `clean`, `drift` (touched
// but undeclared), or `undeclared` (no declared files to check against).
// A regression here silently drops the scope-drift signal reviewers rely on.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  covers,
  normalizePath,
  parseDeclaredFiles,
  matchScope,
  pathsFromNameOnly,
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

test("a git-quoted name-only path still names the declared file", () => {
  const quoted = '"server/caf\\303\\251.mjs"\n';
  const files = pathsFromNameOnly(quoted);
  assert.deepEqual(files, ["server/café.mjs"]);
  const scope = matchScope(files, ["server/café.mjs"]);
  assert.equal(scope.verdict, "clean");
  assert.deepEqual(scope.drift, []);
  assert.deepEqual(pathsFromNameOnly("server/a.mjs\n"), ["server/a.mjs"]);
  assert.deepEqual(pathsFromNameOnly('"server/my file.mjs"\n'), ["server/my file.mjs"]);
  const dir = mkdtempSync(join(tmpdir(), "review-scope-quote-"));
  try {
    const git = args => execFileSync("git", ["-C", dir, "-c", "core.quotePath=true", "-c", "user.email=scope@example.com", "-c", "user.name=Scope", ...args], { encoding: "utf8" });
    git(["init", "-q", "-b", "main"]);
    mkdirSync(join(dir, "server"));
    writeFileSync(join(dir, "server", "café.mjs"), "a\n");
    git(["add", "server/café.mjs"]);
    git(["commit", "-q", "-m", "base"]);
    writeFileSync(join(dir, "server", "café.mjs"), "b\n");
    git(["add", "server/café.mjs"]);
    const listed = pathsFromNameOnly(git(["diff", "--cached", "--name-only"]));
    assert.deepEqual(listed, ["server/café.mjs"]);
    assert.equal(matchScope(listed, ["server/café.mjs"]).verdict, "clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an NFC declared path covers the NFD spelling of the same file", () => {
  const nfc = "server/caf\u00e9.mjs";
  const nfd = "server/cafe\u0301.mjs";
  assert.notEqual(nfc, nfd);
  assert.equal(covers(normalizePath(nfc), normalizePath(nfd)), true);
  const scope = matchScope([nfd], [nfc]);
  assert.equal(scope.verdict, "clean");
  assert.deepEqual(scope.drift, []);
  assert.equal(covers(normalizePath("server/caf\u00e9/"), normalizePath("server/cafe\u0301/app.mjs")), true);
  assert.equal(matchScope(["server/Caf\u00e9.mjs"], [nfc]).verdict, "drift");
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
