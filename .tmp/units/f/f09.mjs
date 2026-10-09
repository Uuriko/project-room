// f09: pruneWindows with a 500k-entry penalty backlog — must prune in a
// bounded tick (15s budget), gauge decays to 0.
import { createTripwires, PENALTY_WINDOW_MS } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/tripwires.mjs";
let t = 1_000_000;
const tw = createTripwires({ now: () => t, eventLoopMonitor: null });
for (let i = 0; i < 500_000; i++) tw.recordWriteLimiterPenalty(t);
console.log("seeded 500k entries, gauge=" + tw.gauge("write_limiter_penalty_entries").value);
t += PENALTY_WINDOW_MS + 1;
const t0 = Date.now();
tw.collect({ db: { prepare: () => ({ all: () => [] }) } });
const el = Date.now() - t0;
const g = tw.gauge("write_limiter_penalty_entries");
console.log(`f09: prune tick ${el}ms; gauge=${g.value}/${g.status}`);
tw.stop();
if (el > 15000) { console.log("F09 FAIL: prune too slow"); process.exit(1); }
if (g.value !== 0 || g.status !== "ok") { console.log("F09 FAIL: gauge did not decay"); process.exit(1); }
console.log("F09 PASS");
