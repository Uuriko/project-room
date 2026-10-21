#!/usr/bin/env node
// Room-scale benchmark: how much one message, one read and one rebuild cost as
// a room grows, and whether a change made them better or worse.
//
//   npm run bench:room                                  # working tree vs origin/main, sizes 1000,4000, 5 runs each
//   npm run bench:room -- --base HEAD~3 --sizes 2000
//   npm run bench:room -- --base none                   # just measure the working tree
//   npm run bench:room -- --rigorous --out bench.json   # 10 runs per side
//
// Method (after Go's benchstat; see docs/BENCH.md): each tree builds its own
// deterministic fixture per size, then base and head runs alternate in fresh
// processes. Each metric reports the median with a 95% interval, and is called
// better or worse only when an exact Mann-Whitney test gives p < 0.05 AND the
// median moved by at least the noise floor (10% by default).
import { execFileSync, spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, holm, median, medianInterval, verdict } from "./stats.mjs";
import { qualifiedSamples } from "./validity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const arg = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
if (flag("help")) { process.stdout.write(readHelp()); process.exit(0); }

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const baseRef = arg("base", "origin/main");
const sizes = arg("sizes", "1000,4000").split(",").map(Number).filter(n => n > 0);
// 6 per side is the smallest count whose exact test can pass the Holm-adjusted threshold.
const runs = Number(arg("runs", flag("rigorous") ? 10 : 6));
const writes = Number(arg("writes", 200));
const floor = Number(arg("floor", 0.1));
const replayCap = Number(arg("replay-cap", 4000));
const out = arg("out");
const keep = flag("keep");
const bodiesAtRest = flag("bodies-at-rest");

// Lower is better for every metric here; bytes included.
const METRICS = [
  ["writeP50Ms", "write p50 (ms)", r => r.writeP50Ms],
  ["writeP95Ms", "write p95 (ms)", r => r.writeP95Ms],
  ["storedProjectionMs", "storedProjection (ms)", r => r.storedProjectionMs],
  ["coldRoomMs", "cold room() (ms)", r => r.coldRoomMs],
  ["projectionKB", "projection (KB)", r => r.projectionKB],
  ["snapshotBuildMs", "snapshot build (ms)", r => r.snapshotBuildMs],
  ["httpFullKB", "GET full room (KB)", r => r.httpFullKB],
  ["httpFullMs", "GET full room (ms)", r => r.httpFullMs],
  ["httpRecentKB", "GET recent window (KB)", r => r.httpRecentKB],
  ["httpRecentMs", "GET recent window (ms)", r => r.httpRecentMs],
  ["replayMs", "replay from log (ms)", r => r.replayMs],
];

const git = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
const scratch = mkdtempSync(join(tmpdir(), "room-bench-"));
const cleanups = [];
const log = message => process.stderr.write(`[bench] ${message}\n`);

function prepareBase(ref) {
  const sha = git("rev-parse", "--verify", `${ref}^{commit}`);
  const dir = join(scratch, `base-${sha.slice(0, 8)}`);
  git("worktree", "add", "--detach", "--quiet", dir, sha);
  cleanups.push(() => { try { git("worktree", "remove", "--force", dir); } catch { rmSync(dir, { recursive: true, force: true }); } });
  if (existsSync(join(repo, "node_modules")) && !existsSync(join(dir, "node_modules"))) symlinkSync(join(repo, "node_modules"), join(dir, "node_modules"), "dir");
  return { label: `base ${ref} (${sha.slice(0, 8)})`, root: dir, sha };
}

function headTree() {
  const sha = git("rev-parse", "HEAD");
  const dirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
  return { label: `head ${sha.slice(0, 8)}${dirty ? "+changes" : ""}`, root: repo, sha, dirty };
}

function node(script, scriptArgs, label) {
  const run = spawnSync(process.execPath, ["--expose-gc", join(here, script), ...scriptArgs], { encoding: "utf8", maxBuffer: 64 << 20 });
  if (run.status !== 0) throw new Error(`${label} failed (${run.status}): ${(run.stderr || "").split("\n").filter(line => !["cold_start", "SECURITY_CONTACT", "mailer"].some(noise => line.includes(noise))).slice(-8).join("\n")}`);
  const line = run.stdout.trim().split("\n").filter(l => l.startsWith("{")).at(-1);
  return JSON.parse(line);
}

function fmt(value, ci) {
  if (!Number.isFinite(value)) return "n/a";
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const v = value.toFixed(digits);
  return ci && Number.isFinite(ci.low) ? `${v} [${ci.low.toFixed(digits)}–${ci.high.toFixed(digits)}]` : v;
}

