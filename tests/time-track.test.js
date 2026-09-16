// K003: estimates + time tracking. Pure tracker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createTimeTracker, TimeTrackError } from "../server/time-track.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof TimeTrackError && error.code === code);

test("estimate, start, stop, and summary", () => {
  const tracker = createTimeTracker();
  tracker.setEstimate("w1", 60);
  tracker.start("w1", { now: 0, note: "coding" });
  const entry = tracker.stop("w1", { now: 1800000 }); // 30 min
  assert.equal(entry.minutes, 30);
  assert.equal(entry.note, "coding");
  const summary = tracker.summary("w1");
  assert.deepEqual([summary.estimateMin, summary.actualMin, summary.entryCount],
    [60, 30, 1]);
  assert.equal(summary.overEstimate, false);
  assert.ok(Object.isFrozen(entry) && Object.isFrozen(summary));
});
test("over-estimate flag and rollup", () => {
  const tracker = createTimeTracker();
  tracker.setEstimate("w1", 10);
  tracker.start("w1", { now: 0 });
  tracker.stop("w1", { now: 1200000 }); // 20 min > 10 estimate
  assert.equal(tracker.summary("w1").overEstimate, true);
  tracker.setEstimate("w2", 30);
  const rollup = tracker.rollup();
  assert.deepEqual([rollup.items, rollup.estimatedMin, rollup.actualMin], [2, 40, 20]);
});
test("malformed inputs are refused", () => {
  const tracker = createTimeTracker();
  throwsCode(() => tracker.setEstimate("w1", -5), "invalid_time_track");
  throwsCode(() => tracker.start("ghost", { now: 0 }), "invalid_time_track");
  tracker.setEstimate("w1", 60);
  tracker.start("w1", { now: 0 });
  throwsCode(() => tracker.start("w1", { now: 1000 }), "invalid_time_track"); // already running
  throwsCode(() => tracker.stop("w1", { now: -1000 }), "invalid_time_track"); // before start
});
