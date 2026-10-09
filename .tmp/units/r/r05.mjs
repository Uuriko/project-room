// r05: agent-plugin HTTP suite re-run — tests/agent-plugin-http.test.js.
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
try {
  const out = execFileSync("node", ["--test", "tests/agent-plugin-http.test.js"],
    { cwd: W, encoding: "utf8", timeout: 300000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
  if (!/ℹ fail 0/.test(out)) { console.log("R05 FAIL"); process.exit(1); }
  console.log("r05: " + (out.match(/ℹ (tests|pass|fail) \d+/g) || []).join(" "));
  console.log("R05 PASS");
} catch (e) { console.log("R05 FAIL: " + String(e.message).slice(0, 300)); process.exit(1); }
