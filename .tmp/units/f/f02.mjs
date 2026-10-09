// f02: validate.mjs with a 50MB finding — must not hang (internal 15s budget),
// must exit 0/1 (no crash).
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f02";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const rec = { id: "tb-f02-big", guild: "g11", claim: "x".repeat(25_000_000),
  evidence: "y".repeat(25_000_000), numbers: { n: 1 }, timestamp: new Date().toISOString() };
const f = dir + "/big.json";
writeFileSync(f, JSON.stringify(rec));
console.log("wrote " + (Buffer.byteLength(JSON.stringify(rec)) / 1e6).toFixed(1) + "MB");
const t0 = Date.now();
let code;
try { execFileSync("node", [P + "/telemetry/validate.mjs", f], { stdio: "pipe", timeout: 15000 }); code = 0; }
catch (e) { code = e.status ?? 99; if (String(e.message).includes("ETIMEDOUT")) { console.log("F02 FAIL: hung"); process.exit(1); } }
console.log(`f02: exit=${code} elapsed=${Date.now() - t0}ms`);
if (code !== 0 && code !== 1) { console.log("F02 FAIL: unexpected exit " + code); process.exit(1); }
console.log("F02 PASS");
