// h-u08: drives the write-limiter penalty gauge to critical; asserts the
// contract mapping critical -> "trip". Exit 0 = original behavior, 1 = mutant.
import { tripwires, gauges } from "/home/hatch/workspace/pr-wave1000-guild-11/telemetry/gauges.mjs";
for (let i = 0; i < 20; i++) tripwires.recordWriteLimiterPenalty();
const s = gauges["write-limiter-penalty-box"].status;
console.log("status=" + s);
process.exit(s === "trip" ? 0 : 1);
