// f05: collect.mjs hostile events fixture — malformed bodies, giant body,
// non-string body, missing event wrapper, FINDING with broken fence, valid one.
// Must print the summary line, exit 0, and leave findings.jsonl parseable.
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f05";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir + "/telemetry", { recursive: true });
const rec = (id) => ({ id, guild: "g11", claim: "0123456789", evidence: "0123456789abcdef",
  numbers: {}, timestamp: new Date().toISOString() });
const events = { events: [
  { sequence: 1, event: { type: "message", data: { body: null } } },
  { sequence: 2, event: { type: "message", data: { body: 42 } } },
  { sequence: 3, event: { type: "message", data: { body: "FINDING\nno fence here" } } },
  { sequence: 4, event: { type: "message", data: { body: "FINDING\n```json\n{broken\n```" } } },
  { sequence: 5, event: { type: "message", data: { body: "FINDING\n```json\n" + JSON.stringify({ ...rec("tb-f05-bad"), claim: "short" }) + "\n```" } } },
  { sequence: 6, event: { type: "message", data: { body: "FINDING\n```json\n" + JSON.stringify(rec("tb-f05-ok")) + "\n```" } } },
  { sequence: 7, event: { type: "message", data: { body: "FINDING\n" + "z".repeat(10_000_000) } } },
  { sequence: 8, nope: true },
  { sequence: 9 },
  { sequence: 10, event: { type: "message", data: { body: "FINDING\r\n```json\r\n" + JSON.stringify(rec("tb-f05-cr")) + "\r\n```" } } },
] };
writeFileSync(dir + "/events.json", JSON.stringify(events));
let out;
try {
  out = execFileSync("node", [P + "/telemetry/collect.mjs", "--events", dir + "/events.json"],
    { cwd: dir, encoding: "utf8", timeout: 15000 });
} catch (e) { console.log("F05 FAIL: collect crashed: " + String(e.message).slice(0, 200)); process.exit(1); }
console.log("summary: " + out.trim());
const lines = readFileSync(dir + "/telemetry/findings.jsonl", "utf8").split("\n").filter(l => l.trim());
for (const [i, l] of lines.entries()) { try { JSON.parse(l); } catch { console.log(`F05 FAIL: findings.jsonl line ${i} corrupt`); process.exit(1); } }
const ids = lines.map(l => JSON.parse(l).id).sort();
console.log("collected ids: " + ids.join(","));
if (ids.join(",") !== "tb-f05-cr,tb-f05-ok") { console.log("F05 FAIL: unexpected collected set"); process.exit(1); }
console.log("F05 PASS");
