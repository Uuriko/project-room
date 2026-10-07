#!/usr/bin/env node
// Rebuild scripts/unit-ci-durations.json from recent main-branch CI runs.
//
// The unit-shards planner (scripts/unit-shards.mjs) balances shards on
// per-file durations, but the checked-in durations file decays: it is a
// snapshot, and live evidence (2026-10-07) showed estimated loads balanced
// 1.00 while actual shard wall times ran ~2.5x apart. This script closes the
// loop:
//
//   1. Each unit shard records per-file wall times
//      (test-results/unit-file-durations-<i>-of-3.json, captured by the
//      unit-file-durations reporter that scripts/unit-ci.mjs attaches) into
//      the unit-shard-evidence-* artifacts.
//   2. This script pulls the most recent successful test.yml runs on main via
//      the GitHub API, downloads those artifacts, and regenerates the
//      durations file from per-file MEDIANS across runs (robust to one-off
//      slow flakes and runner noise).
//   3. A scheduled workflow (.github/workflows/unit-durations-refresh.yml)
//      runs this weekly and opens a PR when the file changes materially, so
//      the balancer tracks reality without human intervention.
//
// Only files discovered by the planner's own glob are kept; files with fewer
// than --min-observations observations keep the planner's conservative
// default (they are omitted from the file). Fail-closed: with no usable
// durations data in the sampled runs the script exits non-zero and writes
// nothing.
//
// Usage:
//   node scripts/unit-durations-refresh.mjs [--runs N] [--repo OWNER/REPO]
//       [--out PATH] [--min-observations N] [--workflow PATH]
// Env: GH_TOKEN or GITHUB_TOKEN (falls back to `gh auth token`).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { discoverUnitTests } from "./unit-shards.mjs";

export { normalizeRepoPath } from "./unit-file-durations-reporter.mjs";
import { normalizeRepoPath } from "./unit-file-durations-reporter.mjs";

export const DEFAULT_RUNS = 10;
export const DEFAULT_MIN_OBSERVATIONS = 2;
export const MAX_OBSERVATION_MS = 30 * 60 * 1000; // 30 min: a slower file is a broken run

export function median(values) {
  const sorted = [...values].filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m);
}

// Pure aggregation step (unit-tested): per-run { runId, files: { path: ms } }
// -> { milliseconds: { path: medianMs }, meta }.
export function aggregateDurations(runs, { minObservations = DEFAULT_MIN_OBSERVATIONS, maxObservationMs = MAX_OBSERVATION_MS } = {}) {
  const observations = new Map(); // path -> number[]
  const runIds = [];
  for (const run of runs ?? []) {
    const files = run?.files;
    if (!files || typeof files !== "object") continue;
    let usable = false;
    for (const [path, ms] of Object.entries(files)) {
      if (typeof path !== "string" || !path) continue;
      if (!Number.isFinite(ms) || ms <= 0 || ms > maxObservationMs) continue;
      usable = true;
      if (!observations.has(path)) observations.set(path, []);
      observations.get(path).push(ms);
    }
    if (usable) runIds.push(run.runId);
  }
  if (!runIds.length) {
    throw new Error(
      "unit-durations-refresh: no durations data in the sampled runs " +
      "(the per-file reporter may not have shipped yet, or no successful main runs carry it)"
    );
  }
  const milliseconds = {};
  for (const [path, obs] of observations) {
    if (obs.length < minObservations) continue;
    const m = median(obs);
    if (m !== null) milliseconds[path] = m;
  }
  return {
    milliseconds,
    meta: {
      method: "per-file median across recent successful main runs",
      minObservations,
      runsWithData: runIds.length,
      runs: runIds,
      filesWithData: Object.keys(milliseconds).length,
    },
  };
}

