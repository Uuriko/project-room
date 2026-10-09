// r10: boot gauge sanity with the REAL event-loop monitor (default lazy
// resolution) — fresh process, gauges must be numeric and never trip at boot.
import { gauges } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/telemetry/gauges.mjs";
import { tripwires } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/telemetry/gauges.mjs";
const names = Object.keys(gauges);
console.log("gauges: " + names.join(","));
if (names.length !== 5) { console.log("R10 FAIL: expected 5 gauges"); process.exit(1); }
for (const n of names) {
  const g = gauges[n];
  if (typeof g.value !== "number" || Number.isNaN(g.value)) { console.log(`R10 FAIL: ${n} bad value`); process.exit(1); }
  if (g.status === "trip") { console.log(`R10 FAIL: ${n} false-critical at boot`); process.exit(1); }
  console.log(`${n}: ${g.value} [${g.status}]`);
}
tripwires.stop();
console.log("R10 PASS");
