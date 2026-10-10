// TST-14: the patch-series checker reports clean, applied, partly-applied,
// conflict and malformed series against a base, without touching the caller's tree.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkAll, splitSeries, formatLine, SCHEMA } from "../scripts/check-patch-series.mjs";

const SCRIPT = resolve("scripts/check-patch-series.mjs");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@invalid" };
const g = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "patch-check-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  g(dir, "init", "-q", "-b", "main", repo);
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(repo, "b.txt"), "alpha\n");
  g(repo, "add", "."); g(repo, "commit", "-q", "-m", "base");
  const patch = (name, fn, msg) => {
    g(repo, "checkout", "-q", "-b", name, "main");
    fn(); g(repo, "commit", "-q", "-am", msg);
    const out = join(dir, `${name}.patch`);
    writeFileSync(out, g(repo, "format-patch", "-1", "--stdout"));
    return out;
  };
  const clean = patch("clean", () => writeFileSync(join(repo, "b.txt"), "alpha\nbeta\n"), "add beta");
  const conflictSide = patch("conflict", () => writeFileSync(join(repo, "a.txt"), "one\nTWO-patch\nthree\n"), "change two");
  const merged = patch("merged", () => writeFileSync(join(repo, "a.txt"), "zero\none\ntwo\nthree\n"), "add zero");
  // Two-patch mbox: first is the merged change, second adds gamma on top.
  g(repo, "checkout", "-q", "merged");
  writeFileSync(join(repo, "b.txt"), "alpha\ngamma\n"); g(repo, "commit", "-q", "-am", "add gamma");
  const series = join(dir, "series.mbox");
  writeFileSync(series, g(repo, "format-patch", "-2", "--stdout"));
  // main moves: lands the "merged" change by cherry-pick and edits line two.
  g(repo, "checkout", "-q", "main");
  g(repo, "cherry-pick", "merged~1");
  writeFileSync(join(repo, "a.txt"), "zero\none\nTWO-main\nthree\n"); g(repo, "commit", "-q", "-am", "main edits two");
  const junk = join(dir, "notes.txt");
  writeFileSync(junk, "not a patch\n");
  return { repo, clean, conflictSide, merged, series, junk };
}

test("splitSeries reads subjects and files from an mbox", t => {
  const { series } = fixture(t);
  const parts = splitSeries(readFileSync(series, "utf8"));
  assert.deepEqual(parts.map(p => p.subject), ["add zero", "add gamma"]);
  assert.deepEqual(parts.map(p => p.files), [["a.txt"], ["b.txt"]]);
});

test("each series gets the right state against main", t => {
  const f = fixture(t);
  const report = checkAll(f.repo, [f.clean, f.conflictSide, f.merged, f.series, f.junk], { base: "main" });
  assert.equal(report.schema, SCHEMA);
  const states = Object.fromEntries(report.series.map(s => [s.file, s.state]));
  assert.deepEqual(states, { "clean.patch": "clean", "conflict.patch": "conflict", "merged.patch": "applied", "series.mbox": "partly-applied", "notes.txt": "malformed" });
  const conflict = report.series.find(s => s.state === "conflict");
  assert.equal(conflict.failedAt, 1);
  assert.equal(conflict.subject, "change two");
  assert.deepEqual(conflict.files, ["a.txt"]);
  assert.match(formatLine(conflict), /^conflict conflict\.patch patch 1\/1 "change two" files=a\.txt/);
  assert.equal(report.series.find(s => s.file === "series.mbox").applied, 1);
  assert.match(report.series.find(s => s.state === "clean").tree, /^[0-9a-f]{8}$/);
});

test("the check leaves the caller's branch, tree and worktree list unchanged", t => {
  const f = fixture(t);
  const before = [g(f.repo, "rev-parse", "HEAD"), g(f.repo, "status", "--porcelain"), g(f.repo, "worktree", "list")];
  checkAll(f.repo, [f.clean, f.conflictSide], { base: "main" });
  assert.deepEqual([g(f.repo, "rev-parse", "HEAD"), g(f.repo, "status", "--porcelain"), g(f.repo, "worktree", "list")], before);
});

test("CLI exit codes: 0 when nothing conflicts, 1 on conflict or malformed, 2 on bad usage", t => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: f.repo, env, encoding: "utf8" });
  const ok = run("--base", "main", f.clean, f.merged);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 series, 1 clean, 1 applied, 0 partly-applied, 0 conflict, 0 malformed/);
  const bad = run("--base", "main", "--json", f.conflictSide);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).conflict, 1);
  assert.equal(run("--base", "main").status, 2);
  assert.equal(run("--base", "main", join(f.repo, "missing.patch")).status, 2);
  assert.equal(run("--base", "no-such-ref", f.clean).status, 2);
});
