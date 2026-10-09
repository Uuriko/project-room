// f13: gauges.mjs fresh import — all 5 gauges numeric, valid status, and NO
// false trip at boot (gauges never false-critical on boot).
import { gauges } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/telemetry/gauges.mjs";
const names = ["event-budget-low", "write-limiter-penalty-box", "sse-event-loop-saturation",
  "projection-size-growth", "commands-silent-timeout-rate"];
for (const n of names) {
  const g = gauges[n];
  if (typeof g.value !== "number" || Number.isNaN(g.value)) { console.log(`F13 FAIL: ${n} non-numeric value`); process.exit(1); }
  if (typeof g.threshold !== "number") { console.log(`F13 FAIL: ${n} non-numeric threshold`); process.exit(1); }
  if (!["ok", "warn", "trip"].includes(g.status)) { console.log(`F13 FAIL: ${n} bad status ${g.status}`); process.exit(1); }
  if (g.status === "trip") { console.log(`F13 FAIL: ${n} false-critical at boot`); process.exit(1); }
  console.log(`${n}: value=${g.value} threshold=${g.threshold} status=${g.status}`);
}
console.log("F13 PASS");
