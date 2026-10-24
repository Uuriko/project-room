// A stalled room keeps its last progress in the watchdog's own SQLite.
// The next plan re-arms that subject. A queue row left "started" when the
// object died is still there for the following slice.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  WATCHDOG_STALL_MS, jobWatchdogEnabled, markRebooted, planWatchdogReboots,
  readWatchdogHealth, recordWatchdogBeat
} from "../server/job-watchdog-store.mjs";
import { DURABLE_ALARM_LEASE_MS, claimDueAlarm, checkpointDurableAlarm, enqueueDurableAlarm, runDurableAlarmSlice } from "../server/durable-alarm-queue.mjs";

const NOW = 1_700_000_000_000;

function open() {
  return new DatabaseSync(":memory:");
}

function beat(db, progressAt, extra = {}, now = progressAt) {
  recordWatchdogBeat(db, {
    objectName: "invite-only-pilot",
    progressAt,
    alarmAt: extra.alarmAt === undefined ? progressAt + 30_000 : extra.alarmAt,
    snapshot: extra.snapshot ?? { schema: "room.job-health/1", status: "ok", jobs: [{ name: "retention", status: "ok" }] },
    receipt: extra.receipt ?? null,
    history: extra.history
  }, now);
}

test("a fresh beat is not a reboot, and a future alarm is left alone", () => {
  const db = open();
  beat(db, NOW);
  assert.deepEqual(planWatchdogReboots(db, NOW), []);
  beat(db, NOW - WATCHDOG_STALL_MS - 1, { alarmAt: NOW + 60_000 });
  assert.deepEqual(planWatchdogReboots(db, NOW), []);
});

test("a stalled subject with a due alarm is rebooted once per stall", () => {
  const db = open();
  beat(db, NOW - WATCHDOG_STALL_MS - 1, { alarmAt: NOW - 1 });
  assert.deepEqual(planWatchdogReboots(db, NOW), ["invite-only-pilot"]);
  markRebooted(db, "invite-only-pilot", NOW);
  assert.deepEqual(planWatchdogReboots(db, NOW), []);
  assert.deepEqual(planWatchdogReboots(db, NOW + WATCHDOG_STALL_MS + 1), ["invite-only-pilot"]);
  beat(db, NOW + WATCHDOG_STALL_MS + 1);
  assert.deepEqual(planWatchdogReboots(db, NOW + WATCHDOG_STALL_MS + 1), []);
  assert.equal(db.prepare("SELECT reboot_count FROM watchdog_subjects").get().reboot_count, 1);
});

test("another object name is refused", () => {
  const db = open();
  assert.throws(() => recordWatchdogBeat(db, { objectName: "other-room", progressAt: NOW }, NOW), /unknown watchdog subject/);
});

test("receipts stay at the last twenty and a record id drops the snapshot", () => {
  const db = open();
  for (let i = 0; i < 25; i += 1) {
    beat(db, NOW + i, { receipt: { job: "retention", at: NOW + i, ok: i % 2 === 0, attempt: i } });
  }
  const health = readWatchdogHealth(db, NOW + 24);
  assert.equal(health.watchdog.receipts.length, 20);
  assert.equal(health.watchdog.receipts[0].attempt, 5);
  assert.equal(health.watchdog.receipts.at(-1).attempt, 24);
  beat(db, NOW + 25, { snapshot: { status: "ok", jobs: [{ name: "integrity", recordId: "room-1" }] } });
  assert.equal(db.prepare("SELECT jobs_json FROM watchdog_subjects").get().jobs_json, "{}");
  const hidden = readWatchdogHealth(db, NOW + 25);
  assert.equal(JSON.stringify(hidden).includes("room-1"), false);
  assert.equal(hidden.watchdog.receipts.length, 20);
});

