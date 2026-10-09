// Owner-boundary tests for scripts/review-scope-check.mjs: the mechanical
// review pass's claim-scope verdict. The contract: given the PR's changed
// files and the files the claim declared, report `clean`, `drift` (touched
// but undeclared), or `undeclared` (no declared files to check against).
// A regression here silently drops the scope-drift signal reviewers rely on.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// CLI input hardening: unreadable inputs fail with a one-line usage error
// (exit 1, the documented usage-error code), never an uncaught stack trace.

const script = fileURLToPath(new URL("../scripts/review-scope-check.mjs", import.meta.url));
function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args], { timeout: 10000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") return reject(error);
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test("CLI: missing --files-file fails with a clean usage error, not a stack trace", async () => {
  const { code, stderr } = await runCli(["--files-file", "/nonexistent-worker48-files"]);
  assert.equal(code, 1);
  assert.match(stderr, /review-scope-check: --files-file \/nonexistent-worker48-files/);
  assert.doesNotMatch(stderr, /^\s+at /m);
});

test("CLI: --files-file naming a directory fails with a clean usage error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-check-dir-"));
  const { code, stderr } = await runCli(["--files-file", dir]);
  assert.equal(code, 1);
  assert.match(stderr, /review-scope-check: --files-file /);
  assert.doesNotMatch(stderr, /^\s+at /m);
});

test("CLI: missing --body-file fails with a clean usage error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-check-body-"));
  const files = join(dir, "files.txt");
  writeFileSync(files, "server/a.mjs\n");
  const { code, stderr } = await runCli(["--files-file", files, "--body-file", join(dir, "nope.md")]);
  assert.equal(code, 1);
  assert.match(stderr, /review-scope-check: --body-file /);
  assert.doesNotMatch(stderr, /^\s+at /m);
});

test("CLI: a failing git diff fails with a clean usage error", async () => {
  const { code, stderr } = await runCli(["--base", "deadbeef", "--head", "deadbeef"]);
  assert.equal(code, 1);
  assert.match(stderr, /review-scope-check: git diff deadbeef\.\.\.deadbeef failed/);
  assert.doesNotMatch(stderr, /^\s+at /m);
});
