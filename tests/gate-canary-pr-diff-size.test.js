// Gate canary for scripts/pr-diff-size-check.mjs (#3681 tranche T5).
//
// Runs the real gate CLI as a subprocess inside a fixture git repository
// under a spaced path, over real base...head diffs:
//   - an over-threshold diff (in a file whose own path contains a space)
//     with a plain PR body must exit non-zero and name the counted size;
//   - the same diff with a substantive justification passes;
//   - an under-threshold diff passes with no justification (control).
// Fixtures stay under the post-#4771 excluded-volume cap by construction
// (no excluded paths), so the verdicts are identical before and after
// #4771's new bounds land.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GATE = fileURLToPath(new URL("../scripts/pr-diff-size-check.mjs", import.meta.url));

function git(cwd, args) {
  const run = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.email=canary@example.invalid", "-c", "user.name=gate-canary", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function writeLines(cwd, rel, count) {
  const path = join(cwd, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Array.from({ length: count }, (_, i) => `canary line ${i + 1}`).join("\n") + "\n");
}

function fixtureRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "gate canary diff size-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "canary fixture\n");
  const base = commit(dir, "base");
  return { dir, base };
}

function runGate(cwd, base, head, extraArgs = []) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.DIFF_SIZE_THRESHOLD;
  return spawnSync(process.execPath, [GATE, "--base", base, "--head", head, ...extraArgs], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
}

test("canary: over-threshold diff in a spaced path fails naming the counted size", (t) => {
  const { dir, base } = fixtureRepo(t);
  writeLines(dir, "src/spaced name.txt", 350);
  const head = commit(dir, "large change");
  const run = runGate(dir, base, head, ["--body", "a plain body"]);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /350 changed lines exceed the 300-line threshold/);
});

test("canary: over-threshold diff with a substantive justification passes", (t) => {
  const { dir, base } = fixtureRepo(t);
  writeLines(dir, "src/spaced name.txt", 350);
  const head = commit(dir, "large change");
  const bodyFile = join(dir, "pr body.md");
  writeFileSync(bodyFile, [
    "## Large diff justification:",
    "This fixture deliberately adds one large file in a single commit so the",
    "canary exercises the over-threshold path end to end; splitting a fixture",
    "would not reduce any real review surface.",
    "",
  ].join("\n"));
  const run = runGate(dir, base, head, ["--body-file", bodyFile]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /justification section/);
});

test("canary: under-threshold diff passes with no justification", (t) => {
  const { dir, base } = fixtureRepo(t);
  writeLines(dir, "src/small.txt", 10);
  const head = commit(dir, "small change");
  const run = runGate(dir, base, head, ["--body", "a plain body"]);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ok: 10 changed lines/);
});
