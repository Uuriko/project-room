#!/usr/bin/env node
// train-plan.mjs: read-only merge-train planner.
//
// Reads open PRs, keeps the ones whose required checks are green at their
// head and whose commits are not already on main, then simulates landing
// them in order with `git merge-tree` and prints batches that apply cleanly
// on top of each other. Conflicts confined to generated files count as
// clean, because those files are regenerated once per batch.
//
// It changes nothing: no pushes, no merges, no labels, no comments, no room
// writes. Local git objects it creates are unreferenced and get collected.
//
// Usage:
//   node scripts/train-plan.mjs [--batch 10] [--limit 400] [--label ready-to-land]
//                               [--json out.json] [--repo Uuriko/project-room]
// Needs `gh` (REST only) and a clone with an `origin` remote.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

export const REQUIRED_CHECKS = ["test", "contract", "lint", "browser", "cloudflare"];
// Files regenerated at landing time. A conflict only in these does not block.
export const GENERATED = new Set([
  "scripts/CANDIDATE-MANIFEST.json",
  "docs/openapi.yaml",
  "skills/project-room/references/errors-catalog.md",
  "tests/fixtures/mcp-catalog.snapshot.json"
]);
export const isGenerated = path => GENERATED.has(path) || /(^|\/)errors-catalog\.md$/.test(path);

// Required checks are green when each named check's latest run succeeded.
export function checksGreen(runs, required = REQUIRED_CHECKS) {
  const latest = new Map();
  for (const run of runs) {
    const prev = latest.get(run.name);
    if (!prev || String(run.started_at ?? "") > String(prev.started_at ?? "")) latest.set(run.name, run);
  }
  const missing = required.filter(name => latest.get(name)?.conclusion !== "success");
  return { green: missing.length === 0, missing };
}

// Greedy batches in input order: a PR joins the current batch when it merges
// cleanly (ignoring generated files) on top of everything already in it.
// tryMerge(base, pr) -> { ok, next, conflicts } is injected so this is testable.
export function planBatches(candidates, { batchSize = 10, tryMerge, start }) {
  const batches = [], skipped = [];
  let pending = [...candidates];
  let base = start;
  while (pending.length) {
    const batch = [], rest = [];
    let tip = base;
    for (const pr of pending) {
      if (batch.length >= batchSize) { rest.push(pr); continue; }
      const result = tryMerge(tip, pr);
      if (result.ok) { batch.push({ ...pr, regenerate: result.regenerate ?? [] }); tip = result.next; }
      else rest.push({ ...pr, conflicts: result.conflicts });
    }
    if (!batch.length) { skipped.push(...rest); break; }
    batches.push(batch);
    base = tip;
    pending = rest;
  }
  return { batches, skipped };
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 28, ...opts }).trim();
}
function tryGit(args, opts = {}) {
  try { return { ok: true, out: sh("git", args, opts) }; }
  catch (error) { return { ok: false, out: String(error.stdout ?? ""), status: error.status }; }
}
function ghJson(path) { return JSON.parse(sh("gh", ["api", path])); }

function args(argv) {
  const out = { batch: 10, limit: 400, label: "ready-to-land", json: null, repo: "Uuriko/project-room" };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i].replace(/^--/, "");
    if (key in out) out[key] = ["batch", "limit"].includes(key) ? Number(argv[++i]) : argv[++i];
  }
  return out;
}

