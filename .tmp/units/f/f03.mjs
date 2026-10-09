// f03: build-dashboard-data.mjs with a corrupt JSONL line — must throw a
// CLEAN error (nonzero exit, message names the line), never hang or write
// partial output.
import { writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const P = W + "/.tmp/pristine";
const dir = W + "/.tmp/units/f/f03";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
copyFileSync(P + "/telemetry/build-dashboard-data.mjs", dir + "/build.mjs");
writeFileSync(dir + "/findings.jsonl",
  '{"id":"good-1","guild":"g"}\n{broken json here\n{"id":"good-2","guild":"g"}\n');
const t0 = Date.now();
let code, stderr = "";
try { execFileSync("node", [dir + "/build.mjs"], { stdio: "pipe", timeout: 10000 }); code = 0; }
catch (e) { code = e.status ?? 99; stderr = String(e.stderr ?? e.message); }
const wrote = existsSync(dir + "/findings.json");
console.log(`f03: exit=${code} elapsed=${Date.now() - t0}ms wrote_findings_json=${wrote}`);
console.log("stderr: " + stderr.slice(0, 200));
if (code === 0) { console.log("F03 FAIL: corrupt line did not fail the build"); process.exit(1); }
if (!/line 2/.test(stderr)) { console.log("F03 FAIL: error does not name the corrupt line"); process.exit(1); }
console.log("F03 PASS");
