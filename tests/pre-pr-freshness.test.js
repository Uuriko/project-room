// Pre-PR freshness check (WAVE-300 FIX-30).
//
// Authoring gate:
// 1. A branch whose tip does NOT contain the freshly-fetched origin/main tip
//    must fail with a non-zero exit and an actionable "rebase needed" message
//    naming the new origin/main SHA.
// 2. The same branch after `git rebase origin/main` must pass with exit 0 and
//    a "fresh: HEAD is <n> commits ahead of origin/main <sha>" line.
// 3. `--no-fetch` must consult only the local remote-tracking ref (no network).
// 4. Running outside a git repository must fail without hanging.
// No production seam: everything here runs `node scripts/pre-pr-freshness.mjs`
// as a subprocess against throwaway fixture git repos. Fixture repos live
// under the worktree-local `.tmp/` directory, never /tmp.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO_ROOT, "scripts", "pre-pr-freshness.mjs");

// Worktree-local scratch: /tmp is a near-full tmpfs shared with other lanes
// and gets reaped, so fixtures stay inside the worktree.
function scratchDir(prefix) {
  const base = join(REPO_ROOT, ".tmp");
  if (!existsSync(base)) mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, prefix));
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

// Fixture: a bare "remote" plus two clones. Clone A owns the feature branch;
// clone B simulates another lane pushing to origin/main while A works.
function buildFixture() {
  const dir = scratchDir("pre-pr-freshness-");
  const remote = join(dir, "remote.git");
  const cloneA = join(dir, "a");
  const cloneB = join(dir, "b");
  git(dir, "init", "--bare", "--initial-branch=main", "remote.git");
  git(dir, "clone", remote, "a");
  git(dir, "clone", remote, "b");
  for (const c of [cloneA, cloneB]) {
    git(c, "config", "user.email", "test@example.com");
    git(c, "config", "user.name", "test");
    git(c, "config", "commit.gpgsign", "false");
  }
  // Seed main with one commit via clone B.
  git(cloneB, "commit", "--allow-empty", "-m", "seed");
  git(cloneB, "push", "origin", "main");
  git(cloneA, "fetch", "origin");
  // Feature branch off the (then current) origin/main.
  git(cloneA, "checkout", "-b", "feature");
  git(cloneA, "commit", "--allow-empty", "-m", "feature work");
  // origin/main moves while A works.
  git(cloneB, "commit", "--allow-empty", "-m", "someone else landed");
  git(cloneB, "push", "origin", "main");
  return { dir, remote, cloneA, cloneB };
}

function runCheck(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}

test("stale branch fails with actionable rebase message", (t) => {
  const { dir, cloneA } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = runCheck(cloneA);
  assert.notEqual(r.status, 0, "stale branch must exit non-zero");
  const out = r.stdout + r.stderr;
  assert.match(out, /rebase needed/i);
  assert.match(out, /origin\/main moved to [0-9a-f]{40}/);
  assert.match(out, /git fetch/i);
  assert.match(out, /git rebase/i);
});

test("rebased branch passes and reports ahead count", (t) => {
  const { dir, cloneA } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(cloneA, "fetch", "origin");
  git(cloneA, "rebase", "origin/main");
  const r = runCheck(cloneA);
  assert.equal(r.status, 0, `fresh branch must exit 0: ${r.stdout}${r.stderr}`);
  const mainSha = git(cloneA, "rev-parse", "origin/main");
  assert.match(r.stdout, new RegExp(`fresh: HEAD is 1 commits ahead of origin/main ${mainSha}`));
});

test("--no-fetch uses the local remote-tracking ref without network", (t) => {
  const { dir, cloneA } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(cloneA, "fetch", "origin");
  // Break network access: point origin at a bogus URL. --no-fetch must not
  // need the network at all.
  git(cloneA, "remote", "set-url", "origin", "file:///nonexistent-remote.git");
  const r = runCheck(cloneA, "--no-fetch");
  assert.notEqual(r.status, 0, "stale branch must exit non-zero with --no-fetch");
  assert.match(r.stdout + r.stderr, /rebase needed/i);
  // A plain run must now fail on the broken fetch, not silently pass.
  const r2 = runCheck(cloneA);
  assert.notEqual(r2.status, 0, "broken fetch must fail the check");
  assert.match(r2.stdout + r2.stderr, /fetch/i);
});

test("branch already on tip passes with zero ahead", (t) => {
  const { dir, cloneA } = buildFixture();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(cloneA, "fetch", "origin");
  git(cloneA, "reset", "--hard", "origin/main");
  const r = runCheck(cloneA);
  assert.equal(r.status, 0, `on-tip branch must exit 0: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /fresh: HEAD is 0 commits ahead of origin\/main [0-9a-f]{40}/);
});

test("outside a git repository fails cleanly", (t) => {
  // Genuinely outside the repo checkout: the fixture scratch lives under the
  // repo worktree, so git would find the repo by walking upward from there.
  const outside = mkdtempSync(join(REPO_ROOT, "..", "pre-pr-freshness-nogit-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const r = runCheck(outside);
  assert.notEqual(r.status, 0, "non-repo must exit non-zero");
  assert.match(r.stdout + r.stderr, /not a git repository/i);
});
