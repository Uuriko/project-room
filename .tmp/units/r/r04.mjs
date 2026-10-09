// r04: plugin-store delivery suite re-run — tests/webhook-delivery-load.test.js.
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
try {
  const out = execFileSync("node", ["--test", "tests/webhook-delivery-load.test.js"],
    { cwd: W, encoding: "utf8", timeout: 300000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
  if (!/ℹ fail 0/.test(out)) { console.log("R04 FAIL"); process.exit(1); }
  console.log("r04: " + (out.match(/ℹ (tests|pass|fail) \d+/g) || []).join(" "));
  console.log("R04 PASS");
} catch (e) { console.log("R04 FAIL: " + String(e.message).slice(0, 300)); process.exit(1); }
