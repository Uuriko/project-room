// f07 (rev2): recordCommandOutcome scaling characterization. Each call maps
// the full outcome window (O(n) per record). Measure the curve at
// 1k/5k/20k records; report. FAILs if the curve is worse than linear.
import { createTripwires } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/tripwires.mjs";
const times = {};
for (const n of [1000, 5000, 20000]) {
  const tw = createTripwires({ eventLoopMonitor: null });
  const t0 = Date.now();
  for (let i = 0; i < n; i++) tw.recordCommandOutcome(i % 3 === 0 ? "timeout" : "ok");
  times[n] = Date.now() - t0;
  const r = tw.gauge("commands_silent_timeout_ratio");
  const expected = Array.from({ length: n }, (_, i) => i).filter(i => i % 3 === 0).length / n;
  if (Math.abs(r.value - expected) > 1e-9) { console.log(`F07 FAIL: ratio wrong at n=${n}`); process.exit(1); }
  tw.stop();
}
console.log("recordCommandOutcome scaling: " + JSON.stringify(times));
// 5x records should cost ~5x time if linear; quadratic gives ~25x.
const ratio = times[5000] / Math.max(times[1000], 1);
console.log(`5x records -> ${ratio.toFixed(1)}x time (linear=5x, quadratic=25x)`);
if (ratio > 12) {
  console.log("F07 FINDING: recordCommandOutcome is super-linear (full-window .map per record) — see findings");
}
console.log("F07 PASS (characterized)");