function ghApi(path, token) {
  const out = execFileSync("gh", ["api", path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  return JSON.parse(out);
}

function resolveToken() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (env) return env;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  throw new Error("unit-durations-refresh: no GitHub token (set GH_TOKEN/GITHUB_TOKEN or `gh auth login`)");
}

// Download one artifact zip via the API (gh follows the redirect to the
// signed URL; the response body is the zip).
function fetchArtifactZip(repo, artifactId, token, destZip) {
  const r = spawnSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`], {
    encoding: "buffer",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
  if (r.status !== 0) throw new Error(`artifact ${artifactId} download failed: ${r.stderr?.toString().slice(0, 300)}`);
  writeFileSync(destZip, r.stdout);
}

function unzipFile(zipPath, destDir) {
  const r = spawnSync("unzip", ["-o", "-j", "-q", zipPath, "unit-file-durations-*.json", "-d", destDir], { encoding: "utf8" });
  // unzip exits 11 when no files matched the pattern: not an error here.
  if (r.status !== 0 && r.status !== 11) {
    throw new Error(`unzip failed for ${zipPath}: ${(r.stderr || "").slice(0, 300)}`);
  }
}

export function readDurationsPayload(filePath) {
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    console.error(`unit-durations-refresh: skipping malformed ${filePath}: ${err.message}`);
    return null;
  }
  if (payload?.error) {
    console.error(`unit-durations-refresh: skipping ${filePath}: reporter reported ${payload.error}`);
    return null;
  }
  const files = payload?.files;
  if (!files || typeof files !== "object") {
    console.error(`unit-durations-refresh: skipping ${filePath}: no files map`);
    return null;
  }
  const out = {};
  for (const [path, entry] of Object.entries(files)) {
    const ms = entry?.ms;
    if (typeof path === "string" && path && Number.isFinite(ms) && ms > 0) {
      out[path] = ms;
    }
  }
  return out;
}

function parseArgs(argv) {
  const opts = {
    runs: DEFAULT_RUNS,
    repo: "Uuriko/project-room",
    out: "scripts/unit-ci-durations.json",
    minObservations: DEFAULT_MIN_OBSERVATIONS,
    workflow: "test.yml",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--runs" && next) { opts.runs = Number(next); i++; }
    else if (a === "--repo" && next) { opts.repo = next; i++; }
    else if (a === "--out" && next) { opts.out = next; i++; }
    else if (a === "--min-observations" && next) { opts.minObservations = Number(next); i++; }
    else if (a === "--workflow" && next) { opts.workflow = next; i++; }
    else if (a === "--help" || a === "-h") { opts.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!Number.isSafeInteger(opts.runs) || opts.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isSafeInteger(opts.minObservations) || opts.minObservations < 1) throw new Error("--min-observations must be a positive integer");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("Usage: node scripts/unit-durations-refresh.mjs [--runs N] [--repo OWNER/REPO] [--out PATH] [--min-observations N] [--workflow PATH]");
    return;
  }
  const unzipCheck = spawnSync("unzip", ["-v"], { encoding: "utf8" });
  if (unzipCheck.status !== 0) throw new Error("unit-durations-refresh: the `unzip` binary is required");
  const token = resolveToken();

  const runsPage = ghApi(
    `repos/${opts.repo}/actions/workflows/${opts.workflow}/runs?head_branch=main&status=success&per_page=${opts.runs}`,
    token
  );
  const runs = (runsPage.workflow_runs ?? []).map((r) => ({ id: r.id, created_at: r.created_at }));
  if (!runs.length) throw new Error(`unit-durations-refresh: no successful main runs for ${opts.workflow}`);
  console.log(`unit-durations-refresh: sampling ${runs.length} successful main runs`);

  const scratch = mkdtempSync(join(tmpdir(), "unit-durations-refresh-"));
  const perRun = [];
  try {
    for (const run of runs) {
      const artifacts = ghApi(`repos/${opts.repo}/actions/runs/${run.id}/artifacts?per_page=100`, token).artifacts ?? [];
      const evidence = artifacts.filter((a) => a.name.startsWith("unit-shard-evidence-"));
      if (!evidence.length) {
        console.log(`  run ${run.id}: no unit-shard-evidence artifacts (pre-instrumentation run?)`);
        continue;
      }
      const runDir = join(scratch, String(run.id));
      mkdirSync(runDir, { recursive: true });
      const files = {};
      for (const artifact of evidence) {
        const zipPath = join(runDir, `artifact-${artifact.id}.zip`);
        try {
          fetchArtifactZip(opts.repo, artifact.id, token, zipPath);
          const extractDir = join(runDir, `extracted-${artifact.id}`);
          mkdirSync(extractDir, { recursive: true });
          unzipFile(zipPath, extractDir);
          for (const name of readdirSync(extractDir)) {
            if (!name.startsWith("unit-file-durations-") || !name.endsWith(".json")) continue;
            const parsed = readDurationsPayload(join(extractDir, name));
            if (!parsed) continue;
            for (const [path, ms] of Object.entries(parsed)) {
              // One observation per file per run: keep the max (a re-run
              // shard uploads under a new attempt; attempts of the same run
              // measure the same files).
              files[path] = Math.max(files[path] ?? 0, ms);
            }
          }
        } catch (err) {
          console.error(`  run ${run.id}: artifact ${artifact.name}: ${err.message} (skipped)`);
        } finally {
          rmSync(zipPath, { force: true });
        }
      }
      perRun.push({ runId: String(run.id), files });
      console.log(`  run ${run.id}: ${Object.keys(files).length} files with durations`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const agg = aggregateDurations(perRun, { minObservations: opts.minObservations });
  // Keep only files the planner will actually schedule: drops deleted tests
  // and keeps the file from growing without bound.
  const discovered = new Set(discoverUnitTests("."));
  const milliseconds = {};
  let dropped = 0;
  for (const [path, ms] of Object.entries(agg.milliseconds)) {
    const key = normalizeRepoPath(path, process.cwd());
    if (discovered.has(key)) milliseconds[key] = ms;
    else dropped++;
  }
  const outPath = resolve(opts.out);
  let changed = true;
  if (existsSync(outPath)) {
    try {
      const prev = JSON.parse(readFileSync(outPath, "utf8")).milliseconds ?? {};
      changed = JSON.stringify(prev) !== JSON.stringify(milliseconds);
    } catch { changed = true; }
  }
  const meta = {
    ...agg.meta,
    generatedAt: new Date().toISOString(),
    filesDiscovered: discovered.size,
    filesDroppedNotDiscovered: dropped,
    workflow: opts.workflow,
  };
  if (!changed) {
    console.log("unit-durations-refresh: no change to durations (data already current)");
    return;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ milliseconds, meta }, null, 1) + "\n");
  console.log(`unit-durations-refresh: wrote ${outPath}: ${Object.keys(milliseconds).length} files from ${agg.meta.runsWithData} runs (${dropped} stale entries dropped)`);
}

const invoked = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (invoked) {
  main().catch((err) => { console.error(err.message); process.exit(2); });
}