try {
  const head = headTree();
  const base = baseRef === "none" ? null : prepareBase(baseRef);
  const trees = base ? [base, head] : [head];
  const samples = {}; // samples[size][label] = [result...]
  const fixtures = {};
  for (const size of sizes) {
    for (const tree of trees) {
      const dir = join(scratch, `fixture-${tree === head ? "head" : "base"}-${size}`);
      mkdirSync(dir, { recursive: true });
      const t = performance.now();
      const seeded = node("fixture.mjs", ["--root", tree.root, "--size", String(size), "--out", dir, ...(bodiesAtRest ? ["--bodies-at-rest"] : [])], `fixture ${tree.label} ${size}`);
      fixtures[`${tree.label}:${size}`] = dir;
      log(`${tree.label}: built ${size}-message room in ${((performance.now() - t) / 1000).toFixed(1)} s${seeded.failed ? ` (${seeded.failed} failed: ${seeded.lastError})` : ""}`);
    }
    samples[size] = Object.fromEntries(trees.map(t => [t.label, []]));
    for (let i = 0; i < runs; i++) {
      // Alternate the order each round so drift on a shared machine hits both sides alike.
      for (const tree of i % 2 ? [...trees].reverse() : trees) {
        samples[size][tree.label].push(node("room-scale.mjs", ["--root", tree.root, "--fixture", fixtures[`${tree.label}:${size}`], "--writes", String(writes), "--replay-cap", String(replayCap)], `run ${tree.label} ${size}`));
      }
      log(`size ${size}: round ${i + 1}/${runs} done`);
    }
  }

  const env = { node: process.version, cpu: cpus()[0]?.model, cores: cpus().length, runs, writes, floor, sizes, bodiesAtRest, date: new Date().toISOString() };
  const lines = [];
  lines.push(`Room-scale benchmark · ${head.label}${base ? ` vs ${base.label}` : ""}`);
  lines.push(`${runs} runs${base ? " per side, alternating" : ""}, fresh process each · ${writes} writes per run · bodies ${bodiesAtRest ? "at rest" : "inline"} · Node ${env.node} · ${env.cpu} (${env.cores} cores)`);
  lines.push("");
  const report = { env, base: base && { ref: baseRef, sha: base.sha }, head: { sha: head.sha, dirty: head.dirty }, sizes: {} };
  for (const size of sizes) {
    const rows = [];
    lines.push(`Room of ${size} messages`);
    if (base) {
      lines.push("| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |");
      lines.push("|---|---|---|---|---|---|");
    } else {
      lines.push("| metric | median [95% CI] |");
      lines.push("|---|---|");
    }
    const compared = base ? METRICS.map(([key, name, pick]) => {
      const b = qualifiedSamples(samples[size][base.label], key, pick), h = qualifiedSamples(samples[size][head.label], key, pick);
      return { key, name, ...compare(b, h, { floor }), baseSamples: b, headSamples: h };
    }) : [];
    // Metrics that are identical constants on both sides (byte counts that did not
    // change) carry no test; leaving them out keeps the correction from diluting the rest.
    const constantSame = c => [...c.baseSamples, ...c.headSamples].filter(Number.isFinite).every((v, _, all) => v === all[0]);
    const adjusted = holm(compared.map(c => constantSame(c) ? NaN : c.p));
    compared.forEach((c, i) => { c.pAdjusted = Number.isFinite(adjusted[i]) ? adjusted[i] : c.p; c.verdict = verdict(c.ratio, c.pAdjusted, { floor }); });
    for (const [key, name, pick] of METRICS) {
      const h = qualifiedSamples(samples[size][head.label], key, pick);
      if (base) {
        const c = compared.find(row => row.key === key);
        rows.push(c);
        const ratio = Number.isFinite(c.ratio) ? `${c.ratio.toFixed(2)}x` : "n/a";
        const said = c.verdict === "better" ? `**better** (${((1 - c.ratio) * 100).toFixed(0)}% less)` : c.verdict === "worse" ? `**worse** (${((c.ratio - 1) * 100).toFixed(0)}% more)` : c.verdict;
        lines.push(`| ${name} | ${fmt(c.base, c.baseCi)} | ${fmt(c.head, c.headCi)} | ${ratio} | ${Number.isFinite(c.pAdjusted) ? c.pAdjusted.toFixed(3) : "n/a"} | ${said} |`);
      } else {
        const finite = h.filter(Number.isFinite);
        rows.push({ key, head: median(finite), headCi: medianInterval(finite), headSamples: h });
        lines.push(`| ${name} | ${fmt(median(finite), medianInterval(finite))} |`);
      }
    }
    report.sizes[size] = rows;
    lines.push("");
  }
  const failures = sizes.flatMap(size => Object.values(samples[size]).flat().map(r => r.writeFailures)).reduce((a, b) => a + b, 0);
  if (failures) lines.push(`Note: ${failures} benchmark writes were refused; affected write comparisons are n/a. Raw successful-write timings are retained.`);
  lines.push(`Verdicts need a Holm-adjusted p < 0.05 across this size's metrics and a move of ${Math.round(floor * 100)}% or more. Under 6 runs, intervals span the full range.`);
  process.stdout.write(lines.join("\n") + "\n");
  if (out) writeFileSync(resolve(out), JSON.stringify({ ...report, raw: samples }, null, 1));
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
}

function readHelp() {
  return `npm run bench:room -- [--base <ref>|none] [--sizes 1000,4000] [--runs 5|--rigorous] [--writes 200]
                       [--floor 0.1] [--replay-cap 4000] [--bodies-at-rest] [--out file.json] [--keep]
Compares the working tree against --base (default origin/main) on a deterministic
muse-room-shaped fixture. See docs/BENCH.md.
`;
}
