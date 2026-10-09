// Pre-PR freshness check (WAVE-300 FIX-30).
//
// Asserts the current branch has been rebased onto a fresh origin/main tip
// before a PR is opened or a branch is pushed. Usage:
//
//   node scripts/pre-pr-freshness.mjs [--no-fetch] [--remote <name>]
//
// Default behavior fetches <remote>/main first so the check runs against the
// live tip, not a stale remote-tracking ref. `--no-fetch` skips the fetch and
// trusts the local remote-tracking ref (offline or already-fetched flows).
//
// Exit 0:  "fresh: HEAD is <n> commits ahead of origin/main <sha>"
// Exit 1:  branch is stale — "rebase needed: origin/main moved to <sha>; run
//           git fetch && git rebase origin/main"
// Exit 2:  usage or environment error (not a git repo, no remote-tracking ref,
//           fetch failed).
//
// Read-only except for the fetch step, which only updates remote-tracking
// refs. Additive: it never rewrites history, opens PRs, or pushes anything.
// The base-SHA record (FIX-31) and the pre-push hook (FIX-32) are separate
// tools; this script only answers "is HEAD rebased onto fresh main?".
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const MAIN_BRANCH = "main";

function runGit(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (!allowFail && r.status !== 0) {
    return { ok: false, stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
  }
  return { ok: r.status === 0, stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
}

function fail(exitCode, message) {
  process.stdout.write(message + "\n");
  process.exit(exitCode);
}

function main() {
  const { values } = parseArgs({
    options: {
      "no-fetch": { type: "boolean", default: false },
      remote: { type: "string", default: "origin" },
    },
    strict: true,
  });
  const remote = values.remote;
  const mainRef = `${remote}/${MAIN_BRANCH}`;

  const root = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
  if (!root.ok) {
    fail(2, `error: not a git repository (or no git available): ${root.stderr || "git rev-parse failed"}`);
  }
  const cwd = root.stdout;

  const refCheck = runGit(cwd, ["rev-parse", "--verify", `refs/remotes/${mainRef}`]);
  if (!refCheck.ok) {
    fail(2, `error: no remote-tracking ref for ${mainRef}. Run \`git fetch ${remote}\` once, then retry.`);
  }

  if (!values["no-fetch"]) {
    const fetched = runGit(cwd, ["fetch", remote, MAIN_BRANCH], { allowFail: true });
    if (!fetched.ok) {
      fail(2, `error: git fetch ${remote} ${MAIN_BRANCH} failed: ${fetched.stderr || "unknown error"}\n` +
        `Check network access, then re-run. To check against the last fetched ref instead, pass --no-fetch.`);
    }
  }

  const mainSha = runGit(cwd, ["rev-parse", mainRef]);
  if (!mainSha.ok) {
    fail(2, `error: cannot resolve ${mainRef}: ${mainSha.stderr}`);
  }
  const sha = mainSha.stdout;

  const isAncestor = runGit(cwd, ["merge-base", "--is-ancestor", mainRef, "HEAD"], { allowFail: true });
  if (isAncestor.ok) {
    const count = runGit(cwd, ["rev-list", "--count", `${mainRef}..HEAD`]);
    const ahead = count.ok ? count.stdout : "?";
    process.stdout.write(`fresh: HEAD is ${ahead} commits ahead of ${mainRef} ${sha}\n`);
    process.exit(0);
  }

  fail(1, `rebase needed: ${mainRef} moved to ${sha}; run git fetch && git rebase ${mainRef}`);
}

main();
