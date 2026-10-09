#!/usr/bin/env node
// clean-main-baseline.mjs: run the same tests on clean main and on a branch,
// then diff the failing tests. A failure that exists on both is "persistent"
// (not caused by the branch). A failure only on the branch is "introduced".
// A failure only on main is "fixed". Exit code 1 means the branch introduced
// at least one failure. Read-only: it uses detached worktrees in the temp dir
// and removes them after the run.
//
// Usage:
//   node scripts/clean-main-baseline.mjs [--base origin/main] [--head HEAD]
//     [--concurrency 4] [--json out.json] [--keep] [test files ...]
// With no test files, it runs tests/*.test.js.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Parse node:test TAP output. Return the sorted list of failing leaf tests as
// "parent > child" paths. A failing parent whose failure comes only from a
// failing child is dropped, so each failure is counted once.
export function parseTapFailures(text) {
  const stack = [];
  const failing = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^( *)# Subtest: (.*)$/.exec(raw);
    if (m) {
      const depth = m[1].length / 4;
      stack.length = depth;
      stack[depth] = m[2].trim();
      continue;
    }
    const r = /^( *)(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO).*)?$/.exec(raw);
    if (!r) continue;
    const depth = r[1].length / 4;
    stack.length = depth + 1;
    stack[depth] = r[3].trim();
    if (r[2] === "not ok" && !r[4]) failing.push(stack.slice(0, depth + 1).join(" > "));
  }
  const leaves = failing.filter((p) => !failing.some((q) => q !== p && q.startsWith(`${p} > `)));
  return [...new Set(leaves)].sort();
}

export function diffFailures(baseFailures, headFailures) {
  const base = new Set(baseFailures);
  const head = new Set(headFailures);
  return {
    introduced: [...head].filter((t) => !base.has(t)).sort(),
    fixed: [...base].filter((t) => !head.has(t)).sort(),
    persistent: [...head].filter((t) => base.has(t)).sort(),
  };
}

export function parseArgs(argv) {
  const opts = { base: "origin/main", head: "HEAD", concurrency: 4, json: null, keep: false, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i];
    else if (a === "--head") opts.head = argv[++i];
    else if (a === "--concurrency") opts.concurrency = Number(argv[++i]) || 4;
    else if (a === "--json") opts.json = argv[++i];
    else if (a === "--keep") opts.keep = true;
    else opts.files.push(a);
  }
  return opts;
}

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function runSide(repo, ref, label, opts, root) {
  const dir = join(root, label);
  git(repo, ["worktree", "add", "--detach", "-q", dir, ref]);
  const nm = join(repo, "node_modules");
  if (existsSync(nm) && !existsSync(join(dir, "node_modules"))) symlinkSync(nm, join(dir, "node_modules"));
  const files = opts.files.length
    ? opts.files
    : readdirSync(join(dir, "tests")).filter((f) => f.endsWith(".test.js")).sort().map((f) => `tests/${f}`);
  const present = files.filter((f) => existsSync(join(dir, f)));
  const r = spawnSync(process.execPath,
    ["--test", "--test-reporter=tap", `--test-concurrency=${opts.concurrency}`, ...present],
    { cwd: dir, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const tap = `${r.stdout || ""}`;
  const count = (k) => Number((new RegExp(`^# ${k} (\\d+)$`, "m").exec(tap) || [])[1] || 0);
  return {
    ref, sha: git(dir, ["rev-parse", "--short", "HEAD"]), files: present.length,
    missing: files.filter((f) => !present.includes(f)),
    tests: count("tests"), pass: count("pass"), fail: count("fail"),
    failures: parseTapFailures(tap), dir,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = git(process.cwd(), ["rev-parse", "--show-toplevel"]);
  const root = mkdtempSync(join(tmpdir(), "clean-main-baseline-"));
  try {
    const base = runSide(repo, opts.base, "base", opts, root);
    const head = runSide(repo, opts.head, "head", opts, root);
    const diff = diffFailures(base.failures, head.failures);
    const strip = ({ dir, ...rest }) => rest;
    const report = { base: strip(base), head: strip(head), ...diff };
    for (const s of [base, head]) {
      console.log(`${s === base ? "base" : "head"} ${s.ref} @ ${s.sha}: files ${s.files} tests ${s.tests} pass ${s.pass} fail ${s.fail}`);
    }
    for (const k of ["introduced", "fixed", "persistent"]) {
      console.log(`${k}: ${diff[k].length}`);
      for (const t of diff[k]) console.log(`  ${t}`);
    }
    if (opts.json) writeFileSync(opts.json, `${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = diff.introduced.length ? 1 : 0;
  } finally {
    if (!opts.keep) {
      for (const label of ["base", "head"]) {
        const dir = join(root, label);
        if (existsSync(dir)) spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: repo });
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
