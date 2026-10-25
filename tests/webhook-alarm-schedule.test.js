// A webhook retry names its next attempt on the delivery row. The worker
// alarm has to wake at that time. Pushing every already-due fast job out by
// one minute made a row that said "+10s" retry about a minute later.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { ALARM_RETRY_MS, JOBS, MINUTE_MS, WEBHOOK_ALARM_FLOOR_MS, alarmSchedule } from "../server/jobs.mjs";

const env = { ROOM_GMAIL_ENABLED: "0" };

function open(t) {
  const dir = mkdtempSync(join(tmpdir(), "webhook-alarm-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => store.close());
  return store;
}

function insertDelivery(store, { id, at, state = "failed", attempts = 1 }) {
  store.db.prepare(`INSERT INTO agent_webhook_deliveries
    (delivery_id, idempotency_key, subscription_id, agent_id, event_type, payload_json, signature, state, attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, 'sub_missing', 'ai_missing', 'message.posted', '{}', 'sig', ?, ?, ?, ?, ?)`)
    .run(id, `manual:${id}`, state, attempts, at, at, at);
}

const schedule = (store, now, retryDelayMs = 0) => alarmSchedule({
  jobs: JOBS, env, store, now, lastRan: {}, runtime: "worker", retryDelayMs
});

test("a webhook due in 10s arms the alarm at that attempt, not a minute later", t => {
  const store = open(t);
  const now = Date.now();
  const due = now + 10_000;
  insertDelivery(store, { id: "del_soon", at: due });
  const alarm = schedule(store, now);
  assert.equal(alarm, due);
  assert.ok(alarm < now + MINUTE_MS);
});

test("an already-due webhook arms within the short floor, not one cadence later", t => {
  const store = open(t);
  const now = Date.now();
  insertDelivery(store, { id: "del_overdue", at: now - 5_000 });
  const alarm = schedule(store, now);
  assert.equal(alarm, now + WEBHOOK_ALARM_FLOOR_MS);
  assert.ok(alarm < now + 30_000);
});

test("a thrown tick still backs off a full retry delay when nothing is scheduled ahead", t => {
  const store = open(t);
  const now = Date.now();
  insertDelivery(store, { id: "del_throw", at: now - 1, state: "pending", attempts: 0 });
  const alarm = schedule(store, now, ALARM_RETRY_MS);
  assert.equal(alarm, now + ALARM_RETRY_MS);
});
