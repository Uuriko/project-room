// Fail-first check: each regress test must FAIL against its mutant, PASS on original.
// Usage: node failfirst.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = "/home/hatch/workspace/pr-wave1000-guild-07";
const G = join(HERE, "work");
mkdirSync(G, { recursive: true });

const spec = JSON.parse(readFileSync(join(HERE, "mutants.json"), "utf8"))
  .filter(m => ["M2", "M4", "M5", "M7", "M14", "M15"].includes(m.id));
const testName = { M2: "M2-regress", M4: "M4-regress", M5: "M5-regress", M7: "M7-regress", M14: "M14-regress", M15: "M15-regress" };

console.log("id | mutant-run (want FAIL) | original-run (want PASS)");
for (const m of spec) {
  const path = join(W, m.file);
  const src = readFileSync(path, "utf8");
  copyFileSync(path, join(G, `${m.id}.ff.orig`));
  const run = () => spawnSync("node", ["--test", `--test-name-pattern=${testName[m.id]}`, "findings/guild-07/_harness/regress.test.mjs"],
    { cwd: W, env: { ...process.env, TMPDIR: join(W, ".tmp") }, timeout: 120000, encoding: "utf8" }).status === 0 ? "PASS" : "FAIL";
  writeFileSync(path, src.replace(m.needle, m.replacement));
  const onMutant = run();
  copyFileSync(join(G, `${m.id}.ff.orig`), path);
  const onOriginal = run();
  const ok = onMutant === "FAIL" && onOriginal === "PASS";
  console.log(`${m.id} | ${onMutant} | ${onOriginal} ${ok ? "OK fail-first" : "<<< PROBLEM"}`);
}
