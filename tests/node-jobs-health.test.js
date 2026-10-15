// REL-24: on Node, GET /api/health/jobs lists every scheduled job with its
// last run. It reports facts only: no top-level status (legal-pages contract).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { HOUR_MS, JOBS, startNodeScheduler, wireNodeJobs } from "../server/jobs.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

function storeFor(t) {
  const dir = mkdtempSync(join(tmpdir(), "room-rel24-"));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

test("scheduler jobHealth lists every registry job and records runs", async t => {
  const store = storeFor(t);
  const scheduler = startNodeScheduler({ store, env: {}, tickMs: 0 });
  const before = scheduler.jobHealth();
  assert.deepEqual(before.map(j => j.name), JOBS.map(j => j.name), "every registry job, in order");
  for (const job of before) {
    assert.equal(job.lastRunAt, null); assert.equal(job.consecutiveFailures, 0);
    assert.equal(typeof job.periodSeconds, "number");
  }
  const backup = before.find(j => j.name === "room-backup");
  assert.equal(backup.runtime, "worker-only"); assert.equal(backup.enabled, false); assert.match(backup.reason, /Node/);
  const outcomes = await scheduler.runOnce();
  assert.ok(outcomes.length > 0, "at least one enabled Node job ran");
  const after = scheduler.jobHealth();
  for (const o of outcomes) {
    const row = after.find(j => j.name === o.job);
    assert.equal(row.enabled, true); assert.equal(typeof row.lastRunAt, "string");
    if (o.ok) assert.ok(row.lastSuccessAt || row.lastErrorAt);
  }
  for (const row of after.filter(j => !j.enabled)) assert.equal(row.lastRunAt, null, `${row.name} is disabled and never ran`);
  assert.equal(JSON.stringify(after).match(/token|secret|password/i), null);
});

test("node scheduler retention job rotates to the next table on each tick", async t => {
  const store = storeFor(t);
  let clock = Date.now();
  const day = 86400000;
  // One expired row in each disposable log table. Retention prunes exactly
  // one table per tick, rotating through RETENTION_TABLES.
  store.db.prepare("INSERT INTO web_fetch_log(request_id,room_id,member_id,credential_hash,host,cache_status,bytes,tags_json,created_at) VALUES('fetch-old','commons','owner',NULL,'example.com','hit',2,'[]',?)")
    .run(clock - 35 * day);
  store.db.prepare("INSERT INTO web_research_log(request_id,room_id,member_id,credential_hash,question_hash,sources_json,evidence_count,plan_only,created_at) VALUES('research-old','commons','owner',NULL,'hash','[]',0,1,?)")
    .run(clock - 35 * day);
  const count = table => store.db.prepare(`SELECT count(*) n FROM ${table}`).get().n;
  const scheduler = startNodeScheduler({ store, env: { GROWTH_WATCH_INTERVAL_MS: "0" }, tickMs: 0, now: () => clock });
  t.after(() => scheduler.stop());
  const retentionRun = async () => {
    const outcome = (await scheduler.runOnce()).find(o => o.job === "retention");
    assert.ok(outcome?.ok, "retention tick succeeds");
    return outcome.result;
  };
  const first = await retentionRun();
  assert.equal(first.table, "web_fetch_log");
  assert.equal(first.deleted, 1);
  assert.equal(count("web_fetch_log"), 0);
  assert.equal(count("web_research_log"), 1, "the second table waits for the next tick");
  clock += HOUR_MS;
  const second = await retentionRun();
  assert.equal(second.table, "web_research_log", "the rotated index survives to the next tick");
  assert.equal(second.deleted, 1);
  assert.equal(count("web_research_log"), 0);
  clock += HOUR_MS;
  const third = await retentionRun();
  assert.equal(third.table, "web_fetch_log", "the rotation wraps around");
});

test("GET /api/health/jobs on Node includes the jobs list once the scheduler is wired", async t => {
  const store = storeFor(t);
  const server = createRoomServer({ store });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const scheduler = wireNodeJobs(store, { env: {}, tickMs: 0 });
  t.after(async () => { scheduler.stop(); server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  await scheduler.runOnce();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${origin}/api/health/jobs`, { headers: { Origin: origin } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.schema, "room.job-health/1"); assert.equal(body.servedBy, "node");
  assert.equal(Object.hasOwn(body, "status"), false, "Node reports facts, not a grade");
  assert.deepEqual(body.jobs.map(j => j.name), JOBS.map(j => j.name));
  assert.ok(body.jobs.some(j => j.enabled && typeof j.lastRunAt === "string"));
});
