// Invariants telemetry reporter (PRODUCT-200 reliability, worker A14).
//
// Library-only module. Emits the JSONL contract in docs/INVARIANTS-TELEMETRY.md
// so any invariant harness (lane A1's frame, or the shell CLI below) can make
// per-invariant pass/fail/duration observable for the CI gate (lane A12) and
// the markdown renderer in scripts/invariants-report.mjs.
//
// Usage:
//   import { InvariantsReporter } from "./scripts/invariants-reporter.mjs";
//   const rep = new InvariantsReporter({ outPath, sha, harness });
//   rep.startRun();
//   await rep.check("claim-release-cas", async () => { /* throws on violation */ });
//   rep.record({ name: "mint-throttle", status: "pass", durationMs: 12 });
//   const summary = rep.endRun();
//
// CLI for shell harnesses (run state persists in <outPath>.run.json):
//   node scripts/invariants-reporter.mjs start [--out PATH] [--harness NAME] [--sha SHA]
//   node scripts/invariants-reporter.mjs record --name ID --status pass|fail|skip|error [--duration-ms N] [--message MSG]
//   node scripts/invariants-reporter.mjs end
//
// Env: INVARIANTS_RESULTS_FILE (default ./results/invariants.jsonl),
//      INVARIANTS_SHA (overrides git SHA resolution).
import { appendFileSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

export const STATUSES = ["pass", "fail", "skip", "error"];

const DEFAULT_RESULTS_FILE = "results/invariants.jsonl";

export function defaultResultsPath() {
  return resolve(process.env.INVARIANTS_RESULTS_FILE || DEFAULT_RESULTS_FILE);
}

function utcNow() {
  return new Date().toISOString();
}

export function resolveSha(explicit) {
  if (explicit) return explicit;
  if (process.env.INVARIANTS_SHA) return process.env.INVARIANTS_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function newRunId() {
  return `inv_${Date.now()}_${randomBytes(3).toString("hex")}`;
}

export function emptyCounts() {
  return { pass: 0, fail: 0, skip: 0, error: 0 };
}

export class InvariantsReporter {
  constructor({ outPath, sha, harness = "node-invariants", harnessVersion } = {}) {
    this.outPath = outPath ? resolve(outPath) : defaultResultsPath();
    this.sha = resolveSha(sha);
    this.harness = harness;
    this.harnessVersion = harnessVersion;
    this.runId = null;
    this.runStartedAt = null;
    this.counts = emptyCounts();
    mkdirSync(dirname(this.outPath), { recursive: true });
  }

  _write(obj) {
    appendFileSync(this.outPath, JSON.stringify(obj) + "\n", "utf8");
  }

  _requireRun() {
    if (!this.runId) throw new Error("no active run: call startRun() first");
  }

  startRun() {
    this.runId = newRunId();
    this.runStartedAt = utcNow();
    this.counts = emptyCounts();
    this._write({
      type: "run_start",
      run_id: this.runId,
      repo_sha: this.sha,
      harness: this.harness,
      ...(this.harnessVersion ? { harness_version: this.harnessVersion } : {}),
      started_at: this.runStartedAt,
    });
    return { runId: this.runId, sha: this.sha };
  }

  record({ name, status, durationMs = 0, message = "", startedAt, finishedAt } = {}) {
    this._requireRun();
    if (!name || typeof name !== "string") throw new Error("record: name is required");
    if (!STATUSES.includes(status)) throw new Error(`record: unknown status ${JSON.stringify(status)} (expected one of ${STATUSES.join(", ")})`);
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error(`record: durationMs must be a finite number >= 0 (got ${durationMs})`);
    }
    const finished = finishedAt || utcNow();
    this._write({
      type: "invariant_result",
      run_id: this.runId,
      repo_sha: this.sha,
      name,
      status,
      duration_ms: Math.round(durationMs),
      started_at: startedAt || finished,
      finished_at: finished,
      message: String(message ?? ""),
    });
    this.counts[status] += 1;
  }

  async check(name, fn) {
    this._requireRun();
    const startedAt = utcNow();
    const t0 = Date.now();
    try {
      await fn();
      this.record({ name, status: "pass", durationMs: Date.now() - t0, startedAt });
    } catch (err) {
      this.record({
        name,
        status: "fail",
        durationMs: Date.now() - t0,
        startedAt,
        message: err && err.message ? String(err.message).split("\n")[0] : String(err),
      });
      // Intentionally swallowed: the failure is the recorded result. The
      // harness keeps running the remaining invariants.
    }
  }

  endRun() {
    this._requireRun();
    const finishedAt = utcNow();
    const status = this.counts.fail + this.counts.error === 0 ? "pass" : "fail";
    this._write({
      type: "run_end",
      run_id: this.runId,
      repo_sha: this.sha,
      finished_at: finishedAt,
      duration_ms: Date.parse(finishedAt) - Date.parse(this.runStartedAt),
      counts: { ...this.counts },
      status,
    });
    const summary = { runId: this.runId, sha: this.sha, counts: { ...this.counts }, status };
    this.runId = null;
    return summary;
  }
}

export function readResults(path) {
  const raw = readFileSync(path, "utf8");
  const records = [];
  for (const [i, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`malformed JSON on line ${i + 1} of ${path}`);
    }
  }
  return records;
}

