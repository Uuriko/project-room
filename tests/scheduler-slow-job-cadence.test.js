// Companion to scheduler-slow-job-slack.test.js: the slow jobs' real
// registry entries under a day of jittered */30 safety-net passes. Prod
// (2026-10-17, deploy 55): integrity and retention ran at 10:30:35.702Z and
// the 11:30 pass skipped them, because that pass started a moment before
// lastRunAt + 1h.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobByName, jobIsDue, HOUR_MS, DAY_MS, SAFETY_NET_MS } from "../server/jobs.mjs";

const T = Date.parse("2026-10-17T10:30:35.702Z");
// Pass start = slot + the same offset, +/- up to 20 s of deterministic jitter.
const jitter = i => ((i * 7919) % 41) * 1000 - 20_000;

function simulate(job, passes) {
  let last = T, runs = 0, previousRan = false, back2back = 0;
  for (let i = 1; i <= passes; i++) {
    const at = T + i * SAFETY_NET_MS + jitter(i);
    const ran = jobIsDue(job, null, at, last);
    if (ran) { if (previousRan) back2back += 1; last = at; runs += 1; }
    previousRan = ran;
  }
  return { runs, back2back };
}

test("hourly slow jobs run once per hour across a day of jittered cron passes", () => {
  for (const name of ["integrity", "retention"]) {
    const job = jobByName(name);
    assert.equal(job.slow, true);
    assert.equal(job.cadenceMs, HOUR_MS);
    const { runs, back2back } = simulate(job, 48);
    assert.equal(runs, 24, `${name}: 24 runs in 24 h`);
    assert.equal(back2back, 0, `${name}: never in two consecutive passes`);
  }
});

test("the daily backup runs once per day across two days of passes", () => {
  const job = jobByName("room-backup");
  assert.equal(job.cadenceMs, DAY_MS);
  assert.equal(simulate(job, 96).runs, 2);
});
