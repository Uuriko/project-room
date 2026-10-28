// TEL (consult-build): product-side instrumentation for the four PERF-50
// §5 trigger gauges L22 found UNMEASURED (burst write p95, DO CPU read
// share, poll share, total storage). The read surface is the forward
// contract fleet-tools/trigger-gauges.mjs already implements: a job named
// "request-telemetry" in /api/health/jobs whose lastSummary carries
// writeP95Ms / readCpuSharePct / pollSharePct / activeRooms /
// totalStorageBytes. No samples -> no field (UNMEASURED, never a guess).
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { DurableDatabase, durableStorage } from "../cloudflare/storage.mjs";
import { DoStorageEmulator } from "./helpers/do-storage-emulator.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { jobByName, jobsFor, measureStoreGrowth } from "../server/jobs.mjs";
import { classifyRequest, createRequestTelemetry } from "../server/request-telemetry.mjs";
import { compactSummary } from "../cloudflare/job-heartbeat.mjs";

const rec = (tele, method, path, durationMs) => {
  const url = new URL(path, "https://room.example");
  tele.record({ method, pathname: url.pathname, searchParams: url.searchParams, durationMs });
};

test("classification: write / read / poll / hold / other", () => {
  const c = (m, p) => { const u = new URL(p, "https://room.example"); return classifyRequest(m, u.pathname, u.searchParams); };
  assert.equal(c("POST", "/api/rooms/r1/commands"), "write");
  assert.equal(c("DELETE", "/api/rooms/r1/members/m1"), "write");
  assert.equal(c("GET", "/api/rooms/r1"), "read");
  assert.equal(c("HEAD", "/api/health/jobs"), "read");
  assert.equal(c("GET", "/api/rooms/r1/events?after=41"), "poll");
  assert.equal(c("GET", "/api/rooms/r1/digest?since=9"), "poll");
  assert.equal(c("GET", "/api/rooms/r1/work-changes?cursor=abc"), "poll");
  assert.equal(c("GET", "/api/pair/p123"), "poll");
  assert.equal(c("GET", "/api/rooms/r1/stream?after=41"), "hold");
  assert.equal(c("POST", "/mcp"), "other");
  assert.equal(c("GET", "/"), "other");
  // /room-prefixed twins classify the same
  assert.equal(c("POST", "/room/api/rooms/r1/commands"), "write");
  assert.equal(c("GET", "/room/api/rooms/r1/stream"), "hold");
});

test("snapshot: counts, poll share, cpu share and write p95 over the window", () => {
  const tele = createRequestTelemetry({ startedAt: 1000 });
  for (let i = 1; i <= 100; i++) rec(tele, "POST", "/api/rooms/r1/commands", i); // writes 1..100ms
  for (let i = 0; i < 50; i++) rec(tele, "GET", "/api/rooms/r1", 2);               // reads: 100ms total
  for (let i = 0; i < 40; i++) rec(tele, "GET", "/api/rooms/r1/events?after=1", 1); // polls: 40ms total
  for (let i = 0; i < 10; i++) rec(tele, "GET", "/api/rooms/r1/stream", 9000);      // holds: excluded from cpu
  const s = tele.snapshot(61_000);
  assert.equal(s.requests, 200);
  assert.equal(s.writeRequests, 100);
  assert.equal(s.readRequests, 50);
  assert.equal(s.pollRequests, 40);
  assert.equal(s.holdRequests, 10);
  assert.equal(s.pollSharePct, 25); // (40 poll + 10 hold) / 200
  assert.equal(s.writeP95Ms, 95);   // p95 of 1..100
  // cpu proxy: read+poll handler ms = 140, write = 5050 -> 140/5190 = 2.7%
  assert.equal(s.readCpuSharePct, 2.7);
  assert.equal(s.windowMs, 60_000);
});

test("snapshot with no samples omits every gauge field (honest UNMEASURED)", () => {
  const tele = createRequestTelemetry({ startedAt: 0 });
  const s = tele.snapshot(5000);
  assert.equal(s.writeP95Ms, undefined);
  assert.equal(s.readCpuSharePct, undefined);
  assert.equal(s.pollSharePct, undefined);
  assert.equal(s.requests, 0);
});

test("snapshot resets the window", () => {
  const tele = createRequestTelemetry({ startedAt: 0 });
  rec(tele, "POST", "/api/rooms/r1/commands", 10);
  tele.snapshot(1000);
  const s = tele.snapshot(2000);
  assert.equal(s.requests, 0);
  assert.equal(s.writeP95Ms, undefined);
  assert.equal(s.windowMs, 1000);
});

