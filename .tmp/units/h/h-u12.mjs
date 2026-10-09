// h-u12: build-dashboard-data.mjs must THROW on a corrupt JSONL line.
// Exit 0 = threw (correct), 1 = exited 0 (mutant swallowed the error).
import { writeFileSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const W = process.argv[2];
const dir = "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/units/h/h-u12";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
copyFileSync(W + "/telemetry/build-dashboard-data.mjs", dir + "/build-dashboard-data.mjs");
writeFileSync(dir + "/findings.jsonl", '{"id":"a"}\nNOT JSON\n{"id":"b"}\n');
let code;
try { execFileSync("node", [dir + "/build-dashboard-data.mjs"], { stdio: "pipe" }); code = 0; }
catch (e) { code = e.status ?? 2; console.log("threw, exit " + code); }
console.log("exit=" + code);
process.exit(code === 0 ? 1 : 0);
