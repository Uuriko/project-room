// h-u11: collect.mjs must ignore bodies WITHOUT the FINDING prefix gate.
// Exit 0 = ignored (correct), 1 = collected (mutant dropped the gate).
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = process.argv[2];
const dir = "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/units/h/h-u11";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + "/telemetry", { recursive: true });
const rec = { id: "tb-harness-0011", guild: "g11", claim: "0123456789",
  evidence: "0123456789abcdef", numbers: {}, timestamp: new Date().toISOString() };
const events = { events: [{ sequence: 1, event: { type: "message",
  data: { body: "here is a finding:\n```json\n" + JSON.stringify(rec) + "\n```" } } }] };
writeFileSync(dir + "/events.json", JSON.stringify(events));
let out;
try {
  out = execFileSync("node", [W + "/telemetry/collect.mjs", "--events", dir + "/events.json"],
    { cwd: dir, encoding: "utf8" });
} catch (e) { console.log("collect crashed: " + e.message); process.exit(2); }
console.log(out.trim());
process.exit(out.includes("collected 1 new") ? 1 : 0);
