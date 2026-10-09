// REL-24: on Node, GET /api/health/jobs lists every scheduled job with its
// last run. It reports facts only: no top-level status (legal-pages contract).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { JOBS, startNodeScheduler, wireNodeJobs } from "../server/jobs.mjs";
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
