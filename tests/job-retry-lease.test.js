// A recorded failure used to consume the job's full cadence. Store-growth
// failed at 2026-10-25T03:30:38.927Z, and the 04:00 safety-net cron skipped
// it because lastRunAt + 1h had not elapsed. The first retry is one alarm
// lease. Each further failure doubles that wait, and the wait stops at the
// job's own cadence, so a job that fails every time does not wake every lease.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ALARM_RETRY_MS, DAY_MS, HOUR_MS, MINUTE_MS, jobByName, jobIsDue, nextJobAlarm, startNodeScheduler } from "../server/jobs.mjs";

const FAILED_AT = Date.parse("2026-10-25T03:30:38.927Z");

test("a recorded failure is due after the retry lease, not after the full cadence", () => {
  const backup = jobByName("room-backup");
  const growth = jobByName("store-growth");
  assert.equal(backup.cadenceMs, DAY_MS);
  assert.equal(growth.cadenceMs, HOUR_MS);
  assert.equal(jobIsDue(growth, null, FAILED_AT + ALARM_RETRY_MS - 1, FAILED_AT, growth.cadenceMs, 1), false);
  assert.equal(jobIsDue(growth, null, FAILED_AT + 30 * 60 * 1000, FAILED_AT, growth.cadenceMs, 1), true);
  assert.equal(jobIsDue(growth, null, FAILED_AT + 30 * 60 * 1000, FAILED_AT, growth.cadenceMs, 0), false);
  assert.equal(jobIsDue(backup, null, FAILED_AT + ALARM_RETRY_MS, FAILED_AT, backup.cadenceMs, 1), true);
  assert.equal(jobIsDue(backup, null, FAILED_AT + ALARM_RETRY_MS, FAILED_AT, backup.cadenceMs, 0), false);
});

// Independent of failedJobRetryDelayMs: the delays are the formula, written
// out here, so a change to the helper cannot satisfy itself.
test("failed-job retry delays for failures 1 through 6 match the exponential cap", () => {
  const integrity = jobByName("integrity");
  assert.equal(integrity.cadenceMs, HOUR_MS);
  const minuteJob = { cadenceMs: MINUTE_MS, slow: false };
  for (const failures of [1, 2, 3, 4, 5, 6]) {
    const delay = Math.min(integrity.cadenceMs, ALARM_RETRY_MS * (2 ** (failures - 1)));
    assert.equal(delay, ALARM_RETRY_MS * (2 ** (failures - 1)), `failure ${failures} is still under the hourly cap`);
    assert.equal(jobIsDue(integrity, null, FAILED_AT + delay - 1, FAILED_AT, integrity.cadenceMs, failures), false, `failure ${failures} early`);
    assert.equal(jobIsDue(integrity, null, FAILED_AT + delay, FAILED_AT, integrity.cadenceMs, failures), true, `failure ${failures} due`);
    // A one-minute job is already at its cadence on the first failure, so
    // later failures do not wait longer than that minute.
    assert.equal(jobIsDue(minuteJob, null, FAILED_AT + MINUTE_MS - 1, FAILED_AT, MINUTE_MS, failures), false, `minute job failure ${failures} early`);
    assert.equal(jobIsDue(minuteJob, null, FAILED_AT + MINUTE_MS, FAILED_AT, MINUTE_MS, failures), true, `minute job failure ${failures} due`);
  }
  // The seventh doubling (64 minutes) is past the hour, and a long streak
  // stays there. Prod integrity has been failing since 2026-10-11.
  for (const failures of [7, 285]) {
    assert.equal(jobIsDue(integrity, null, FAILED_AT + HOUR_MS - 1, FAILED_AT, integrity.cadenceMs, failures), false, `failure ${failures} before cadence`);
    assert.equal(jobIsDue(integrity, null, FAILED_AT + HOUR_MS, FAILED_AT, integrity.cadenceMs, failures), true, `failure ${failures} at cadence`);
  }
  const webhook = jobByName("webhook-dispatch");
  assert.equal(typeof webhook.nextDueAt, "function");
  assert.equal(jobIsDue(webhook, null, FAILED_AT + ALARM_RETRY_MS, FAILED_AT, webhook.cadenceMs, 6), false);
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

test("a permanently failing integrity job wakes no more than cadence plus log2 retries in a day", async t => {
  const directory = mkdtempSync(join(tmpdir(), "room-job-backoff-"));
  let clock = FAILED_AT;
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock });
  store.initialize(initialRoom("commons"));
  store.verifyRoomIntegrity = async () => {
    throw new Error("permanent integrity failure");
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

  const ranIntegrity = outcomes => outcomes.some(outcome => outcome.job === "integrity");
  assert.equal(ranIntegrity(await scheduler.runOnce()), true);
  assert.equal(scheduler.jobHealth().find(job => job.name === "integrity").consecutiveFailures, 1);

  const end = clock + DAY_MS;
  let wakes = 0;
  while (clock < end) {
    if (ranIntegrity(await scheduler.runOnce())) wakes += 1;
    clock += ALARM_RETRY_MS;
  }

  const cadence = jobByName("integrity").cadenceMs;
  const cadenceRuns = Math.floor(DAY_MS / cadence);
  // Doublings of the lease that are still shorter than the cadence.
  const log2Terms = Math.ceil(Math.log2(cadence / ALARM_RETRY_MS));
  let expected = 0;
  let cursor = FAILED_AT;
  let last = FAILED_AT;
  let failures = 1;
  while (cursor < end) {
    const delay = Math.min(cadence, ALARM_RETRY_MS * (2 ** (failures - 1)));
    if (last + delay <= cursor) {
      expected += 1;
      last = cursor;
      failures += 1;
    }
    cursor += ALARM_RETRY_MS;
  }
  assert.equal(wakes, expected);
  assert.ok(expected <= cadenceRuns + log2Terms, `${expected} retries, bound ${cadenceRuns + log2Terms}`);
  assert.ok(wakes >= cadenceRuns, `${wakes} retries fell below ${cadenceRuns} cadence runs`);
});
