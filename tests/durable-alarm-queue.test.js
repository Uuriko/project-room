// The alarm queue is the list behind the one Durable Object alarm.
// A slice that dies after its checkpoint must leave a row the next slice
// can see: re-run if the job never finished, skip if it did.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DURABLE_ALARM_LEASE_MS, DURABLE_ALARM_MAX_ATTEMPTS, DURABLE_ALARM_RETRY_MS,
  claimDueAlarm, checkpointDurableAlarm, enqueueDurableAlarm, runDurableAlarmSlice
} from "../server/durable-alarm-queue.mjs";
import { durableAlarmQueueEnabled, runDurableAlarmTurn } from "../server/durable-alarm-turn.mjs";
import { RoomStore } from "../server/store.mjs";
import { STORE_SCHEMA_VERSION } from "../server/writer-fence.mjs";

const NOW = 1_700_000_000_000;

function openQueue() {
  return new DatabaseSync(":memory:");
}

function enqueue(db, key, runAt = NOW) {
  return enqueueDurableAlarm(db, {
    dedupeKey: key, kind: "fast-job", payload: { name: "patrol" }, runAt
  }, NOW);
}

test("one slice runs one of three due rows and leaves the rest queued", async () => {
  const db = openQueue();
  enqueue(db, "job:patrol:1");
  enqueue(db, "job:patrol:2");
  enqueue(db, "job:patrol:3");
  let calls = 0;
  const slice = await runDurableAlarmSlice({
    db, now: NOW, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, 1);
  assert.equal(slice.ran, true);
  assert.equal(db.prepare("SELECT count(*) AS n FROM durable_alarm_queue WHERE status='queued'").get().n, 2);
  assert.equal(db.prepare("SELECT count(*) AS n FROM durable_alarm_queue WHERE status='done'").get().n, 1);
  assert.ok(slice.nextAt <= NOW);
});

test("a slice that dies after the started checkpoint is run again once the lease expires", async () => {
  const db = openQueue();
  enqueue(db, "job:patrol:dead");
  const claimed = claimDueAlarm(db, NOW);
  checkpointDurableAlarm(db, claimed.id, { phase: "started" }, NOW);
  const later = NOW + DURABLE_ALARM_LEASE_MS + 1;
  let calls = 0;
  const slice = await runDurableAlarmSlice({
    db, now: later, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(slice.recovered, 1);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT status, cursor_json FROM durable_alarm_queue").get().status, "done");
});

test("a slice that dies after the finished checkpoint is not run again", async () => {
  const db = openQueue();
  enqueue(db, "job:patrol:done");
  const claimed = claimDueAlarm(db, NOW);
  checkpointDurableAlarm(db, claimed.id, { phase: "finished" }, NOW);
  const later = NOW + DURABLE_ALARM_LEASE_MS + 1;
  let calls = 0;
  const slice = await runDurableAlarmSlice({
    db, now: later, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, 0);
  assert.equal(slice.skipped, "finished");
  assert.equal(db.prepare("SELECT status FROM durable_alarm_queue").get().status, "done");
});

test("a thrown job stays queued until the retry delay, then runs", async () => {
  const db = openQueue();
  enqueue(db, "job:patrol:retry");
  const failed = await runDurableAlarmSlice({
    db, now: NOW, run: async () => { throw new Error("boom"); }
  });
  assert.equal(failed.failed, true);
  const waiting = db.prepare("SELECT status, run_at AS runAt FROM durable_alarm_queue").get();
  assert.equal(waiting.status, "queued");
  assert.equal(waiting.runAt, NOW + DURABLE_ALARM_RETRY_MS);
  const early = await runDurableAlarmSlice({
    db, now: NOW + 1000, run: async () => { throw new Error("too soon"); }
  });
  assert.equal(early.item, null);
  let calls = 0;
  const again = await runDurableAlarmSlice({
    db, now: waiting.runAt, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(again.ran, true);
  assert.equal(calls, 1);
  assert.equal(db.prepare("SELECT status FROM durable_alarm_queue").get().status, "done");
});

test("the attempt cap poisons a row instead of running it forever", async () => {
  const db = openQueue();
  enqueue(db, "job:patrol:poison");
  let calls = 0;
  let now = NOW;
  for (let attempt = 0; attempt < DURABLE_ALARM_MAX_ATTEMPTS; attempt += 1) {
    const slice = await runDurableAlarmSlice({
      db, now, run: async () => { calls += 1; throw new Error("no"); }
    });
    assert.equal(slice.failed, true);
    now = slice.nextAt;
  }
  const poisoned = await runDurableAlarmSlice({
    db, now, run: async () => { calls += 1; return { ok: true }; }
  });
  assert.equal(calls, DURABLE_ALARM_MAX_ATTEMPTS);
  assert.equal(poisoned.skipped, "poisoned");
  assert.equal(db.prepare("SELECT status, cursor_json FROM durable_alarm_queue").get().cursor_json, '{"phase":"poisoned"}');
});

test("a second enqueue of the same slot does not add a row", () => {
  const db = openQueue();
  const first = enqueue(db, "job:patrol:slot");
  const second = enqueue(db, "job:patrol:slot");
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM durable_alarm_queue").get().n, 1);
  assert.throws(() => enqueueDurableAlarm(db, {
    dedupeKey: "has spaces", kind: "fast-job", payload: { name: "patrol" }, runAt: NOW
  }, NOW), /dedupe key/);
});

test("the queue flag defaults off and a drain runs at most one job", async () => {
  assert.equal(durableAlarmQueueEnabled({}), false);
  assert.equal(durableAlarmQueueEnabled({ ROOM_DURABLE_ALARM_QUEUE: "0" }), false);
  assert.equal(durableAlarmQueueEnabled({ ROOM_DURABLE_ALARM_QUEUE: "1" }), true);
  const release = JSON.parse(readFileSync(new URL("../cloudflare/wrangler.jsonc", import.meta.url), "utf8"));
  for (const vars of [release.vars, release.env.production.vars, release.env.staging.vars]) {
    assert.equal(vars.ROOM_DURABLE_ALARM_QUEUE, undefined);
  }

  const directory = mkdtempSync(join(tmpdir(), "alarm-turn-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  try {
    const versionBefore = store.db.prepare("PRAGMA user_version").get().user_version;
    assert.equal(versionBefore, STORE_SCHEMA_VERSION);
    const env = { ROOM_DURABLE_ALARM_QUEUE: "1" };
    const base = { db: store.db, env, store, now: NOW, lastRan: {} };
    let calls = 0;
    const enqueued = await runDurableAlarmTurn({ ...base, includeSlow: true, drain: false, runJob: async () => { calls += 1; return []; } });
    assert.equal(enqueued.enabled, true);
    assert.equal(enqueued.drained, false);
    assert.equal(calls, 0);
    assert.ok(enqueued.queued.length >= 1);
    const drained = await runDurableAlarmTurn({
      ...base, includeSlow: true, drain: true,
      runJob: async () => { calls += 1; return [{ ok: true }]; }
    });
    assert.equal(calls, 1);
    assert.equal(drained.ran, true);
    const before = calls;
    await runDurableAlarmTurn({
      ...base, includeSlow: true, drain: true,
      runJob: async () => { calls += 1; return [{ ok: true }]; }
    });
    assert.ok(calls - before <= 1, "a drain runs at most one job");
    if (enqueued.queued.length > 1) assert.equal(calls - before, 1);
    assert.equal(store.db.prepare("PRAGMA user_version").get().user_version, versionBefore);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM durable_alarm_queue").get().n >= 1, true);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
