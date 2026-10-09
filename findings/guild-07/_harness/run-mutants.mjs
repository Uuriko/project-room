// Mutation runner for wave1000 guild-07 (client-web slice).
// Sequential per mutant (mutants must not interact). Restores every file.
// Usage: W=<worktree> node run-mutants.mjs [M6,M9] [--timeout-ms 90000]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = process.env.W || "/home/hatch/workspace/pr-wave1000-guild-07";
const G = join(W, "findings/guild-07/_harness/work");
mkdirSync(G, { recursive: true });
const logPath = join(W, "findings/guild-07/mutants.md");
const summaryPath = join(G, "mutant-results.json");

const only = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2].split(",") : null;
const tmo = Number(process.argv.find(a => a.startsWith("--timeout-ms"))?.split("=")[1]) || 240000;

const spec = JSON.parse(readFileSync(join(HERE, "mutants.json"), "utf8")).filter(m => !only || only.includes(m.id));
const results = [];
const append = text => writeFileSync(logPath, text, { flag: "a" });

append(`\n# Mutation re-run — ${only ? only.join(",") : "all"} (${new Date().toISOString()}, timeout ${tmo}ms)\n\n`);

for (const m of spec) {
  const path = join(W, m.file);
  const src = readFileSync(path, "utf8");
  copyFileSync(path, join(G, `${m.id}.orig`));
  let status, detail;
  const occ = src.split(m.needle).length - 1;
  if (occ !== 1) {
    status = "INCONCLUSIVE";
    detail = `needle occurs ${occ}x, expected exactly 1 — skipped without running`;
  } else {
    writeFileSync(path, src.replace(m.needle, m.replacement));
    const r = spawnSync("node", ["--test", ...m.tests], {
      cwd: W, env: { ...process.env, TMPDIR: join(W, ".tmp") },
      timeout: tmo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
    });
    if (r.error?.code === "ETIMEDOUT") { status = "TIMEOUT"; detail = `test run exceeded ${tmo}ms — hang/livelock, needs manual review`; }
    else if (r.status === 0) { status = "SURVIVED"; detail = "tests passed with the mutant in place"; }
    else { status = "KILLED"; detail = `tests failed (exit ${r.status}); tail: ${(r.stdout + r.stderr).slice(-1200).replace(/\n/g, " | ")}`; }
    copyFileSync(join(G, `${m.id}.orig`), path);
    if (readFileSync(path, "utf8") !== src) { status = "RESTORE-FAILED"; detail = "file did not restore cleanly — STOP"; }
  }
  results.push({ id: m.id, file: m.file, status, desc: m.desc, detail, tests: m.tests });
  append(`## ${m.id} ${m.file} — ${status}\n- ${m.desc}\n- tests: ${m.tests.join(", ")}\n- ${detail}\n\n`);
  console.log(`${m.id} ${status}`);
  if (status === "RESTORE-FAILED") break;
}
const k = results.filter(r => r.status === "KILLED").length;
const s = results.filter(r => r.status === "SURVIVED").length;
const i = results.filter(r => !["KILLED", "SURVIVED"].includes(r.status)).length;
append(`Totals: mutants ${results.length}, killed ${k}, survived ${s}, inconclusive/timeout ${i}\n`);
writeFileSync(summaryPath, JSON.stringify({ results, totals: { k, s, i } }, null, 2));
console.log(`done: killed=${k} survived=${s} inconclusive=${i}`);