test("a stalled ok snapshot reads as stale and stays readable", () => {
  const db = open();
  beat(db, NOW, {
    snapshot: {
      schema: "room.job-health/1",
      status: "ok",
      jobs: [
        { name: "retention", status: "ok" },
        { name: "patrol", status: "disabled" },
        { name: "integrity", status: "failing" }
      ]
    },
    receipt: { job: "retention", at: NOW, ok: true, attempt: 1 }
  });
  const later = NOW + WATCHDOG_STALL_MS + 1;
  const health = readWatchdogHealth(db, later);
  assert.equal(health.status, "stale");
  assert.equal(health.source, "watchdog");
  assert.equal(health.watchdog.stalled, true);
  assert.equal(health.jobs.find(job => job.name === "retention").status, "stale");
  assert.equal(health.jobs.find(job => job.name === "patrol").status, "disabled");
  assert.equal(health.jobs.find(job => job.name === "integrity").status, "failing");
  assert.equal(health.watchdog.receipts[0].job, "retention");
  assert.equal(readWatchdogHealth(open(), NOW).status, "unavailable");
});

test("history numbers survive a later beat and a room id does not", () => {
  const db = open();
  beat(db, NOW, { history: { rooms: 2, events: 9, historyBytes: 400, largestProjectionBytes: 40, roomsAtCap: 0, roomId: "commons" } });
  beat(db, NOW + 1, { history: null });
  const kept = readWatchdogHealth(db, NOW + 1);
  assert.equal(kept.watchdog.history.historyBytes, 400);
  assert.equal(JSON.stringify(kept).includes("commons"), false);
  beat(db, NOW + 2, { history: { rooms: 3, roomId: "commons" } });
  const next = readWatchdogHealth(db, NOW + 2);
  assert.equal(next.watchdog.history.rooms, 3);
  assert.equal(next.watchdog.history.historyBytes, undefined);
  assert.equal(JSON.stringify(next).includes("commons"), false);
});

test("the watchdog flag is exact and unset in wrangler", () => {
  assert.equal(jobWatchdogEnabled({}), false);
  assert.equal(jobWatchdogEnabled({ ROOM_JOB_WATCHDOG: "1" }), false);
  assert.equal(jobWatchdogEnabled({ ROOM_JOB_WATCHDOG: "true", JOB_WATCHDOG: { getByName() {} } }), false);
  assert.equal(jobWatchdogEnabled({ ROOM_JOB_WATCHDOG: "1", JOB_WATCHDOG: { getByName() {} } }), true);
  const wrangler = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  const vars = [wrangler.vars, wrangler.env.production.vars, wrangler.env.staging.vars];
  for (const bag of vars) assert.equal(bag.ROOM_JOB_WATCHDOG, undefined);
  const entry = wrangler.durable_objects.bindings.find(binding => binding.name === "JOB_WATCHDOG");
  const staging = wrangler.env.staging.durable_objects.bindings.find(binding => binding.name === "JOB_WATCHDOG");
  const production = wrangler.env.production.durable_objects.bindings.find(binding => binding.name === "JOB_WATCHDOG");
  assert.equal(entry.class_name, "JobWatchdog");
  assert.equal(entry.script_name, "project-room");
  assert.equal(staging.script_name, undefined);
  assert.equal(production.script_name, undefined);
  assert.equal(wrangler.durable_objects.bindings[1].name, "ROOM_SHARD");
});

test("a queue row left started is run once after the watchdog calls the subject stalled", async () => {
  const queue = open();
  const watchdog = open();
  enqueueDurableAlarm(queue, { dedupeKey: "job:patrol:1", kind: "fast-job", payload: { name: "patrol" }, runAt: NOW }, NOW);
  const claimed = claimDueAlarm(queue, NOW);
  checkpointDurableAlarm(queue, claimed.id, { phase: "started" }, NOW);
  beat(watchdog, NOW, { alarmAt: NOW + 1_000 });
  const later = NOW + DURABLE_ALARM_LEASE_MS + WATCHDOG_STALL_MS + 1;
  assert.deepEqual(planWatchdogReboots(watchdog, later), ["invite-only-pilot"]);
  let calls = 0;
  const slice = await runDurableAlarmSlice({
    db: queue, now: later, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, 1);
  assert.equal(slice.recovered, 1);
  assert.equal(queue.prepare("SELECT status FROM durable_alarm_queue").get().status, "done");
  beat(watchdog, later, { alarmAt: later + 30_000, receipt: { job: "patrol", at: later, ok: true, attempt: claimed.attempt + 1 } });
  assert.deepEqual(planWatchdogReboots(watchdog, later), []);
  const health = readWatchdogHealth(watchdog, later);
  assert.equal(health.watchdog.stalled, false);
  assert.equal(health.watchdog.receipts.at(-1).ok, true);
});
