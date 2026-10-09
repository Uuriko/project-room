// Invariants results renderer (PRODUCT-200 reliability, worker A14).
//
// Reads a JSONL results file written by scripts/invariants-reporter.mjs
// (contract: docs/INVARIANTS-TELEMETRY.md) and renders the latest run as a
// markdown table, suitable for pasting into a PR comment.
//
// Usage:
//   node scripts/invariants-report.mjs [results-file] [--fail-on-fail] [--out FILE]
//
// Default file: $INVARIANTS_RESULTS_FILE, else the newest
// results/invariants*.jsonl by mtime. With several runs in one file only the
// latest run is rendered.
//
// Exit codes: 0 after rendering; 2 when no results file exists;
// --fail-on-fail exits 1 when the latest run has any fail/error.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readResults, latestRun } from "./invariants-reporter.mjs";

const STATUS_ICON = { pass: "✅", fail: "❌", skip: "⏭️", error: "⚠️" };

function esc(cell) {
  return String(cell ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function findDefaultFile() {
  if (process.env.INVARIANTS_RESULTS_FILE) return resolve(process.env.INVARIANTS_RESULTS_FILE);
  let repoRoot;
  try {
    repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  } catch {
    repoRoot = process.cwd();
  }
  const dir = join(repoRoot, "results");
  if (!existsSync(dir)) return null;
  const cands = readdirSync(dir)
    .filter((f) => f.startsWith("invariants") && f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
  return cands[0] || null;
}

function renderMarkdown(run) {
  const shortSha = (run.repoSha || "unknown").slice(0, 12);
  const head = `## Invariant results — \`${esc(shortSha)}\` · ${esc(run.startedAt || "unknown time")}`;
  const sub = run.runCount > 1 ? `\n\n_${run.runCount} runs in file, showing the latest._` : "";
  const lines = [head + sub, "", "| invariant | status | duration | message |", "| --- | --- | --- | --- |"];
  for (const r of run.results) {
    const icon = STATUS_ICON[r.status] || "❓";
    lines.push(`| ${esc(r.name)} | ${icon} ${esc(r.status)} | ${esc(r.duration_ms)} ms | ${esc(r.message)} |`);
  }
  const c = run.end?.counts || { pass: 0, fail: 0, skip: 0, error: 0 };
  const total = run.end?.duration_ms ?? run.results.reduce((s, r) => s + (r.duration_ms || 0), 0);
  lines.push("", `**${c.pass} pass · ${c.fail} fail · ${c.skip} skip · ${c.error} error** · total ${total} ms · run \`${esc(run.runId)}\``);
  return lines.join("\n") + "\n";
}

function cliMain(argv) {
  let file = null;
  let failOnFail = false;
  let out = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fail-on-fail") failOnFail = true;
    else if (a === "--out") out = argv[++i];
    else if (!a.startsWith("--") && !file) file = a;
    else {
      process.stderr.write(`invariants-report: unknown argument ${a}\n`);
      process.exit(2);
    }
  }
  file = file ? resolve(file) : findDefaultFile();
  if (!file || !existsSync(file)) {
    process.stderr.write("invariants-report: no invariant results file found (pass a path or set INVARIANTS_RESULTS_FILE)\n");
    process.exit(2);
  }
  let run;
  try {
    run = latestRun(readResults(file));
  } catch (err) {
    process.stderr.write(`invariants-report: cannot parse ${file}: ${err.message}\n`);
    process.exit(2);
  }
  const md = renderMarkdown(run);
  if (out) writeFileSync(resolve(out), md, "utf8");
  else process.stdout.write(md);
  const c = run.end?.counts || { pass: 0, fail: 0, skip: 0, error: 0 };
  // Set exitCode (don't process.exit): lets pending stdout flush on pipes.
  if (failOnFail && (c.fail > 0 || c.error > 0)) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cliMain(process.argv.slice(2));
}
