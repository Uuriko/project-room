// tests/task-base.test.js
//
// Fail-first acceptance tests for FIX-31: base-SHA freshness probe.
// `node scripts/task-base.mjs record` snapshots origin/main; `check`
// re-queries ls-remote and refuses to pass when the base moved.
//
// Fixture: a LOCAL bare repo plays the role of `origin` (injected via
// TASK_BASE_REMOTE), so no network is needed.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "task-base.mjs");

// Scratch lives inside the worktree (.tmp is gitignored there), never /tmp.
const SCRATCH_BASE =
  process.env.TASK_BASE_TEST_TMP ||
  path.join(REPO_ROOT, ".tmp", "task-base-tests");
fs.mkdirSync(SCRATCH_BASE, { recursive: true });

function sh(cmd, args, { cwd, env } = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (status ${r.status}): ${r.stderr}`
    );
  }
  return r.stdout.trim();
}

/** Build a local bare "origin" with a single commit on main; return paths. */
function makeRemote() {
  const dir = fs.mkdtempSync(path.join(SCRATCH_BASE, "remote-"));
  const bare = path.join(dir, "origin.git");
  const seed = path.join(dir, "seed");
  sh("git", ["init", "--bare", "-q", bare]);
  sh("git", ["init", "-q", "-b", "main", seed]);
  sh("git", ["config", "user.email", "test@example.com"], { cwd: seed });
  sh("git", ["config", "user.name", "task-base test"], { cwd: seed });
  fs.writeFileSync(path.join(seed, "file.txt"), "v1\n");
  sh("git", ["add", "."], { cwd: seed });
  sh("git", ["commit", "-qm", "v1"], { cwd: seed });
  sh("git", ["push", "-q", bare, "main"], { cwd: seed });
  return { dir, bare, seed };
}

/** Fresh checkout-style workdir whose "origin" is the given bare repo. */
function makeWorkdir(bare) {
  const dir = fs.mkdtempSync(path.join(SCRATCH_BASE, "work-"));
  sh("git", ["init", "-q", "-b", "main", dir]);
  sh("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  sh("git", ["config", "user.name", "task-base test"], { cwd: dir });
  sh("git", ["remote", "add", "origin", bare], { cwd: dir });
  return dir;
}

function run(args, { cwd, remote }) {
  return spawnSync("node", [SCRIPT, ...args], {
    cwd,
    env: {
      ...process.env,
      TASK_BASE_REMOTE: remote,
      // Keep HOME from leaking the real user's gitconfig-less env quirks;
      // git only needs to be present and able to read the local bare repo.
    },
    encoding: "utf8",
  });
}

test("record then check passes when the base is fresh", () => {
  const { bare } = makeRemote();
  const work = makeWorkdir(bare);

  const rec = run(["record"], { cwd: work, remote: bare });
  assert.equal(rec.status, 0, `record failed: ${rec.stderr}`);

  const file = path.join(work, ".task-base");
  assert.ok(fs.existsSync(file), ".task-base should be written in the repo root");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(saved.base, /^[0-9a-f]{40}$/, "base should be a full SHA");
  assert.ok(saved.recordedAt, "recordedAt timestamp should be present");

  const chk = run(["check"], { cwd: work, remote: bare });
  assert.equal(chk.status, 0, `check failed on fresh base: ${chk.stderr}`);
  assert.match(
    chk.stdout,
    new RegExp(`base fresh: ${saved.base}`),
    "check prints 'base fresh: <sha>'"
  );
});

test("check fails with 'base moved' after the remote advances", () => {
  const { bare, seed } = makeRemote();
  const work = makeWorkdir(bare);

  const rec = run(["record"], { cwd: work, remote: bare });
  assert.equal(rec.status, 0, `record failed: ${rec.stderr}`);
  const oldSha = JSON.parse(fs.readFileSync(path.join(work, ".task-base"), "utf8")).base;

  // Advance the remote: another commit pushed to main on "origin".
  fs.writeFileSync(path.join(seed, "file.txt"), "v2\n");
  sh("git", ["add", "."], { cwd: seed });
  sh("git", ["commit", "-qm", "v2"], { cwd: seed });
  sh("git", ["push", "-q", bare, "main"], { cwd: seed });
  const newSha = sh("git", ["ls-remote", bare, "refs/heads/main"]).split("\t")[0];
  assert.notEqual(newSha, oldSha, "fixture must advance the remote SHA");

  const chk = run(["check"], { cwd: work, remote: bare });
  assert.notEqual(chk.status, 0, "check must exit non-zero when base moved");
  const out = chk.stdout + chk.stderr;
  assert.match(
    out,
    new RegExp(`base moved ${oldSha} -> ${newSha}`),
    "message names old and new SHA"
  );
  assert.match(out, /rebase before pushing/, "message tells the agent to rebase");
});

test("check fails with a helpful message when nothing was recorded", () => {
  const { bare } = makeRemote();
  const work = makeWorkdir(bare);

  const chk = run(["check"], { cwd: work, remote: bare });
  assert.notEqual(chk.status, 0, "check must fail without a .task-base file");
  const out = chk.stdout + chk.stderr;
  assert.match(out, /no .task-base/, "message explains nothing was recorded");
  assert.match(out, /record/, "message points at the record subcommand");
});
