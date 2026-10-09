// r02: contract suite re-run — telemetry/tripwire-contract.test.mjs.
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
try {
  const out = execFileSync("node", ["--test", "telemetry/tripwire-contract.test.mjs"],
    { cwd: W, encoding: "utf8", timeout: 60000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
  if (!/ℹ fail 0/.test(out)) { console.log("R02 FAIL"); process.exit(1); }
  console.log("r02: " + (out.match(/ℹ (tests|pass|fail) \d+/g) || []).join(" "));
  console.log("R02 PASS");
} catch (e) { console.log("R02 FAIL: " + String(e.message).slice(0, 300)); process.exit(1); }
