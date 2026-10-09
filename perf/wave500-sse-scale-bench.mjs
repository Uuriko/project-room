// WAVE-500 W1 SIM benchmark — SSE stream ceiling (before F1).
//
// Drives the REAL stream() pump path in server/http.mjs (real HTTP server,
// real SSE connections, real pump body: eventsAfter -> projectionMessages ->
// redactEventPage -> per-event JSON.stringify -> res.write, at the production
// 250ms cadence). The store is fake (SIM label): indexed in-memory event log
// with the same per-row JSON.parse the real store does; projection rebuild
// carries PROJECTION_MESSAGES messages like the real projection decode.
//
// The current code caps each server instance at 100 global streams (429
// stream_limit). To measure the EVENT-LOOP ceiling of the pump architecture
// itself at N = 100..500, this harness runs ceil(N/100) real server instances
// in ONE Node process, each with <=100 streams — every pump fiber shares the
// same event loop, which is the resource whose ceiling is being measured.
// This bypasses the open-time policy cap only; the pump path is untouched.
//
// Clients drain (read + discard) so the measurement is server pump work, not
// client speed; res.writableLength stays ~0 so stream_lagging never trips.
//
// Metrics per run:
//   - cpuMsPerSec: process.cpuUsage (user+sys) per wall second. Ceiling when
//     this exceeds ~1000ms (the single Node thread is saturated).
//   - tick lateness p50/p99: per-stream pump interval deviation from 250ms,
//     observed in the fake store's eventsAfter (per-stream call timestamps).
//   - messagesPerSec: event rows fetched by pump ticks per wall second
//     (~= rows written to sockets; no lagging-breaks observed with drain).
//   - eventLoopDelay mean/p99/max via monitorEventLoopDelay (recorded; the
//     VM floor inflates it, so cpuMsPerSec + lateness are the lead signals).
//
// Run (from the repo root):
//   TMPDIR=~/workspace/pr-wave500-w1-scale/.tmp node perf/wave500-sse-scale-bench.mjs \
//     --streams 100 --seconds 10 --runs 3 --out perf/wave500-sse-scale-results.jsonl
//
// Label: SIM. Measurement only — implements nothing.
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { createRoomServer } from "../server/http.mjs";

const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--")) args[a.slice(2)] = rawArgs[++i];
  else args[a.slice(2)] = true;
}
const STREAMS = Number(args.streams ?? 100);
const SECONDS = Number(args.seconds ?? 10);
const RUNS = Number(args.runs ?? 3);
const INTERVAL = Number(args.interval ?? 250);
// Adaptive preload: every stream must still be pumping FULL 100-row pages
// when the measurement window ends. Catch-up needs PRELOAD/100 ticks;
// opens cost ~0.3s/stream sequentially under fleet contention, so budget
// N*160 events (floor 5000).
const PRELOAD = Number(args.preload ?? Math.max(5000, STREAMS * 160));
const PROJECTION_MESSAGES = Number(args.projectionMessages ?? 2000);
const OUT = args.out ?? null;
const LABEL = args.label ?? "w500-sse-scale";
const SETTLE_MS = Number(args.settleMs ?? 2000);
// --atHead: open streams at the log head (empty pages) — isolates the shared
// fetch+redact+projection work from the per-event stringify+write path.
const AT_HEAD = args.atHead === true || args.atHead === "true";
// The code caps each instance at 100 streams; spread N across instances.
const INSTANCES = Math.max(1, Math.ceil(STREAMS / 100));

const tok = (inst, i, run) => (`w500r${run}i${inst}s${i}-` + "x".repeat(43)).slice(0, 43);

