// scripts/rebase-guard.mjs — FIX-51: never leave a paused rebase (or merge) in a
// shared tree, and never push literal conflict markers.
//
// Usage:
//   node scripts/rebase-guard.mjs           # fail (exit 1) if THIS tree is unsafe
//   node scripts/rebase-guard.mjs --sweep   # report paused state across all
//                                           # linked worktrees of this repo
//
// A paused rebase absorbs follow-up commands: the sequencer keeps eating
// input while the operator thinks they are on clean ground, and at least once
// that ended with literal `<<<<<<<` conflict markers pushed to the remote.
// The rule: finish (`git rebase --continue` / `--skip`) or `git rebase
// --abort` in the SAME session — never push from a tree in a paused state.
//
// Checks, in order:
//   1. rebase-merge/ or rebase-apply/ dir under the git dir → paused rebase
//   2. REBASE_HEAD file                        → rebase paused mid-conflict
//   3. MERGE_HEAD file                         → merge in progress (same hazard)
//   4. staged files containing `<<<<<<<`       → the observed failure mode
// Additive only: it never changes tree state, only reports.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const git = (args, cwd) => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
};

const gitDir = (cwd) => git(["rev-parse", "--absolute-git-dir"], cwd);

const PAUSED_STATES = [
  ["rebase-merge", "dir", "paused interactive rebase", "git rebase --continue | git rebase --skip | git rebase --abort"],
  ["rebase-apply", "dir", "paused rebase (am backend)", "git rebase --continue | git rebase --skip | git rebase --abort"],
  ["REBASE_HEAD", "file", "rebase paused mid-conflict", "git rebase --continue | git rebase --skip | git rebase --abort"],
  ["MERGE_HEAD", "file", "merge in progress", "git commit/merge --continue | git merge --abort"],
];

const checkTree = (cwd) => {
  const problems = [];
  const g = gitDir(cwd);
  if (!g) {
    problems.push({ what: "not a git tree", fix: "run inside a git working tree" });
    return { cwd, gitDir: null, problems };
  }
  for (const [name, kind, label, fix] of PAUSED_STATES) {
    const p = join(g, name);
    let present = false;
    try {
      present = kind === "dir" ? existsSync(p) && statSync(p).isDirectory()
                                : existsSync(p) && statSync(p).isFile();
    } catch { present = false; }
    if (present) problems.push({ what: `${name}: ${label}`, fix });
  }
  // Staged files with literal conflict markers — the observed push failure.
  const staged = git(["diff", "--cached", "--name-only", "-z"], cwd);
  if (staged) {
    for (const file of staged.split("\0").filter(Boolean)) {
      let content;
      try {
        content = git(["show", `:${file}`], cwd); // staged blob, not worktree copy
      } catch { continue; }
      if (content == null || !content.includes("<<<<<<<")) continue;
      const n = content.split("\n").findIndex((l) => l.startsWith("<<<<<<<")) + 1;
      problems.push({
        what: `staged file "${file}" contains <<<<<<< conflict markers (line ~${n})`,
        fix: "resolve the conflict in the same session, then re-stage; never commit or push marker text",
      });
    }
  }
  return { cwd, gitDir: g, problems };
};

const formatProblems = ({ cwd, problems }) => {
  const lines = [`\u274C rebase-guard: ${cwd} is NOT safe to push from:`];
  for (const p of problems) lines.push(`  - ${p.what}\n    → ${p.fix}`);
  lines.push("Finish or abort the paused operation in THIS session; never push from a tree in this state.");
  return lines.join("\n");
};

const main = () => {
  const args = process.argv.slice(2);
  if (args.includes("--sweep")) {
    const here = process.cwd();
    const g = gitDir(here);
    if (!g) { console.error("rebase-guard: not inside a git tree"); process.exit(1); }
    const list = git(["worktree", "list", "--porcelain"], here) || "";
    const paths = [];
    for (const line of list.split("\n")) {
      const m = line.match(/^worktree\s+(.+)$/);
      if (m) paths.push(m[1]);
    }
    if (!paths.length) paths.push(here);
    let bad = 0;
    for (const p of paths) {
      const res = checkTree(p);
      if (res.problems.length) {
        bad++;
        console.log(formatProblems(res));
        console.log();
      } else {
        console.log(`\u2705 ${p}: clean`);
      }
    }
    console.log(`\nrebase-guard --sweep: ${paths.length} worktree(s), ${bad} with paused state.`);
    process.exit(bad ? 1 : 0);
  }
  const res = checkTree(process.cwd());
  if (!res.problems.length) {
    console.log("\u2705 rebase-guard: tree is clean (no paused rebase/merge, no staged conflict markers).");
    process.exit(0);
  }
  console.error(formatProblems(res));
  process.exit(1);
};

main();
