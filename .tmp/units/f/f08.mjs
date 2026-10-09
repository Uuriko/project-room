// f08: threshold edge cases — exactly-at-threshold behavior for every gauge,
// compared against the documented contract (strict by default; inclusive only
// for the penalty gauge).
import { gaugeStatus } from "/home/hatch/workspace/pr-wave1000-guild-11/.tmp/pristine/server/tripwires.mjs";
import assert from "node:assert/strict";
const cases = [
  // [def, value, expected, note]
  [{ direction: "high", warnAt: 50, criticalAt: 200 }, 50, "ok", "event-loop p99 exactly at warn (exclusive)"],
  [{ direction: "high", warnAt: 50, criticalAt: 200 }, 200, "warn", "event-loop p99 exactly at critical (exclusive)"],
  [{ direction: "high", warnAt: 0.7, criticalAt: 0.9 }, 0.7, "ok", "projection exactly at warn (exclusive)"],
  [{ direction: "high", warnAt: 0.7, criticalAt: 0.9 }, 0.9, "warn", "projection exactly at critical (exclusive)"],
  [{ direction: "high", warnAt: 0.1, criticalAt: 0.3 }, 0.1, "ok", "timeout ratio exactly at warn (exclusive)"],
  [{ direction: "high", warnAt: 0.1, criticalAt: 0.3 }, 0.3, "warn", "timeout ratio exactly at critical (exclusive)"],
  [{ direction: "low", warnAt: 0.2, criticalAt: 0.1 }, 0.2, "ok", "budget exactly at warn (exclusive)"],
  [{ direction: "low", warnAt: 0.2, criticalAt: 0.1 }, 0.1, "warn", "budget exactly at critical (exclusive)"],
  [{ direction: "high", warnAt: 5, criticalAt: 20, inclusive: true }, 5, "warn", "penalty exactly at 5 (inclusive)"],
  [{ direction: "high", warnAt: 5, criticalAt: 20, inclusive: true }, 20, "critical", "penalty exactly at 20 (inclusive)"],
  [{ direction: "high", warnAt: 5, criticalAt: 20, inclusive: true }, 4.999, "ok", "penalty just under 5"],
  [{ direction: "high", warnAt: 1, criticalAt: 2 }, Infinity, "critical", "Infinity trips"],
  [{ direction: "high", warnAt: 1, criticalAt: 2 }, -Infinity, "ok", "-Infinity is ok (high-is-bad)"],
  [{ direction: "high", warnAt: 1, criticalAt: 2 }, undefined, "unknown", "undefined is unknown"],
  [{ direction: "high", warnAt: 1, criticalAt: 2 }, "3", "unknown", "string is unknown, never coerced"],
];
for (const [def, v, want, note] of cases) {
  const got = gaugeStatus(def, v);
  assert.equal(got, want, `${note}: got ${got}, want ${want}`);
  console.log(`ok: ${note} -> ${got}`);
}
console.log("F08 PASS");
