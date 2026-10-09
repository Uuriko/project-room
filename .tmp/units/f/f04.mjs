// f04: build-dashboard-data.mjs with 100k valid lines — load test, 30s budget.
import { writeFileSync, mkdirSync, rmSync, copyFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f04";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
copyFileSync(P + "/telemetry/build-dashboard-data.mjs", dir + "/build.mjs");
const N = 100_000;
const lines = [];
for (let i = 0; i < N; i++) lines.push(JSON.stringify({ id: `tb-f04-${i}`, guild: "g", claim: "0123456789", numbers: { n: i } }));
writeFileSync(dir + "/findings.jsonl", lines.join("\n") + "\n");
const t0 = Date.now();
try { execFileSync("node", [dir + "/build.mjs"], { stdio: "pipe", timeout: 30000 }); }
catch (e) { console.log("F04 FAIL: " + e.message.slice(0, 200)); process.exit(1); }
const el = Date.now() - t0;
const size = statSync(dir + "/findings.json").size;
console.log(`f04: ${N} lines in ${el}ms, findings.json ${(size / 1e6).toFixed(1)}MB`);
console.log("F04 PASS");
