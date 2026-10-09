// f06: collect.mjs duplicate ids — same finding twice + rerun idempotency.
// Expect "collected 1 new, skipped 1 dupes" then "collected 0 new, skipped 1 dupes".
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f06";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + "/telemetry", { recursive: true });
const rec = { id: "tb-f06-dupe", guild: "g11", claim: "0123456789",
  evidence: "0123456789abcdef", numbers: {}, timestamp: new Date().toISOString() };
const body = "FINDING\n```json\n" + JSON.stringify(rec) + "\n```";
const events = { events: [
  { sequence: 1, event: { type: "m", data: { body } } },
  { sequence: 2, event: { type: "m", data: { body } } },
] };
writeFileSync(dir + "/events.json", JSON.stringify(events));
const run = () => execFileSync("node", [P + "/telemetry/collect.mjs", "--events", dir + "/events.json"],
  { cwd: dir, encoding: "utf8", timeout: 10000 }).trim();
const a = run(), b = run();
console.log("run1: " + a + " | run2: " + b);
if (a !== "collected 1 new, skipped 1 dupes, rejected 0 invalid") { console.log("F06 FAIL: run1"); process.exit(1); }
if (b !== "collected 0 new, skipped 2 dupes, rejected 0 invalid") { console.log("F06 FAIL: run2 not idempotent"); process.exit(1); }
console.log("F06 PASS");
