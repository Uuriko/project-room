// #3895 (sweep F-5): the single Durable Object holds every room, account
// and job, but no production-runtime job watched aggregate store growth
// toward the store's limits — growth-watch is node-only because it reads
// a process-local product-growth collector, and per-room projection-cap
// pressure surfaced only as per-request 409s. The store-growth job closes
// the watch gap in both runtimes: cheap gauges off the rooms table plus
// the SQLite page count, and a named failure when a gauge crosses the
// line where an operator must act (the 3.5 MB projection escalation line
// against the 4 MiB app cap; ~80% of the 10 GB DO SQLite limit).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { STORE_GROWTH_LIMITS, jobByName, jobsFor, measureStoreGrowth, storeGrowthBreach } from "../server/jobs.mjs";

function fixtureStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-store-growth-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom("commons"));
  return store;
}

test("store-growth is registered for both runtimes as a slow hourly job", () => {
  const job = jobByName("store-growth");
  assert.ok(job, "store-growth job is registered");
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
  assert.equal(job.slow, true);
  assert.equal(job.cadenceMs, 3_600_000);
  assert.ok(jobsFor("worker").includes(job));
  assert.ok(jobsFor("node").includes(job));
});

test("the gauges read the aggregate store: rooms, events, largest projection, db bytes", t => {
  const store = fixtureStore(t);
  const gauges = measureStoreGrowth(store);
  assert.equal(gauges.rooms, 1);
  assert.ok(Number.isSafeInteger(gauges.events) && gauges.events > 0, `events=${gauges.events}`);
  assert.ok(gauges.maxProjectionBytes > 0, `maxProjectionBytes=${gauges.maxProjectionBytes}`);
  assert.ok(gauges.dbBytes > 0, `dbBytes=${gauges.dbBytes}`);
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), null);
});

test("a room projection past the escalation line is a named breach", t => {
  const store = fixtureStore(t);
  // A projection blob just past the 3.5 MB escalation line (the app cap
  // is 4 MiB): written directly because no product path should produce
  // one in a fixture — the gauge reads LENGTH(projection), nothing else.
  store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(3_600_000));
  const gauges = measureStoreGrowth(store);
  assert.equal(gauges.maxProjectionBytes, 3_600_000);
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), "maxProjectionBytes");
});

test("the db-size breach is judged against the same limits", () => {
  const gauges = { rooms: 3, events: 10, maxProjectionBytes: 10, dbBytes: STORE_GROWTH_LIMITS.dbBytes + 1 };
  assert.equal(storeGrowthBreach(gauges, STORE_GROWTH_LIMITS), "dbBytes");
  assert.equal(storeGrowthBreach({ ...gauges, dbBytes: STORE_GROWTH_LIMITS.dbBytes }, STORE_GROWTH_LIMITS), null);
});

test("the job returns the gauges as its summary and fails by name on a breach", async t => {
  const store = fixtureStore(t);
  const job = jobByName("store-growth");
  const healthy = await job.run(store, {});
  assert.equal(healthy.errors, undefined);
  assert.equal(healthy.rooms, 1);
  assert.ok(healthy.maxProjectionBytes > 0);
  store.db.prepare("UPDATE rooms SET projection = ?").run("x".repeat(3_600_000));
  const breached = await job.run(store, {});
  assert.equal(breached.errors, 1);
  assert.equal(breached.failureDetail?.code, "store_growth_limit");
  // The summary still carries every gauge so the operator sees which
  // line was crossed and by how much.
  assert.equal(breached.maxProjectionBytes, 3_600_000);
  assert.ok(breached.rooms >= 1);
});
