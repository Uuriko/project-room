// r01: full affected suite, unmutated — tests/tripwires.test.mjs (re-run for
// the verification record).
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
try {
  const out = execFileSync("node", ["--test", "tests/tripwires.test.mjs"],
    { cwd: W, encoding: "utf8", timeout: 180000, env: { ...process.env, TMPDIR: W + "/.tmp" } });
  const m = out.match(/ℹ (pass|fail) (\d+)/g);
  console.log("r01: " + (m ? m.join(" ") : "no summary"));
  if (!/ℹ fail 0/.test(out)) { console.log("R01 FAIL"); process.exit(1); }
  console.log("R01 PASS");
} catch (e) {
  console.log("R01 FAIL: " + String(e.message).slice(0, 300));
  process.exit(1);
}
