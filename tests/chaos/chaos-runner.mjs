// chaos-runner.mjs — deterministic seeded chaos harness runner.
//
// Loads every scenario in tests/chaos/scenarios/*.mjs, executes each with a
// fixed seed against a scratch SQLite DB, injects the seeded faults, and
// writes one JSONL line per scenario:
//   {scenario, seed, faults, outcome, checks}
//
// Usage:
//   node tests/chaos/chaos-runner.mjs --seed 42
//   node tests/chaos/chaos-runner.mjs --seed 42 --report /tmp/chaos.jsonl
//   node tests/chaos/chaos-runner.mjs --list
//   node tests/chaos/chaos-runner.mjs --seed 42 --scenario claim-release

import { readdirSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scratchDbPath, ChaosContext } from "./chaos-kit.mjs";

export const here = dirname(fileURLToPath(import.meta.url));
export const SCENARIO_DIR = join(here, "scenarios");
export const DEFAULT_REPORT_DIR = join(here, "reports");

// ---------------------------------------------------------------------------
// Scenario loading + execution
// ---------------------------------------------------------------------------

export async function loadScenarios(dir = SCENARIO_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
  const out = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.run !== "function" || typeof mod.name !== "string") {
      throw new Error(`scenario ${file} must export { name: string, run(ctx): Promise }`);
    }
    out.push({ file, name: mod.name, run: mod.run, description: mod.description ?? "" });
  }
  return out;
}

export async function runScenario(scenario, { seed }) {
  const { dir, path } = scratchDbPath(scenario.name, seed);
  const ctx = new ChaosContext({ scenarioName: scenario.name, seed, dbPath: path, dbDir: dir });
  const startedAt = Date.now();
  let outcome = "pass";
  let error = null;
  try {
    await scenario.run(ctx);
  } catch (err) {
    outcome = "fail";
    error = { name: err.name, message: err.message };
  } finally {
    try {
      ctx.db.close();
    } catch {
      // killed mid-transaction: already closed
    }
    if (outcome === "pass") {
      // Keep the scratch DB on failure for post-mortem; the JSONL report
      // carries all evidence on success.
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    scenario: scenario.name,
    seed,
    faults: ctx.faults,
    outcome,
    checks: ctx.checks,
    ...(error ? { error } : {}),
    at: new Date().toISOString(),
    elapsed_ms: Date.now() - startedAt,
  };
}

export async function runAll({ seed, reportPath = null, scenarioFilter = null, dir = SCENARIO_DIR }) {
  const scenarios = (await loadScenarios(dir)).filter(
    (s) => !scenarioFilter || scenarioFilter.includes(s.name),
  );
  const reports = [];
  for (const scenario of scenarios) {
    const report = await runScenario(scenario, { seed });
    reports.push(report);
    if (reportPath) appendFileSync(reportPath, JSON.stringify(report) + "\n");
  }
  return reports;
}

// Strip wall-clock fields before comparing two runs for determinism.
export function deterministicProjection(report) {
  const { at: _at, elapsed_ms: _elapsedMs, ...rest } = report;
  return rest;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  if (args.includes("--list")) {
    for (const s of await loadScenarios()) {
      console.log(`${s.name} — ${s.description} (${s.file})`);
    }
    process.exit(0);
  }
  const seed = Number(flag("--seed") ?? "1");
  if (!Number.isInteger(seed)) {
    console.error("--seed must be an integer");
    process.exit(2);
  }
  const only = flag("--scenario");
  const reportPath = flag("--report") ?? join(DEFAULT_REPORT_DIR, `chaos-seed-${seed}.jsonl`);
  mkdirSync(DEFAULT_REPORT_DIR, { recursive: true });
  const reports = await runAll({
    seed,
    reportPath,
    scenarioFilter: only ? [only] : null,
  });
  let failed = 0;
  for (const r of reports) {
    if (r.outcome !== "pass") failed += 1;
    console.log(`${r.outcome === "pass" ? "PASS" : "FAIL"}  ${r.scenario}  seed=${r.seed}  faults=${r.faults.length}  checks=${r.checks.length}`);
    if (r.error) console.log(`      ${r.error.name}: ${r.error.message}`);
  }
  console.log(`report: ${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}