function pct(samples, p) {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// Fake store shared by all instances in the run (one process = one event
// loop). Events indexed by sequence so eventsAfter is O(limit), like the
// real indexed SQLite query; per-row JSON.parse mirrors the real store.
function fakeStore() {
  const bodies = [];
  for (let i = 1; i <= PRELOAD; i++) {
    bodies.push(JSON.stringify({ id: `evt-${i}`, type: "message.posted", actorId: "member-a", data: { body: `body-${i}-` + "x".repeat(180) } }));
  }
  return {
    eventsAfterCalls: 0,
    pumpCalls: 0, // eventsAfter calls from pump ticks (excludes open-time validation)
    rowsDelivered: 0,
    _tickCount: new Map(), // token -> number of eventsAfter calls
    _lastTick: new Map(),  // token -> performance.now() of last call
    _late: [],             // per-stream tick interval deviation from INTERVAL
    resetRun() {
      this.eventsAfterCalls = 0; this.pumpCalls = 0; this.rowsDelivered = 0;
      this._tickCount.clear(); this._lastTick.clear(); this._late = [];
    },
    authenticate(token) {
      return { member: { id: "member-a" }, credentialHash: `h-${token}`, credentialScope: "room", kind: "identity", sessionBinding: null };
    },
    eventsAfter(token, roomId, after = 0, limit = 100) {
      this.eventsAfterCalls++;
      const now = performance.now();
      const n = (this._tickCount.get(token) ?? 0) + 1;
      this._tickCount.set(token, n);
      const prev = this._lastTick.get(token);
      // Call 1 is the open-time validation (result discarded by stream()).
      // Lateness is measured from the 2nd pump interval onward.
      if (n >= 3 && prev !== undefined) this._late.push(now - prev - INTERVAL);
      this._lastTick.set(token, now);
      const rows = [];
      const start = Math.max(0, Math.floor(after));
      for (let seq = start + 1; seq <= start + limit && seq <= PRELOAD; seq++) {
        rows.push({ sequence: seq, event: JSON.parse(bodies[seq - 1]) });
        if (rows.length >= limit) break;
      }
      // Only pump ticks (call >= 2) fetch rows that get written to sockets.
      if (n >= 2) { this.pumpCalls++; this.rowsDelivered += rows.length; }
      const sequence = PRELOAD;
      const reachedEnd = rows.length < limit;
      const next = reachedEnd ? sequence : rows.at(-1).sequence;
      return { events: rows, next, hasMore: next < sequence };
    },
    room() {
      // Rebuilt per call, like the real projection decode the pump pays.
      const messages = [];
      for (let i = 1; i <= PROJECTION_MESSAGES; i++) {
        messages.push({ id: `msg-${i}`, body: `message ${i}`, createdAt: "2026-10-08T00:00:00.000Z", authorId: "member-a" });
      }
      return { state: { messages, room: { ownerId: "owner" } } };
    },
    roomAuthority() { return { ownerId: "owner", sequence: PRELOAD, members: {} }; },
    historyFloor() { return null; },
    bonds: { identityForMember() { return null; } },
  };
}

// Drain a client reader in the background (read + discard).
function drainClient(reader) {
  (async () => {
    try { for (;;) { const { done } = await reader.read(); if (done) break; } } catch { /* closed */ }
  })();
}

async function runOnce(runIdx, store) {
  store.resetRun();
  const per = Math.ceil(STREAMS / INSTANCES);
  const servers = [];
  const readers = [];
  const openAfter = AT_HEAD ? PRELOAD : 0;
  const openStart = performance.now();
  try {
    for (let inst = 0; inst < INSTANCES; inst++) {
      const count = Math.min(per, STREAMS - inst * per);
      if (count <= 0) break;
      const server = createRoomServer({ store, streamInterval: INTERVAL });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      servers.push(server);
      for (let i = 0; i < count; i++) {
        const response = await fetch(`${origin}/api/rooms/room-a/stream?after=${openAfter}`, {
          headers: { Authorization: `Bearer ${tok(inst, i, runIdx)}` },
        });
        if (response.status !== 200) {
          const text = await response.text().catch(() => "");
          throw new Error(`stream open failed: ${response.status} ${text.slice(0, 120)} (inst ${inst} stream ${i})`);
        }
        const reader = response.body.getReader();
        readers.push(reader);
        drainClient(reader);
      }
    }
    const opened = readers.length;
    const openMs = performance.now() - openStart;
    // 1s warmup so the measurement window sees steady-state pumping.
    await sleep(1000);

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const loadBefore = loadavg();
    const callsBefore = store.eventsAfterCalls;
    const pumpBefore = store.pumpCalls;
    const rowsBefore = store.rowsDelivered;
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();
    await sleep(SECONDS * 1000);
    histogram.disable();
    const wallMs = performance.now() - wallBefore;
    const cpu = process.cpuUsage(cpuBefore);
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const rows = store.rowsDelivered - rowsBefore;
    const pumpCalls = store.pumpCalls - pumpBefore;
    const expectedTicks = opened * (SECONDS * 1000 / INTERVAL);

    const late = store._late;
    const result = {
      label: `SIM ${LABEL}`,
      run: runIdx + 1,
      streams: opened,
      instances: servers.length,
      openMs: Number(openMs.toFixed(0)),
      seconds: SECONDS,
      pumpIntervalMs: INTERVAL,
      preloadEvents: PRELOAD,
      projectionMessages: PROJECTION_MESSAGES,
      atHead: AT_HEAD,
      eventsAfterCalls: store.eventsAfterCalls - callsBefore,
      pump: {
        ticks: pumpCalls,
        expectedTicks: Math.round(expectedTicks),
        deliveryRatio: Number((pumpCalls / expectedTicks).toFixed(3)),
      },
      loadavg: { before: loadBefore.map(v => Number(v.toFixed(2))), after: loadavg().map(v => Number(v.toFixed(2))) },
      cpu: {
        cpuMsPerSec: Number((cpuMs / (wallMs / 1000)).toFixed(1)),
        cpuMsTotal: Number(cpuMs.toFixed(0)),
      },
      tickLatenessMs: {
        samples: late.length,
        p50: Number(pct(late, 50).toFixed(1)),
        p99: Number(pct(late, 99).toFixed(1)),
        max: Number(Math.max(...late, 0).toFixed(1)),
      },
      messages: {
        rowsDelivered: rows,
        rowsPerSec: Number((rows / (wallMs / 1000)).toFixed(0)),
      },
      eventLoopDelayMs: {
        mean: Number((histogram.mean / 1e6).toFixed(2)),
        p99: Number((histogram.percentile(99) / 1e6).toFixed(2)),
        max: Number((histogram.max / 1e6).toFixed(2)),
        samples: histogram.count,
      },
    };
    return result;
  } finally {
    for (const reader of readers) await reader.cancel().catch(() => {});
    for (const server of servers) {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }
}

const store = fakeStore();
for (let r = 0; r < RUNS; r++) {
  if (r > 0) await sleep(SETTLE_MS);
  const result = await runOnce(r, store);
  const line = JSON.stringify(result);
  console.log(line);
  if (OUT) appendFileSync(OUT, line + "\n"); // flush per run: restart-safe
}
process.exit(0);
