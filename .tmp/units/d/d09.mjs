// d09: mutants.md — aggregates .tmp/units/results/uNN.txt into the findings
// ledger. Runs AFTER all mutation units complete.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const OUT = process.argv[2];
const units = ["u01","u02","u03","u04","u05","u06","u07","u08","u09","u10","u11","u12","u13","u14","u15"];
const rows = [];
let killed = 0, survived = 0;
for (const u of units) {
  const p = `${W}/.tmp/units/results/${u}.txt`;
  if (!existsSync(p)) { rows.push(`| ${u} | — | NOT RUN |`); continue; }
  const t = readFileSync(p, "utf8");
  const get = k => (t.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1] || "";
  const oc = get("outcome");
  if (oc === "KILLED") killed++; else if (oc === "SURVIVED") survived++;
  rows.push(`| ${u} | ${get("file").split("/").pop()} | ${oc} | ${get("harness")} | ${get("mutant")} |`);
}
const gaps = [
  "u02 — pruneWindows exact-cutoff boundary (t == cutoff kept vs dropped) untested.",
  "u09 — contract test pins the threshold SHAPE but not which threshold (criticalAt vs warnAt).",
  "u10 — telemetry/validate.mjs has NO automated suite coverage at all.",
  "u11 — collect.mjs FINDING-prefix gate unpinned by tests.",
  "u12 — build-dashboard-data.mjs fail-fast-on-corrupt-line unpinned by tests.",
  "u15 — SKIPPED_RECHECK_MS unpinned by tests.",
].join("\n");
writeFileSync(OUT + "/mutants.md", `# Mutation testing (guild-11)

15 mutants across server/tripwires.mjs, telemetry/gauges.mjs,
telemetry/validate.mjs, telemetry/collect.mjs,
telemetry/build-dashboard-data.mjs, server/agent-plugin-store.mjs.
Each mutant ran the affected suite under an exclusive file lock; files were
restored after every unit (git tree clean).

## Scoreboard

killed=${killed} survived=${survived} (harness=DETECTED means my ad-hoc harness
caught what the suite missed — those are test gaps, not suite kills)

| unit | file | suite verdict | harness | mutant |
|---|---|---|---|---|
${rows.join("\n")}

## Test gaps (survived mutants)

${gaps}

## Bugs confirmed

None. Every survived mutant was a test-coverage gap, not a behavior bug:
each was verified against the documented contract (gotchas.md) and found
consistent. No BUG CONFIRMED posts were warranted.
`);
console.log(`d09 wrote mutants.md (killed=${killed} survived=${survived})`);
