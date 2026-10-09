// WAVE-1000 guild-14 mutation driver.
// usage: node mutdriver.mjs <worktree> <spec.json>
// spec.json: { unit, file, tests: [...], mutants: [{name, find, replace}] }
// find/replace are literal strings; first occurrence is replaced.
// For each mutant: apply, run tests (TMPDIR=<worktree>/.tmp), restore, record.
// Writes JSON results to <worktree>/findings/guild-14/mutants-<unit>.json and a human log.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

const [worktree, specPath] = process.argv.slice(2);
if (!worktree || !specPath) { console.error("usage: mutdriver.mjs <worktree> <spec.json>"); process.exit(2); }
const spec = JSON.parse(readFileSync(specPath, "utf8"));
const fileAbs = join(worktree, spec.file);
const original = readFileSync(fileAbs, "utf8");
const findingsDir = join(worktree, "findings", "guild-14");
mkdirSync(join(worktree, ".tmp"), { recursive: true });
mkdirSync(findingsDir, { recursive: true });

const results = [];
for (const m of spec.mutants) {
  const entry = { unit: spec.unit, file: spec.file, mutant: m.name, status: "SKIP", tests: spec.tests };
  const idx = original.indexOf(m.find);
  if (idx === -1) {
    entry.status = "SKIP";
    entry.note = "find string not present in file";
    results.push(entry);
    console.log(`SKIP ${m.name} (find string absent)`);
    continue;
  }
  const mutated = original.slice(0, idx) + m.replace + original.slice(idx + m.find.length);
  writeFileSync(fileAbs, mutated);
  try {
    const r = spawnSync("node", ["--test", ...spec.tests], {
      cwd: worktree,
      env: { ...process.env, TMPDIR: join(worktree, ".tmp") },
      timeout: 300000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = r.stdout.toString() + r.stderr.toString();
    const failed = r.status !== 0;
    // Count pass/fail lines conservatively: node --test exits non-zero on any failure.
    entry.status = failed ? "KILLED" : "SURVIVED";
    entry.exitCode = r.status;
    const failMatch = out.match(/not ok (\d+)/g);
    entry.failedTests = failMatch ? failMatch.length : (failed ? "unknown" : 0);
    writeFileSync(join(findingsDir, `mutantlog-${spec.unit}-${m.name}.txt`), out.slice(-20000));
    console.log(`${entry.status} ${m.name} (exit ${r.status})`);
  } finally {
    writeFileSync(fileAbs, original); // restore no matter what
  }
  results.push(entry);
}
// Double-check restoration.
const restored = readFileSync(fileAbs, "utf8");
if (restored !== original) {
  writeFileSync(fileAbs, original);
  console.error("WARNING: file was not clean after restore; forced restore");
}
const killed = results.filter(r => r.status === "KILLED").length;
const survived = results.filter(r => r.status === "SURVIVED").length;
const skipped = results.filter(r => r.status === "SKIP").length;
const summary = { unit: spec.unit, file: spec.file, mutants: spec.mutants.length, killed, survived, skipped, results };
writeFileSync(join(findingsDir, `mutants-${spec.unit}.json`), JSON.stringify(summary, null, 2));
console.log(`DONE ${spec.unit}: ${killed} killed / ${survived} survived / ${skipped} skipped of ${spec.mutants.length}`);
