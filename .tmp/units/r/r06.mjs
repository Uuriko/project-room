// r06: remaining plugin-store-adjacent suites.
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const files = ["tests/agent-plugin-webhook-subs.test.js", "tests/agent-plugin-loop.test.js",
  "tests/agent-plugin-manifest.test.js", "tests/agent-plugin-api-keys.test.js",
  "tests/agent-plugin-directory.test.js", "tests/agent-plugin-sentinel-secrets.test.js",
  "tests/claude-plugin.test.js"];
let tot = 0, bad = [];
for (const f of files) {
  try {
    const out = execFileSync("node", ["--test", f],
      { cwd: W, encoding: "utf8", timeout: 300000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
    const m = out.match(/ℹ tests (\d+)/);
    tot += m ? Number(m[1]) : 0;
    if (!/ℹ fail 0/.test(out)) bad.push(f);
    console.log(`r06 ${f}: ${m ? m[1] : "?"} tests, ${/ℹ fail 0/.test(out) ? "green" : "RED"}`);
  } catch (e) { bad.push(f); console.log(`r06 ${f}: CRASH ${String(e.message).slice(0, 120)}`); }
}
console.log(`r06: ${tot} tests across ${files.length} files`);
if (bad.length) { console.log("R06 FAIL: " + bad.join(",")); process.exit(1); }
console.log("R06 PASS");