// Latest run in a records list: groups invariant_result/run_end rows by
// run_id, picks the group whose run_start has the max started_at.
export function latestRun(records) {
  const starts = new Map();
  const results = new Map();
  const ends = new Map();
  for (const r of records) {
    if (r.type === "run_start") starts.set(r.run_id, r);
    else if (r.type === "invariant_result") {
      if (!results.has(r.run_id)) results.set(r.run_id, []);
      results.get(r.run_id).push(r);
    } else if (r.type === "run_end") ends.set(r.run_id, r);
  }
  let best = null;
  for (const [runId, start] of starts) {
    // >= on ties: same-millisecond runs resolve to the later-written run.
    if (!best || (start.started_at || "") >= (best.started_at || "")) best = { runId, ...start };
  }
  if (!best) throw new Error("no run_start found in results");
  return {
    runId: best.runId,
    repoSha: best.repo_sha,
    harness: best.harness,
    startedAt: best.started_at,
    end: ends.get(best.runId) || null,
    results: results.get(best.runId) || [],
    runCount: starts.size,
  };
}

// ---- CLI ----------------------------------------------------------------

function cliArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    } else {
      out._.push(a);
    }
  }
  return out;
}

function statePath(outPath) {
  return outPath + ".run.json";
}

function cliMain(argv) {
  const args = cliArgs(argv);
  const cmd = args._[0];
  const outPath = args.out ? resolve(args.out) : defaultResultsPath();
  const sp = statePath(outPath);

  if (cmd === "start") {
    const rep = new InvariantsReporter({ outPath, sha: args.sha, harness: args.harness || "cli-invariants" });
    const { runId } = rep.startRun();
    writeFileSync(sp, JSON.stringify({ runId, sha: rep.sha, harness: rep.harness }), "utf8");
    return;
  }
  if (cmd === "record" || cmd === "end") {
    if (!existsSync(sp)) {
      process.stderr.write(`invariants-reporter: no active run for ${outPath} (run 'start' first)\n`);
      process.exit(1);
    }
    const state = JSON.parse(readFileSync(sp, "utf8"));
    const rep = new InvariantsReporter({ outPath, sha: state.sha, harness: state.harness });
    // Rehydrate the in-progress run without writing a second run_start.
    rep.runId = state.runId;
    rep.runStartedAt = state.startedAt || utcNow();
    for (const r of readResults(outPath)) {
      if (r.type === "run_start" && r.run_id === state.runId) rep.runStartedAt = r.started_at;
      if (r.type === "invariant_result" && r.run_id === state.runId && STATUSES.includes(r.status)) {
        rep.counts[r.status] += 1;
      }
    }
    if (cmd === "record") {
      if (!args.name || !args.status) {
        process.stderr.write("invariants-reporter record: --name and --status are required\n");
        process.exit(1);
      }
      rep.record({
        name: args.name,
        status: args.status,
        durationMs: args.durationMs !== undefined ? Number(args.durationMs) : 0,
        message: args.message || "",
      });
      return;
    }
    const summary = rep.endRun();
    rmSync(sp, { force: true });
    process.stdout.write(`invariants-reporter: run ${summary.runId} ${summary.status} ${JSON.stringify(summary.counts)}\n`);
    return;
  }
  process.stderr.write(
    "usage: invariants-reporter.mjs <start|record|end>\n" +
      "  start  [--out PATH] [--harness NAME] [--sha SHA]\n" +
      "  record --name ID --status pass|fail|skip|error [--duration-ms N] [--message MSG]\n" +
      "  end\n",
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2));
}
