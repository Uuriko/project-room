// d08: dead-code analysis with reachability evidence (git grep at HEAD).
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const OUT = process.argv[2];
const g = (pat, paths) => {
  try {
    return execSync(`git -C ${W} grep -n -- '${pat}' -- ${paths} | head -20`, { encoding: "utf8" }).trim();
  } catch { return ""; }
};
const lines = [];
lines.push("# Dead-code analysis (guild-11 slice)");
lines.push("");
lines.push("Method: `git grep` reachability at branch HEAD (wave300/telemetry-prod).");
lines.push("A file/export is DEAD only if no importer exists outside its own tests.");
lines.push("");

// telemetry/*.mjs modules
const mods = [
  ["telemetry/gauges.mjs", "gauges.mjs", "telemetry server tests"],
  ["telemetry/validate.mjs", "validate.mjs", "telemetry tests docs"],
  ["telemetry/verify.mjs", "verify.mjs", "telemetry tests"],
  ["telemetry/collect.mjs", "collect.mjs", "telemetry tests docs"],
  ["telemetry/submit.mjs", "submit.mjs", "telemetry tests docs"],
  ["telemetry/build-dashboard-data.mjs", "build-dashboard-data.mjs", "telemetry tests"],
  ["telemetry/capture-baseline.mjs", "capture-baseline.mjs", "telemetry tests docs"],
];
for (const [mod, base, paths] of mods) {
  const hits = g(base, paths).split("\n").filter(l => l && !l.includes("guild-11"));
  const external = hits.filter(l => !l.startsWith("telemetry/" + base + ":") && !l.includes(".tmp/"));
  lines.push(`## ${mod}`);
  lines.push(external.length ? `LIVE — referenced by:\n${external.map(h => "- " + h).join("\n")}` : "DEAD — no references outside itself");
  lines.push("");
}
// tripwires exports
const exps = ["gaugeStatus", "eventBudgetRemainingRatio", "projectionBytesRatio", "silentTimeoutRatio",
  "createTripwires", "PENALTY_WINDOW_MS", "COMMAND_OUTCOME_WINDOW_MS", "TRIPWIRE_TICK_MS"];
for (const e of exps) {
  const hits = g(e, "server telemetry tests").split("\n").filter(l => l && !l.includes("server/tripwires.mjs:"));
  lines.push(`- export \`${e}\`: ${hits.length ? "LIVE (" + hits.length + " refs)" : "DEAD"}`);
}
lines.push("");
// TRIPWIRE_TICK_MS usage check detail
const tick = g("TRIPWIRE_TICK_MS", "server").split("\n").filter(Boolean);
lines.push(`TRIPWIRE_TICK_MS refs: ${tick.length ? tick.join(" | ") : "none outside its definition"}`);
lines.push("");
lines.push("Note: data files (findings.jsonl, findings.json, *.html, logs, examples,");
lines.push("fixtures, selftest) are bus DATA, not code — excluded from this analysis.");
writeFileSync(OUT + "/dead-code.md", lines.join("\n"));
console.log("d08 wrote dead-code.md");
