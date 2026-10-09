// f15: submit.mjs happy path in scratch cwd — writes one JSONL line with a
// tb- id; the line must PASS validate.mjs.
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f15";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + "/telemetry", { recursive: true });
const id = execFileSync("node", [P + "/telemetry/submit.mjs",
  "--guild", "g11", "--claim", "f15 happy path claim here",
  "--evidence", "f15 evidence with enough length",
  "--numbers", '{"k":1}', "--category", "correctness", "--confidence", "high",
  "--agent", "fuzz-15", "--room-seq", "42"],
  { cwd: dir, encoding: "utf8", timeout: 10000 }).trim();
console.log("submit id: " + id);
if (!/^tb-[0-9]{14}-[0-9a-f]{4}$/.test(id)) { console.log("F15 FAIL: bad id shape"); process.exit(1); }
const lines = readFileSync(dir + "/telemetry/findings.jsonl", "utf8").split("\n").filter(l => l.trim());
if (lines.length !== 1) { console.log("F15 FAIL: expected 1 line"); process.exit(1); }
const rec = JSON.parse(lines[0]);
if (rec.id !== id || rec.roomSeq !== 42 || rec.agent !== "fuzz-15") { console.log("F15 FAIL: record mismatch"); process.exit(1); }
const vf = dir + "/rec.json";
import("node:fs").then(({ writeFileSync }) => {
  writeFileSync(vf, lines[0]);
  try { execFileSync("node", [P + "/telemetry/validate.mjs", vf], { stdio: "pipe", timeout: 10000 }); }
  catch (e) { console.log("F15 FAIL: validate rejected the submitted record"); process.exit(1); }
  console.log("F15 PASS");
});
