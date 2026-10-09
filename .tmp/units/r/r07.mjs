// r07: adversarial review of the a61e07c29 p99 fix. Extract the PRE-FIX
// server/tripwires.mjs, run the two repros against old vs new:
// (a) real-sample tick: percentile=250_000_000ns count=1 -> old stored
//     250000000 "ms" (absurd), new stores 250ms.
// (b) empty histogram: percentile=511 count=0 -> old stored 511 (ms!),
//     new keeps neutral 0.
// The fix holds iff new behaves correctly on both.
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
const W = "/home/hatch/workspace/pr-wave1000-guild-11";
const dir = W + "/.tmp/units/r/r07";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
execSync(`git -C ${W} show a61e07c29^:server/tripwires.mjs > ${dir}/tripwires-old.mjs`);
copyFileSync(W + "/server/tripwires.mjs", dir + "/tripwires-new.mjs");
const repro = (mod) => `
import { createTripwires } from "${dir}/${mod}.mjs";
const fake = (p99ns, count) => ({ percentile: () => p99ns, count, reset() {}, disable() {} });
const store = { db: { prepare: () => ({ all: () => [] }) } };
const a = createTripwires({ eventLoopMonitor: fake(250_000_000, 1) });
a.collect(store);
const v1 = a.gauge("event_loop_delay_ms_p99").value; a.stop();
const b = createTripwires({ eventLoopMonitor: fake(511, 0) });
b.collect(store);
const v2 = b.gauge("event_loop_delay_ms_p99").value; b.stop();
console.log(JSON.stringify({ realSample: v1, emptyHistogram: v2 }));
`;
writeFileSync(dir + "/repro-old.mjs", repro("tripwires-old"));
writeFileSync(dir + "/repro-new.mjs", repro("tripwires-new"));
const oldR = JSON.parse(execFileSync("node", [dir + "/repro-old.mjs"], { encoding: "utf8" }));
const newR = JSON.parse(execFileSync("node", [dir + "/repro-new.mjs"], { encoding: "utf8" }));
console.log("pre-fix : " + JSON.stringify(oldR));
console.log("post-fix: " + JSON.stringify(newR));
let ok = true;
if (!(oldR.realSample === 250_000_000)) { console.log("r07 note: pre-fix real-sample was not the raw-ns bug"); ok = false; }
if (!(newR.realSample === 250)) { console.log("R07 FAIL: fix does not convert ns->ms"); ok = false; }
if (!(oldR.emptyHistogram === 511)) { console.log("r07 note: pre-fix empty-histogram was not 511"); ok = false; }
if (!(newR.emptyHistogram === 0)) { console.log("R07 FAIL: fix does not ignore empty histograms"); ok = false; }
if (!ok) process.exit(1);
console.log("R07 PASS: a61e07c29 fix holds on both repros");
