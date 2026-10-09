// tests/rebase-guard.test.js — fail-first acceptance tests for scripts/rebase-guard.mjs
// (FIX-51: never leave a paused rebase in a shared tree; never push literal
// conflict markers).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const script = join(root, "scripts", "rebase-guard.mjs");

const git = (dir, args) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// Minimal fixture repo: git init + one commit, so .git/ state dirs behave.
const withRepo = (fn) => {
  const dir = mkdtempSync(join(process.env.TMPDIR || "/tmp", "rebase-guard-"));
  try {
    git(dir, ["init", "-q"]);
    git(dir, ["config", "user.email", "test@example.com"]);
    git(dir, ["config", "user.name", "test"]);
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-qm", "init"]);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const runGuard = (dir, args = []) =>
  spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });

const gitDir = (dir) => git(dir, ["rev-parse", "--absolute-git-dir"]).stdout.trim();

const fakePause = (dir, kind) => {
  // Deterministic: plant the state git itself leaves behind, instead of
  // staging a real conflicted rebase (which varies by git version).
  // Resolve the true git dir: linked worktrees carry a .git *file*.
  const g = gitDir(dir);
  if (kind === "rebase-merge" || kind === "rebase-apply") {
    mkdirSync(join(g, kind), { recursive: true });
  } else {
    writeFileSync(join(g, kind), "deadbeef\n");
  }
};

for (const kind of ["rebase-merge", "rebase-apply", "REBASE_HEAD", "MERGE_HEAD"]) {
  test(`F-51: guard fails on paused ${kind}`, () =>
    withRepo((dir) => {
      fakePause(dir, kind);
      const r = runGuard(dir);
      assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(out.includes(kind), `output should name the paused state ${kind}: ${out}`);
      assert.ok(
        out.includes("git rebase --abort") || out.includes("git merge --abort"),
        `output should tell the operator how to recover: ${out}`
      );
    }));
}

test("F-51: guard passes on a clean tree", () =>
  withRepo((dir) => {
    const r = runGuard(dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  }));

test("F-51: guard fails when a staged file contains <<<<<<< markers", () =>
  withRepo((dir) => {
    writeFileSync(join(dir, "b.txt"), "ok\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> other\n");
    git(dir, ["add", "b.txt"]);
    const r = runGuard(dir);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes("b.txt"), `output should name the staged file: ${out}`);
    assert.ok(out.includes("<<<<<<<"), `output should mention conflict markers: ${out}`);
  }));

test("F-51: unstaged-only markers do not fail the guard", () =>
  withRepo((dir) => {
    writeFileSync(join(dir, "c.txt"), "ok\n<<<<<<< HEAD\n");
    // intentionally not staged — the push-time hazard is staged content
    const r = runGuard(dir);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
  }));

test("F-51: --sweep reports paused rebases across linked worktrees", () =>
  withRepo((dir) => {
    const wt1 = join(dir, "wt-clean");
    const wt2 = join(dir, "wt-paused");
    git(dir, ["worktree", "add", "-q", wt1]);
    git(dir, ["worktree", "add", "-q", wt2]);
    fakePause(wt2, "rebase-merge");
    const r = runGuard(dir, ["--sweep"]);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stdout}${r.stderr}`);
    const out = `${r.stdout}${r.stderr}`;
    assert.ok(out.includes("wt-paused"), `sweep should name the paused worktree: ${out}`);
    assert.ok(out.includes("wt-clean"), `sweep should list the clean worktree too: ${out}`);
  }));
