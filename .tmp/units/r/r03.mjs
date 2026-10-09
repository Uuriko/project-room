// r03: telemetry/verify.mjs full mode (A-F) on the worktree.
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
try {
  const out = execFileSync("node", ["telemetry/verify.mjs"],
    { cwd: W, encoding: "utf8", timeout: 60000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
  console.log(out.trim().split("\n").slice(-3).join("\n"));
  if (!/VERIFY: 6\/6 checks passed/.test(out)) { console.log("R03 FAIL"); process.exit(1); }
  console.log("R03 PASS");
} catch (e) { console.log("R03 FAIL: " + String(e.message).slice(0, 300)); process.exit(1); }
