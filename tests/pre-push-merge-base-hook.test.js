// FIX-32 acceptance: pre-push hook enforces
// `git merge-base --is-ancestor origin/main HEAD` after a bounded fetch.
// Fail-first: the hook script does not exist yet, so every case below fails
// until scripts/pre-push-merge-base.sh is implemented.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, "..", "scripts", "pre-push-merge-base.sh");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: cwd, // keep fixture gitconfig writes out of the real home dir
    },
  });
}

const ident = ["-c", "user.name=fix32-test", "-c", "user.email=fix32@test.local"];

// Builds: bare remote + one working clone. Returns { remote, work }.
// The remote's main branch ends at `tipCommits` commits.
function buildFixture(tipCommits = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fix32-"));
  const remote = path.join(root, "remote.git");
  fs.mkdirSync(remote, { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "--bare", "-q", "remote.git");
  const work = path.join(root, "work");
  git(root, "clone", "-q", remote, "work");
  for (let i = 0; i < tipCommits; i++) {
    fs.writeFileSync(path.join(work, `f${i}.txt`), `v${i}\n`);
    git(work, ...ident, "add", ".");
    git(work, ...ident, "commit", "-q", "-m", `tip ${i}`);
    git(work, "push", "-q", "origin", "HEAD:main");
  }
  git(work, "fetch", "-q", "origin");
  git(work, "checkout", "-q", "-B", "main", "origin/main");
  return { root, remote, work };
}

function runHook(cwd) {
  const r = spawnSync("sh", [HOOK], {
    cwd,
    encoding: "utf8",
    input: "", // pre-push stdin: hook must not depend on it
    timeout: 60000,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("branch rebased on remote tip: hook passes", () => {
  const { work } = buildFixture();
  git(work, "checkout", "-q", "-b", "feature", "origin/main");
  fs.writeFileSync(path.join(work, "mine.txt"), "mine\n");
  git(work, ...ident, "add", ".");
  git(work, ...ident, "commit", "-q", "-m", "my work");
  const r = runHook(work);
  assert.equal(r.code, 0, `hook should pass on rebased branch; stderr=${r.stderr}`);
});

test("branch behind remote tip: hook refuses with rebase message", () => {
  const { remote, work } = buildFixture(1);
  // Branch from the old tip, then move the remote forward.
  git(work, "checkout", "-q", "-b", "stale-branch", "origin/main");
  const advancer = path.join(path.dirname(work), "advancer");
  git(path.dirname(work), "clone", "-q", remote, "advancer");
  fs.writeFileSync(path.join(advancer, "new.txt"), "new\n");
  git(advancer, ...ident, "add", ".");
  git(advancer, ...ident, "commit", "-q", "-m", "remote moved on");
  git(advancer, "push", "-q", "origin", "HEAD:main");
  // stale-branch still points at the old tip; the hook fetches and must refuse.
  const r = runHook(work);
  assert.notEqual(r.code, 0, "hook should refuse a branch behind origin/main");
  const out = (r.stdout + r.stderr).toLowerCase();
  assert.match(out, /rebase/, "refusal must tell the user to rebase onto origin/main");
});

test("offline fetch failure: loud warning, push allowed (fail-open)", () => {
  const { work } = buildFixture(1);
  git(work, "checkout", "-q", "-b", "stale-branch", "origin/main");
  // Point origin at an unreachable location; even a behind branch must pass.
  git(work, "remote", "set-url", "origin", "file:///nonexistent/fix32-offline.git");
  const r = runHook(work);
  assert.equal(r.code, 0, `hook must fail open when the network is unreachable; stderr=${r.stderr}`);
  const out = (r.stdout + r.stderr).toLowerCase();
  assert.match(out, /warning/, "fail-open must carry a loud warning, not silence");
  assert.match(out, /fetch|offline|unreachable|network/, "warning must say the fetch failed");
});
