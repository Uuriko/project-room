// f11: collect() with a throwing event-loop monitor — must never throw;
// gauge keeps its last value.
import { createTripwires } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/tripwires.mjs";
const throwingMonitor = {
  percentile: () => { throw new Error("perf_hooks exploded"); },
  reset() { throw new Error("reset exploded"); },
  count: 5,
  disable() {},
};
const tw = createTripwires({ eventLoopMonitor: throwingMonitor });
tw.recordWriteLimiterPenalty();
const before = tw.gauge("write_limiter_penalty_entries").value;
try {
  tw.collect({ db: { prepare: () => ({ all: () => [] }) } });
  tw.collect({ db: { prepare: () => ({ all: () => [] }) } });
} catch (e) {
  console.log("F11 FAIL: collect threw: " + e.message);
  process.exit(1);
}
const after = tw.gauge("write_limiter_penalty_entries").value;
if (after !== before) { console.log("F11 FAIL: gauge changed across throwing ticks"); process.exit(1); }
const el = tw.gauge("event_loop_delay_ms_p99");
console.log(`throwing monitor survived; penalty kept at ${after}; event-loop gauge=${el.value}/${el.status}`);
tw.stop();
console.log("F11 PASS");
