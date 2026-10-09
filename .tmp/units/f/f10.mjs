// f10/f11: collect() must NEVER throw — throwing store, throwing monitor,
// monitor whose percentile/reset throw mid-tick. Gauges keep last values.
import { createTripwires } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/tripwires.mjs";
import assert from "node:assert/strict";

const throwingStore = { db: { prepare: () => { throw new Error("db is on fire"); } } };
const throwingMonitor = { percentile: () => { throw new Error("perf_hooks exploded"); },
  reset() { throw new Error("reset exploded"); }, count: 5 };

const tw = createTripwires({ eventLoopMonitor: throwingMonitor });
tw.recordWriteLimiterPenalty(); // set a known gauge value first
const before = tw.gauge("write_limiter_penalty_entries").value;
try {
  tw.collect(throwingStore);
  tw.collect(null);
  tw.collect(undefined);
  tw.collect({});
} catch (e) {
  console.log("F10/F11 FAIL: collect threw: " + e.message);
  process.exit(1);
}
const after = tw.gauge("write_limiter_penalty_entries").value;
assert.equal(after, before, "last values kept");
console.log(`collect survived throwing store+monitor; penalty gauge kept at ${after}`);
tw.stop();
console.log("F10+F11 PASS");
