// h-u10: validate.mjs must reject a 7-char claim (< 10). Exit 0 = rejected
// (correct), 1 = passed (mutant weakened the floor).
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = process.argv[2];
const finding = { id: "tb-harness-0001", guild: "g11", claim: "1234567",
  evidence: "0123456789abcdef", numbers: { n: 1 }, timestamp: new Date().toISOString() };
const f = "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/units/h/h-u10-finding.json";
writeFileSync(f, JSON.stringify(finding));
try {
  execFileSync("node", [W + "/telemetry/validate.mjs", f], { stdio: "pipe" });
  console.log("validate PASSED the 7-char claim (mutant behavior)");
  process.exit(1);
} catch {
  console.log("validate REJECTED the 7-char claim (correct)");
  process.exit(0);
}
