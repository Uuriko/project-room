// A recorded failure used to consume the job's full cadence. Store-growth
// failed at 2026-10-25T03:30:38.927Z, and the 04:00 safety-net cron skipped
// it because lastRunAt + 1h had not elapsed. The retry lease is one alarm
// period, so the next tick after that cap runs the job again.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ALARM_RETRY_MS, DAY_MS, HOUR_MS, jobByName, jobIsDue, nextJobAlarm, startNodeScheduler } from "../server/jobs.mjs";

const FAILED_AT = Date.parse("2026-10-25T03:30:38.927Z");

test("a recorded failure is due after the retry lease, not after the full cadence", () => {
  const backup = jobByName("room-backup");
  const growth = jobByName("store-growth");
  assert.equal(backup.cadenceMs, DAY_MS);
  assert.equal(growth.cadenceMs, HOUR_MS);
  assert.equal(jobIsDue(growth, null, FAILED_AT + ALARM_RETRY_MS - 1, FAILED_AT, growth.cadenceMs, true), false);
  assert.equal(jobIsDue(growth, null, FAILED_AT + 30 * 60 * 1000, FAILED_AT, growth.cadenceMs, true), true);
  assert.equal(jobIsDue(growth, null, FAILED_AT + 30 * 60 * 1000, FAILED_AT, growth.cadenceMs, false), false);
  assert.equal(jobIsDue(backup, null, FAILED_AT + ALARM_RETRY_MS, FAILED_AT, backup.cadenceMs, true), true);
  assert.equal(jobIsDue(backup, null, FAILED_AT + ALARM_RETRY_MS, FAILED_AT, backup.cadenceMs, false), false);
});

test("an alarm already in the past is replaced; a sooner future alarm is kept", () => {
  const now = FAILED_AT;
  const candidate = now + HOUR_MS;
  assert.equal(nextJobAlarm(now - 120_000, candidate, now), candidate);
  assert.equal(nextJobAlarm(now + 60_000, candidate, now), now + 60_000);
  assert.equal(nextJobAlarm(now + HOUR_MS + 1, candidate, now), candidate);
  assert.equal(nextJobAlarm(now - 120_000, null, now), null);
  assert.equal(nextJobAlarm(null, candidate, now), candidate);
});

test("a failed store-growth tick resumes on the next tick after the lease and then succeeds", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-job-retry-"));
  let clock = FAILED_AT;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom("commons"));
  let faults = 1;
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    if (faults > 0 && String(sql).includes("MAX(LENGTH(projection))")) {
      faults -= 1;
      throw new Error("store growth read failed");
    }
    return prepare(sql);
  };
  const scheduler = startNodeScheduler({
    store,
    env: { GROWTH_WATCH_INTERVAL_MS: "0" },
    tickMs: 0,
    now: () => clock
  });
  t.after(() => {
    scheduler.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const growthOf = outcomes => outcomes.find(outcome => outcome.job === "store-growth");
  const healthOf = () => scheduler.jobHealth().find(job => job.name === "store-growth");

  const failed = growthOf(await scheduler.runOnce());
  assert.equal(failed?.ok, false);
  assert.equal(healthOf().consecutiveFailures, 1);

  assert.equal(growthOf(await scheduler.runOnce()), undefined);

  clock += ALARM_RETRY_MS - 1;
  assert.equal(growthOf(await scheduler.runOnce()), undefined);

  clock += 1;
  const recovered = growthOf(await scheduler.runOnce());
  assert.equal(recovered?.ok, true);
  const health = healthOf();
  assert.equal(health.consecutiveFailures, 0);
  assert.equal(health.lastSuccessAt, new Date(clock).toISOString());

  clock += ALARM_RETRY_MS;
  assert.equal(growthOf(await scheduler.runOnce()), undefined);
});