test("write ring buffer stays bounded under burst", () => {
  const tele = createRequestTelemetry({ startedAt: 0 });
  for (let i = 0; i < 5000; i++) rec(tele, "POST", "/api/rooms/r1/commands", 7);
  const s = tele.snapshot(1000);
  assert.equal(s.writeRequests, 5000);
  assert.equal(s.writeP95Ms, 7);
});

test("request-telemetry job is registered like store-growth (hourly, slow, both runtimes)", () => {
  const job = jobByName("request-telemetry");
  assert.ok(job, "request-telemetry job is registered");
  assert.deepEqual([...job.runtimes].sort(), ["node", "worker"]);
  assert.equal(job.slow, true);
  assert.equal(job.cadenceMs, 3_600_000);
  assert.ok(jobsFor("worker").includes(job));
  assert.ok(jobsFor("node").includes(job));
});

// The production surface is the Durable Object, so the fixture store runs
// on the DO storage emulator (in-memory), not a file-backed Node store.
function fixtureStore() {
  const storage = new DoStorageEmulator();
  const store = new RoomStore(null, { database: new DurableDatabase(storage), storagePlatform: durableStorage });
  store.initialize(initialRoom("commons"));
  return store;
}

test("job summary merges telemetry snapshot with store gauges and survives compactSummary", async () => {
  const store = fixtureStore();
  const tele = createRequestTelemetry({ startedAt: 0 });
  for (let i = 1; i <= 20; i++) rec(tele, "POST", "/api/rooms/r1/commands", i * 10);
  rec(tele, "GET", "/api/rooms/r1/events?after=1", 5);
  const job = jobByName("request-telemetry");
  const summary = await job.run(store, { room: { requestTelemetrySnapshot: () => tele.snapshot(Date.now()) } });
  assert.equal(summary.writeP95Ms, 190);
  assert.equal(summary.pollSharePct, Math.round(((1 / 21) * 100) * 100) / 100);
  assert.equal(typeof summary.readCpuSharePct, "number");
  assert.equal(summary.activeRooms, 1);
  assert.ok(summary.totalStorageBytes > 0, `totalStorageBytes=${summary.totalStorageBytes}`);
  // The health heartbeat keeps at most 12 flat numeric keys: the whole
  // summary must ride through unchanged or trigger-gauges never sees it.
  const compact = compactSummary(summary);
  assert.deepEqual(compact, summary);
});

test("job run without a DO telemetry source still reports honest storage, no invented latency", async () => {
  const store = fixtureStore();
  const job = jobByName("request-telemetry");
  const summary = await job.run(store, {});
  assert.equal(summary.writeP95Ms, undefined);
  assert.equal(summary.pollSharePct, undefined);
  assert.equal(summary.activeRooms, 1);
  assert.ok(summary.totalStorageBytes > 0);
});

test("measureStoreGrowth: DO databaseSize fallback when PRAGMA yields nothing", () => {
  const fakeDb = {
    storage: { sql: { databaseSize: 777_000 } },
    prepare(sql) {
      return { get: () => {
        if (sql.includes("FROM rooms")) return { rooms: 3, events: 9, maxProjectionBytes: 10 };
        if (sql.startsWith("PRAGMA")) return {}; // page_count/page_size absent on this runtime
        throw new Error(`unexpected sql ${sql}`);
      } };
    }
  };
  const gauges = measureStoreGrowth({ db: fakeDb });
  assert.equal(gauges.dbBytes, 777_000);
  assert.equal(gauges.rooms, 3);
});

test("measureStoreGrowth: dbstat fallback when neither PRAGMA nor databaseSize exists", () => {
  const fakeDb = {
    prepare(sql) {
      return { get: () => {
        if (sql.includes("FROM rooms")) return { rooms: 1, events: 1, maxProjectionBytes: 1 };
        if (sql.startsWith("PRAGMA")) return {};
        if (sql.includes("dbstat")) return { bytes: 555_000 };
        throw new Error(`unexpected sql ${sql}`);
      } };
    }
  };
  assert.equal(measureStoreGrowth({ db: fakeDb }).dbBytes, 555_000);
});

test("measureStoreGrowth: placeholder zero only when every size read fails", () => {
  const fakeDb = {
    prepare(sql) {
      return { get: () => {
        if (sql.includes("FROM rooms")) return { rooms: 1, events: 1, maxProjectionBytes: 1 };
        throw new Error("unsupported");
      } };
    }
  };
  assert.equal(measureStoreGrowth({ db: fakeDb }).dbBytes, 0);
});
