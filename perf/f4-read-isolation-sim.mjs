// F4 SIM benchmark — read p99 of the SSE pump's eventsAfter under synthetic
// write load, against the CURRENT single-connection store.
//
// Models the production shape from the 10/07 load guild (baseline #3):
//   - R "pump" fibers: every 250ms call store.eventsAfter(token, museRoom,
//     cursor, 100) exactly like server/http.mjs stream()'s pump.
//   - W writer fibers: bursts of synchronous store.command() writes to the
//     scratch room, yielding via setImmediate between bursts (the way Node
//     HTTP handlers interleave on one thread).
//
// Phases:
//   A  readers only                       -> baseline read latency
//   B  readers + DB writers (scratch)     -> write-load read latency
//   C  readers + CPU burners             -> control: same event-loop wall
//                                          time as B's writes, but NO sqlite
//                                          work. If C degrades like B, the
//                                          cause is event-loop queueing, not
//                                          sqlite lock contention.
// Plus two direct probes:
//   D  cross-thread: a worker_threads writer holds BEGIN IMMEDIATE open
//      with slow inserts for 1.5s on its OWN connection; main-thread
//      eventsAfter latency is sampled during the hold. In WAL mode a read
//      must not queue behind the writer's RESERVED lock.
//   E  projection-cache coupling: time store.room("muse") (what the pump's
//      projectionMessages() decodes) with a warm cache vs with a scratch-
//      room write between calls (every outermost write txn drops the whole
//      projection cache).
//
// Run: TMPDIR=~/workspace/pr-wave300-fanout/.tmp node perf/f4-read-isolation-sim.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const READERS = Number(process.env.F4_READERS ?? 12);
const WRITERS = Number(process.env.F4_WRITERS ?? 3);
const BURST = Number(process.env.F4_BURST ?? 8);
const PUMP_MS = 250;
const PHASE_A_MS = Number(process.env.F4_A_MS ?? 8000);
const PHASE_B_MS = Number(process.env.F4_B_MS ?? 15000);
const PHASE_C_MS = Number(process.env.F4_C_MS ?? 12000);

const dir = mkdtempSync(join(tmpdir(), "f4-read-isolation-sim-"));
const store = new RoomStore(join(dir, "room.sqlite"));
store.initialize(initialRoom("muse"));
store.initialize(initialRoom("scratch"));
const museKey = store.issueAccessKey("muse", "owner");
const scratchKey = store.issueAccessKey("scratch", "owner");

// capabilities.advertised: a realistic write-transaction load that does not
// spend the room flood-guard budget (message.posted is burst-30 capped).
const msg = (i, room) => ({
  id: randomUUID(),
  type: T.CAPABILITIES_ADVERTISED,
  data: { capabilities: Array.from({ length: 30 }, (_, k) => `${room}-${i}-${k}`.slice(0, 60)) },
});

// Pre-populate the muse room so pump reads scan a realistic log tail.
for (let i = 0; i < 400; i++) store.command(museKey, "muse", msg(i, "muse"));
for (let i = 0; i < 50; i++) store.command(scratchKey, "scratch", msg(i, "scratch"));
let museSeq = store.roomAuthority("muse").sequence;

function pct(samples, p) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// One pump fiber: setInterval at the production 250ms cadence, recording both
// the eventsAfter call latency and how late the timer itself fired.
function pumpFiber(lat, late, stopAt) {
  let cursor = 0;
  let expected = Date.now() + PUMP_MS;
  return new Promise(resolve => {
    const timer = setInterval(() => {
      const now = Date.now();
      late.push(now - expected);
      expected = now + PUMP_MS;
      const t0 = performance.now();
      const page = store.eventsAfter(museKey, "muse", cursor, 100, null);
      lat.push(performance.now() - t0);
      cursor = page.next;
      if (Date.now() >= stopAt) { clearInterval(timer); resolve(); }
    }, PUMP_MS);
  });
}

// Writer fiber: synchronous bursts of store.command to the scratch room,
// yielding between bursts like interleaved HTTP handlers.
async function writerFiber(burstLat, stopAt) {
  let i = 0;
  while (Date.now() < stopAt) {
    const t0 = performance.now();
    for (let b = 0; b < BURST; b++) store.command(scratchKey, "scratch", msg(i++, "scratch"));
    burstLat.push(performance.now() - t0);
    await new Promise(r => setImmediate(r));
  }
}

