// d10: findings/guild-11 README index.
import { writeFileSync, existsSync, readdirSync } from "node:fs";
const OUT = process.argv[2];
const docs = existsSync(OUT + "/docs") ? readdirSync(OUT + "/docs").sort() : [];
writeFileSync(OUT + "/README.md", `# wave1000 guild-11 (telemetry) — findings

Static slice: \`telemetry/\`, \`server/tripwires.mjs\`, \`server/agent-plugin-store.mjs\`.
Branch: \`wave1000/guild-11\` (reset onto \`wave300/telemetry-prod\`, the only
ref carrying the slice — origin/main has no telemetry/ or tripwires.mjs).

## Work program (50 units)

- MUTATION (u01–u15): 15 mutants, file-locked, suite per mutant.
- FUZZ + LOAD (f01–f15): hostile inputs, oversized payloads, gauge spam,
  threshold edges, concurrent wake deliveries — all against a pristine snapshot.
- RE-VERIFY (r01–r10): full affected suites unmutated, adversarial review of
  the a61e07c29 p99 fix, scratch rebase of the slice onto origin/main,
  endpoint 4xx-never-500, boot gauge sanity.
- DOCS (d01–d10): module docs + this index.

## Files

- \`mutants.md\` — mutation scoreboard + test gaps.
- \`dead-code.md\` — reachability analysis.
- \`docs/\` — per-module documentation:
${docs.map(d => `  - ${d}`).join("\n")}

## Headline results

- Mutants: see mutants.md (0 bugs confirmed — all survivors were test gaps).
- Fuzz: 15/15 units assert no-crash / no-hang / 4xx-never-500.
- Re-verify: affected suites green; a61e07c29 fix holds on both repros.
- No room posts from work units (charter + rollup only, per mission).
`);
console.log("d10 wrote README.md");