async function main() {
  const opt = args(process.argv.slice(2));
  sh("git", ["fetch", "-q", "origin", "main"]);
  const main = sh("git", ["rev-parse", "origin/main"]);
  const prs = [];
  for (let page = 1; prs.length < opt.limit; page += 1) {
    const batch = ghJson(`repos/${opt.repo}/pulls?state=open&base=main&per_page=100&page=${page}`);
    prs.push(...batch);
    if (batch.length < 100) break;
  }
  const report = { main, at: new Date().toISOString(), considered: 0, notGreen: [], landed: [], candidates: [] };
  for (const pr of prs.slice(0, opt.limit)) {
    if (pr.draft) continue;
    if (opt.label && !pr.labels.some(label => label.name === opt.label)) continue;
    report.considered += 1;
    const runs = ghJson(`repos/${opt.repo}/commits/${pr.head.sha}/check-runs?per_page=100`).check_runs;
    const checks = checksGreen(runs);
    if (!checks.green) { report.notGreen.push({ number: pr.number, missing: checks.missing }); continue; }
    if (!tryGit(["cat-file", "-e", pr.head.sha]).ok) tryGit(["fetch", "-q", "origin", `pull/${pr.number}/head`]);
    // Already on main: every commit of the PR has an equivalent patch there.
    const cherry = tryGit(["cherry", main, pr.head.sha]);
    if (cherry.ok && cherry.out && !cherry.out.split("\n").some(line => line.startsWith("+"))) {
      report.landed.push(pr.number); continue;
    }
    report.candidates.push({ number: pr.number, title: pr.title, head: pr.head.sha, branch: pr.head.ref });
  }
  // Oldest first, so the queue stays first-in, first-out.
  report.candidates.sort((a, b) => a.number - b.number);
  const tryMerge = (tip, pr) => {
    const merged = tryGit(["merge-tree", "--write-tree", "--name-only", "--no-messages", tip, pr.head]);
    const [tree, ...files] = merged.out.split("\n").filter(Boolean);
    if (!merged.ok && merged.status !== 1) return { ok: false, conflicts: ["merge-tree failed"] };
    const conflicts = merged.ok ? [] : files;
    if (conflicts.some(path => !isGenerated(path))) return { ok: false, conflicts: conflicts.filter(path => !isGenerated(path)) };
    // Generated-only conflicts: keep the batch's version; the train rebuilds them.
    let finalTree = tree;
    if (conflicts.length) {
      const index = `${process.env.TMPDIR ?? "/tmp"}/train-plan-index-${process.pid}`;
      const env = { ...process.env, GIT_INDEX_FILE: index };
      sh("git", ["read-tree", tree], { env });
      for (const path of conflicts) {
        const entry = tryGit(["ls-tree", tip, "--", path]).out;
        if (entry) { const [meta, ] = entry.split("\t"); const [mode, , blob] = meta.split(" "); sh("git", ["update-index", "--cacheinfo", `${mode},${blob},${path}`], { env }); }
      }
      finalTree = sh("git", ["write-tree"], { env });
    }
    const next = sh("git", ["commit-tree", finalTree, "-p", tip, "-p", pr.head, "-m", `train-plan ${pr.number}`]);
    return { ok: true, next, regenerate: conflicts };
  };
  const plan = planBatches(report.candidates, { batchSize: opt.batch, tryMerge, start: main });
  report.batches = plan.batches.map(batch => batch.map(({ number, title, head, regenerate }) => ({ number, title, head: head.slice(0, 8), regenerate })));
  report.blocked = plan.skipped.map(({ number, conflicts }) => ({ number, conflicts }));
  if (opt.json) writeFileSync(opt.json, JSON.stringify(report, null, 2));
  console.log(`main ${main.slice(0, 8)}: ${report.considered} considered, ${report.notGreen.length} not green, ${report.landed.length} already on main, ${report.candidates.length} candidates`);
  report.batches.forEach((batch, i) => {
    console.log(`\nBatch ${i + 1} (${batch.length})`);
    for (const pr of batch) console.log(`  #${pr.number} ${pr.head} ${pr.title.slice(0, 70)}${pr.regenerate.length ? `  [regenerate: ${pr.regenerate.join(", ")}]` : ""}`);
  });
  if (report.blocked.length) console.log(`\nConflict with an earlier batch or main: ${report.blocked.map(item => `#${item.number}`).join(" ")}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exit(1); });
