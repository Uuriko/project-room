// h-u09: the contract pins threshold = the TRIP threshold (criticalAt).
// Exit 0 = threshold is criticalAt (0.1), 1 = mutant (warnAt 0.2).
import { gauges } from "/home/hatch/workspace/pr-wave1000-guild-11/telemetry/gauges.mjs";
const t = gauges["event-budget-low"].threshold;
console.log("threshold=" + t);
process.exit(t === 0.1 ? 0 : 1);