// CPU-burn control fiber: burns the same wall time as a writer burst, no DB.
async function burnerFiber(burnMs, stopAt) {
  while (Date.now() < stopAt) {
    const end = performance.now() + burnMs;
    while (performance.now() < end) { /* busy */ }
    await new Promise(r => setImmediate(r));
  }
}

async function runPhase(name, { writers = 0, burners = 0, burnMs = 0, ms }) {
  const lat = [], late = [], burstLat = [];
  const stopAt = Date.now() + ms;
  const jobs = [];
  for (let r = 0; r < READERS; r++) jobs.push(pumpFiber(lat, late, stopAt));
  for (let w = 0; w < writers; w++) jobs.push(writerFiber(burstLat, stopAt));
  for (let b = 0; b < burners; b++) jobs.push(burnerFiber(burnMs, stopAt));
  await Promise.all(jobs);
  return { name, reads: lat.length, p50: pct(lat, 50), p99: pct(lat, 99), max: Math.max(...lat, 0),
    lateP99: pct(late, 99), burstMean: mean(burstLat) };
}

const report = [];
console.log("phase A: readers only (baseline)...");
report.push(await runPhase("A readers-only", { ms: PHASE_A_MS }));
console.log("phase B: readers + scratch-room writers...");
const phaseB = await runPhase("B readers+writers", { writers: WRITERS, ms: PHASE_B_MS });
report.push(phaseB);
console.log(`phase C: readers + CPU burners (control, burn=${phaseB.burstMean.toFixed(1)}ms like a write burst)...`);
report.push(await runPhase("C readers+burners", { burners: WRITERS, burnMs: phaseB.burstMean, ms: PHASE_C_MS }));

console.log("\n=== F4 SIM: eventsAfter read latency (ms) ===");
console.log("phase              reads   p50    p99    max    timer-late-p99  writer-burst-mean");
for (const r of report) {
  console.log(`${r.name.padEnd(18)} ${String(r.reads).padStart(5)} ${r.p50.toFixed(2).padStart(6)} ${r.p99.toFixed(2).padStart(6)} ${r.max.toFixed(2).padStart(6)} ${r.lateP99.toFixed(1).padStart(14)} ${r.burstMean.toFixed(1).padStart(17)}`);
}

// Probe D: cross-thread lock hold. Writer thread holds BEGIN IMMEDIATE open
// with slow inserts on its own connection; main samples eventsAfter.
console.log("\nprobe D: cross-thread held write lock (1.5s) while reading...");
{
  const dbFile = join(dir, "room.sqlite");
  const workerSrc = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(dbFile)});
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("BEGIN IMMEDIATE");
    const ins = db.prepare("INSERT INTO events(room_id, sequence, id, body) VALUES('scratch', 100000+?, ?, ?)");
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 1500) { ins.run(i, "lock-probe-" + i, JSON.stringify({ probe: true })); i++; }
    db.exec("ROLLBACK");
    db.close();
  `;
  const w = new Worker(workerSrc, { eval: true, type: "module" });
  await sleep(150); // let the writer take the lock
  const lat = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 1200) {
    const s = performance.now();
    store.eventsAfter(museKey, "muse", museSeq, 100, null);
    lat.push(performance.now() - s);
    await sleep(50);
  }
  await w.terminate();
  console.log(`  eventsAfter during held write lock: n=${lat.length} p50=${pct(lat, 50).toFixed(2)}ms p99=${pct(lat, 99).toFixed(2)}ms max=${Math.max(...lat).toFixed(2)}ms`);
}

// Probe E: projection-cache coupling. The pump also decodes the projection
// (projectionMessages -> store.room). Every outermost write txn clears the
// whole cache, so under write load each pump tick re-decodes.
console.log("probe E: store.room('muse') decode cost, warm cache vs cache dropped by scratch writes...");
{
  store.room("muse"); // warm
  const warm = [];
  for (let i = 0; i < 300; i++) { const t = performance.now(); store.room("muse"); warm.push(performance.now() - t); }
  const cold = [];
  for (let i = 0; i < 300; i++) {
    store.command(scratchKey, "scratch", msg(i, "scratch")); // drops the whole projection cache
    const t = performance.now(); store.room("muse"); cold.push(performance.now() - t);
  }
  console.log(`  warm cache:  p50=${pct(warm, 50).toFixed(2)}ms p99=${pct(warm, 99).toFixed(2)}ms`);
  console.log(`  cache dropped by scratch writes: p50=${pct(cold, 50).toFixed(2)}ms p99=${pct(cold, 99).toFixed(2)}ms`);
}

store.close();
rmSync(dir, { recursive: true, force: true });
console.log("\ndone.");
