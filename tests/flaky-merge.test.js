// TST-01B: merged shard reports become quarantine-check entries.
// A test is proposed only when combined shards contain both passes and fails.
// The owner is the file's last committer. repair_by is 14 days out.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addIsoDays } from "../scripts/flaky-merge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "..", "scripts", "flaky-merge.mjs");
const checker = path.join(here, "..", "scripts", "quarantine-check.mjs");

function git(repo, args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function fixtureRepo() {
  const repo = mkdtempSync(path.join(tmpdir(), "flaky-merge-"));
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Fo Lane"]);
  git(repo, ["config", "user.email", "fo@example.invalid"]);
  mkdirSync(path.join(repo, "tests"));
  writeFileSync(path.join(repo, "tests", "a.test.js"), "test('mixed', () => {});\n");
  git(repo, ["add", "tests/a.test.js"]);
  git(repo, ["commit", "-q", "-m", "add mixed test"]);
  return repo;
}

test("mixed shard outcomes become a quarantine entry the gate accepts", (t) => {
  const repo = fixtureRepo();
  const shards = path.join(repo, "shards");
  mkdirSync(path.join(shards, "shard-a"), { recursive: true });
  mkdirSync(path.join(shards, "shard-b"), { recursive: true });
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(path.join(shards, "shard-a", "tests__a.test.js.json"), JSON.stringify({
    file: "tests/a.test.js",
    runs: 3,
    flaky: [{ name: "mixed", passes: 2, fails: 1 }],
  }));
  writeFileSync(path.join(shards, "shard-b", "tests__a.test.js.json"), JSON.stringify({
    file: "tests/a.test.js",
    runs: 2,
    tests: [
      { name: "stable", passes: 4, fails: 0 },
      { name: "mixed", passes: 0, fails: 2 },
      { name: "only-fail", passes: 0, fails: 2 },
    ],
  }));
  writeFileSync(path.join(shards, "shard-b", "missing.json"), JSON.stringify({
    file: "tests/missing.test.js",
    flaky: [{ name: "uncommitted", passes: 1, fails: 1 }],
  }));
  writeFileSync(path.join(shards, "shard-summary.json"), JSON.stringify({
    flakyFiles: [{ file: "tests/a.test.js", tests: ["should-be-ignored"] }],
  }));
  const today = new Date().toISOString().slice(0, 10);
  const run = spawnSync(process.execPath, [script, shards, `--today=${today}`, `--repo=${repo}`], { encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  const proposal = JSON.parse(run.stdout);
  assert.deepEqual(proposal.quarantined.map((entry) => entry.test), [
    "tests/a.test.js > mixed",
    "tests/missing.test.js > uncommitted",
  ]);
  const mixed = proposal.quarantined[0];
  assert.equal(mixed.owner, "Fo Lane");
  assert.equal(mixed.reason, "mixed outcomes: 2 pass / 3 fail");
  assert.equal(mixed.quarantined_at, today);
  assert.equal(mixed.repair_by, addIsoDays(today, 14));
  assert.equal(proposal.quarantined[1].owner, undefined);
  const out = path.join(repo, "proposed.json");
  writeFileSync(out, run.stdout);
  const check = spawnSync(process.execPath, [checker, out], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /2 quarantined test/);
});

test("a directory with no mixed outcomes exits 0", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "flaky-merge-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "one.json"), JSON.stringify({
    file: "tests/a.test.js",
    flaky: [{ name: "steady", passes: 4, fails: 0 }],
  }));
  const run = spawnSync(process.execPath, [script, dir, "--today=2026-10-24"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { quarantined: [] });
});

test("unreadable shard JSON is a usage error", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "flaky-merge-bad-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "broken.json"), "{");
  const run = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /cannot parse/);
  assert.equal(run.stdout, "");
});

test("missing input is a usage error", () => {
  const run = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage:/);
});
