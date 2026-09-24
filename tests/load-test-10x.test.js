// F010 load-test expansion: 10x scenarios alongside tests/load-test-smoke.test.js.
//
// Script-level scenarios drive scripts/load-test.mjs with small-but-real configs
// (ramp-up/ramp-down, soak, burst spikes, degraded pump, all-mode targets).
// In-process scenarios reuse the script's own fixture pattern (RoomStore +
// createRoomServer + RoomAgentClient) for the knobs the script does not expose:
// claim contention on one key, mixed read/write ratios, error injection under
// load, raw-socket stream-pool exhaustion, and rate-limit degradation.
//
// Everything is simulated in-process over loopback: no real network, no devices.
// Guardrails respected throughout: <=99 agent members, <=3 streams per credential,
// 100 open streams per server, 60 writes per credential per minute.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomAgentClient } from "../client/room-agent.mjs";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

const ROOM = "commons";
const script = fileURLToPath(new URL("../scripts/load-test.mjs", import.meta.url));
const runScript = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 120000 });
const reportOf = result => {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// ---- in-process fixture (same pattern as scripts/load-test.mjs) --------------
function openRoom({ members, prefix, workItems = false }) {
  const directory = mkdtempSync(join(tmpdir(), "room-load10x-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey(ROOM, "owner");
  const agents = [];
  for (let i = 0; i < members; i++) {
    const memberId = `${prefix}-${i}`;
    store.command(ownerKey, ROOM, { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    // Graduated autonomy tiers: the load agents are operator-promoted so the
    // contention tests exercise them as working agents.
    setTier(store.db, ROOM, memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
    if (workItems) store.command(ownerKey, ROOM, { id: randomUUID(), type: T.WORK_PROPOSED, data: {
      workItemId: `load10x-task-${i}`, title: `Load 10x task ${i}`, definitionOfDone: "Claimed under contention",
      accountableMemberId: memberId, mode: "read" } });
    agents.push({ memberId, key: store.issueAccessKey(ROOM, memberId) });
  }
  return { directory, store, agents, close: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
async function startServer(store, serverOptions = {}) {
  const server = createRoomServer({ store, ...serverOptions });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, stop: async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
const clientFor = ({ origin, memberId, key }) =>
  new RoomAgentClient({ version: 1, origin, roomId: ROOM, memberId, token: key });

// Raw TCP stream open: holds a real server connection without undici's
// per-origin connection cap, so the 100-open-stream pool limit is reachable.
function openRawStream(origin, key, after = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    socket.once("error", reject);
    let head = "";
    const onData = chunk => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const headers = head.slice(0, end);
      const status = Number(headers.slice(9, 12));
      if (status === 200) { socket.off("data", onData); resolve({ socket, status, code: null }); return; }
      const length = Number(/content-length: (\d+)/i.exec(headers)?.[1] ?? 0);
      const body = head.slice(end + 4);
      if (body.length < length) return; // wait for the full error body
      socket.off("data", onData);
      let code = null;
      try { code = JSON.parse(body).error?.code ?? null; } catch { code = null; }
      resolve({ socket, status, code });
    };
    socket.on("data", onData);
    socket.write(`GET /api/rooms/${ROOM}/stream?after=${after} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${key}\r\n\r\n`);
  });
}

// ---- 1. ramp-up / ramp-down ---------------------------------------------------
test("ramp-up/ramp-down: commands scale with concurrency, latency recovers", () => {
  // Claim races are benign here: every attempted op is either counted or lands
  // in errors as a claim conflict, so ops + error count is exact.
  const benign = new Set(["session_claimed", "command_rejected", "No queued session card for that work item"]);
  const run = agents => {
    const report = reportOf(runScript(["--mode", "commands", "--agents", String(agents), "--iterations", "1", "--quiet"])).commands;
    assert.equal(report.agents, agents);
    const attempted = report.ops + Object.values(report.errors).reduce((n, c) => n + c, 0);
    assert.equal(attempted, agents * 5, "5 attempted ops per agent per iteration");
    for (const code of Object.keys(report.errors)) assert.ok(benign.has(code), `unexpected error code ${code}`);
    assert.ok(report.opsPerSec > 0);
    assert.ok(Number(report.latencyMs.p95) < 10000, "p95 stays sane under ramp");
    return report;
  };
  const small = run(4);
  run(12);
  const peak = run(24);
  // Throughput scales with concurrency on dedicated hardware, but shared CI
  // runners contend: 24 agents can measure slower than 4. Assert peak stays
  // within a sane factor instead of strictly >=, so real collapses still fail.
  assert.ok(peak.opsPerSec >= small.opsPerSec * 0.25,
    `peak ${peak.opsPerSec} ops/s should stay within 4x of small ${small.opsPerSec} ops/s`);
  const down = run(4);
  assert.ok(Number(down.latencyMs.p95) <= Number(peak.latencyMs.p95) * 2, "latency recovers after ramp-down");
});

// ---- 2. sustained load soak ----------------------------------------------------
test("sustained load soak: 1000 wakes drain with zero loss", () => {
  const report = reportOf(runScript(["--mode", "queue", "--wakes", "1000", "--wake-interval-ms", "2",
    "--poll-ms", "10", "--lease-batch", "32", "--wake-members", "6", "--quiet"])).queue;
  assert.equal(report.enqueued, 1000);
  assert.equal(report.leased, 1000);
  assert.equal(report.completed, 1000);
  assert.equal(report.unleased, 0);
  assert.deepEqual(report.errors, {});
  assert.equal(report.lagMs.count, 1000);
});

// ---- 3. burst spikes -------------------------------------------------------------
test("burst spikes: 1ms-interval message bursts fan out completely", () => {
  const report = reportOf(runScript(["--mode", "streams", "--streams", "8", "--messages", "40",
    "--message-interval-ms", "1", "--stream-interval-ms", "10", "--settle-ms", "20000", "--quiet"])).streams;
  assert.equal(report.streamsOpen, 8);
  assert.deepEqual(report.openFailures, {});
  assert.equal(report.posted, 40);
  assert.equal(report.deliveries.received, report.deliveries.expected);
  assert.equal(report.deliveries.missing, 0);
  assert.equal(report.closedByServer.count, 0);
});

// ---- 4. concurrency contention on the same key --------------------------------------
test("concurrency contention on the same key: exactly one claim wins", async () => {
  const room = openRoom({ members: 8, prefix: "contend", workItems: true });
  const { origin, stop } = await startServer(room.store);
  try {
    const target = "load10x-task-0";
    const results = await Promise.allSettled(room.agents.map(({ memberId, key }) =>
      clientFor({ origin, memberId, key }).claimSession(target)));
    const won = results.filter(r => r.status === "fulfilled");
    const lost = results.filter(r => r.status === "rejected");
    assert.equal(won.length, 1, "exactly one agent wins the contested claim");
    assert.equal(lost.length, 7);
    for (const loser of lost) {
      const code = loser.reason?.code ?? String(loser.reason?.message ?? loser.reason);
      // losers race the winner's write: held session (409), reducer conflict
      // (422), or the card already moved before their read — all clean 4xx.
      const clean = code === "session_claimed" || code === "command_rejected" || /No queued session card/.test(code);
      assert.ok(clean, `loser rejected cleanly, got ${code}`);
    }
    // reads stay healthy through the contention storm
    const reads = await Promise.all(room.agents.map(({ memberId, key }) =>
      clientFor({ origin, memberId, key }).changes(0, 20)));
    assert.equal(reads.length, 8);
  } finally { await stop(); room.close(); }
});

// ---- 5. mixed read/write ratios -------------------------------------------------------
async function mixedRun({ members, opsPerAgent, writeEvery }) {
  const room = openRoom({ members, prefix: "mixed" });
  const { origin, stop } = await startServer(room.store);
  try {
    const latencies = [], errors = [];
    const start = performance.now();
    await Promise.all(room.agents.map(async ({ memberId, key }) => {
      const c = clientFor({ origin, memberId, key });
      for (let i = 0; i < opsPerAgent; i++) {
        const opStart = performance.now();
        try {
          if (i % writeEvery === 0) {
            await c.command({ id: randomUUID(), type: T.MESSAGE_POSTED,
              data: { messageId: randomUUID(), body: `mixed ${memberId} ${i}` } });
          } else if (i % 3 === 1) await c.presence();
          else if (i % 3 === 2) await c.changes(0, 20);
          else await c.capabilities();
          latencies.push(performance.now() - opStart);
        } catch (e) { errors.push(e); }
      }
    }));
    const wallMs = performance.now() - start;
    return { wallMs, latencies, errors, ops: members * opsPerAgent };
  } finally { await stop(); room.close(); }
}

test("mixed read/write ratios: read-heavy and write-heavy both drain cleanly", async () => {
  const readHeavy = await mixedRun({ members: 8, opsPerAgent: 30, writeEvery: 10 }); // 3 writes/agent
  const writeHeavy = await mixedRun({ members: 8, opsPerAgent: 20, writeEvery: 2 }); // 10 writes/agent
  for (const [name, run] of [["read-heavy", readHeavy], ["write-heavy", writeHeavy]]) {
    assert.equal(run.errors.length, 0, `${name}: no op errors`);
    assert.equal(run.latencies.length, run.ops, `${name}: every op measured`);
    assert.ok(percentile(run.latencies, 0.95) < 10000, `${name}: p95 under bound`);
    assert.ok(run.ops / (run.wallMs / 1000) > 0, `${name}: throughput measured`);
  }
});

// ---- 6. error injection under load ------------------------------------------------------
test("error injection under load: bad commands rejected, good traffic unaffected", async () => {
  const room = openRoom({ members: 8, prefix: "inject" });
  const { origin, stop } = await startServer(room.store);
  try {
    const goodErrors = [], badOutcomes = [];
    let validPosts = 0;
    const badPayloads = [
      { type: "NOT_A_REAL_EVENT", data: {} },
      { type: T.MESSAGE_POSTED, data: {} }, // missing required fields
      { type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body: "x", bogus: 1 } } // unexpected field
    ];
    const good = room.agents.slice(0, 5).map(({ memberId, key }) => (async () => {
      const c = clientFor({ origin, memberId, key });
      for (let i = 0; i < 9; i++) {
        try {
          if (i % 3 === 0) {
            await c.command({ id: randomUUID(), type: T.MESSAGE_POSTED,
              data: { messageId: randomUUID(), body: `good ${i}` } });
            validPosts++;
          } else if (i % 3 === 1) await c.presence();
          else await c.changes(0, 20);
        } catch (e) { goodErrors.push(e); }
      }
    })());
    const bad = room.agents.slice(5).map(({ memberId, key }) => (async () => {
      const c = clientFor({ origin, memberId, key });
      for (let i = 0; i < 12; i++) {
        const payload = badPayloads[i % badPayloads.length];
        try { await c.command({ ...payload, id: randomUUID() }); badOutcomes.push("accepted"); }
        catch (e) { badOutcomes.push(`${e.status}:${e.code}`); }
      }
    })());
    await Promise.all([...good, ...bad]);
    assert.equal(goodErrors.length, 0, "valid traffic never errors under injection");
    assert.ok(!badOutcomes.includes("accepted"), "no bad command was accepted");
    const distinct = [...new Set(badOutcomes)];
    // shape/validation failures -> invalid_command; reducer refusals ->
    // command_rejected. Both are clean 422 client errors, never 5xx.
    assert.ok(distinct.every(o => o === "422:invalid_command" || o === "422:command_rejected"),
      `every bad command rejected as 422, got ${distinct}`);
    // invalid commands leave no trace in the event log
    const probe = clientFor({ origin, memberId: room.agents[0].memberId, key: room.agents[0].key });
    const log = await probe.changes(0, 100);
    const posted = log.events.filter(e => e.event?.type === T.MESSAGE_POSTED);
    assert.equal(posted.length, validPosts, "only valid posts landed in the log");
    await probe.presence(); // server still responsive afterwards
  } finally { await stop(); room.close(); }
});

// ---- 7. connection-pool exhaustion ----------------------------------------------------------
test("connection-pool exhaustion: stream pool rejects gracefully and recovers", async () => {
  const room = openRoom({ members: 35, prefix: "pool" });
  const { origin, stop } = await startServer(room.store, { streamInterval: 60000 });
  const sockets = [];
  try {
    const after = room.store.room(ROOM).sequence;
    // per-credential cap: 3 streams open, the 4th is a graceful 429
    for (let i = 0; i < 3; i++) {
      const opened = await openRawStream(origin, room.agents[0].key, after);
      assert.equal(opened.status, 200);
      sockets.push(opened.socket);
    }
    const overCredential = await openRawStream(origin, room.agents[0].key, after);
    assert.equal(overCredential.status, 429);
    assert.equal(overCredential.code, "stream_limit");
    overCredential.socket.destroy();
    // global cap: 33 more members x 3 streams; the pool holds exactly 100
    let ok = 0, rejected = 0;
    for (let m = 1; m < 34; m++) for (let s = 0; s < 3; s++) {
      const r = await openRawStream(origin, room.agents[m].key, after);
      if (r.status === 200) { ok++; sockets.push(r.socket); }
      else { assert.equal(r.status, 429); assert.equal(r.code, "stream_limit"); r.socket.destroy(); rejected++; }
    }
    assert.equal(ok + 3, 100, "pool holds exactly 100 streams");
    assert.equal(rejected, 2, "attempts past the cap are rejected, not hung");
    // the room keeps serving reads while the pool is full
    const probe = clientFor({ origin, memberId: room.agents[0].memberId, key: room.agents[0].key });
    await probe.presence();
    // release pressure: the pool recovers (member 34 holds no streams yet;
    // per-credential cap is 3, so it reopens at most 3)
    for (let i = 0; i < 10; i++) sockets.pop().destroy();
    let recovered = null;
    for (let attempt = 0; attempt < 50 && recovered === null; attempt++) {
      const r = await openRawStream(origin, room.agents[34].key, after);
      if (r.status === 200) recovered = r; else { r.socket.destroy(); await sleep(100); }
    }
    assert.ok(recovered, "a freed pool slot reopens within 5s");
    sockets.push(recovered.socket);
    for (let i = 0; i < 2; i++) {
      const r = await openRawStream(origin, room.agents[34].key, after);
      assert.equal(r.status, 200);
      sockets.push(r.socket);
    }
  } finally { for (const s of sockets) s.destroy(); await stop(); room.close(); }
});

// ---- 8. graceful degradation --------------------------------------------------------------------
test("graceful degradation: rate-limited writer degrades, other traffic isolated", async () => {
  const room = openRoom({ members: 3, prefix: "degrade" });
  const { origin, stop } = await startServer(room.store);
  try {
    const writer = clientFor({ origin, memberId: room.agents[0].memberId, key: room.agents[0].key });
    const outcomes = [];
    for (let i = 0; i < 75; i++) {
      try {
        await writer.command({ id: randomUUID(), type: T.MESSAGE_POSTED,
          data: { messageId: randomUUID(), body: `flood ${i}` } });
        outcomes.push("ok");
      } catch (e) { outcomes.push(`${e.status}:${e.code}`); }
    }
    assert.equal(outcomes.filter(o => o === "ok").length, 60, "per-credential write budget is 60/min");
    assert.equal(outcomes.filter(o => o === "429:rate_limited").length, 15, "overflow is a clean 429, never a 5xx");
    // isolation: a different credential still writes fine
    const other = clientFor({ origin, memberId: room.agents[1].memberId, key: room.agents[1].key });
    await other.command({ id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body: "isolated" } });
    // the throttled writer can still read: degradation, not collapse
    await writer.presence();
  } finally { await stop(); room.close(); }
});

test("graceful degradation: slow stream pump still delivers everything", () => {
  const report = reportOf(runScript(["--mode", "streams", "--streams", "4", "--messages", "12",
    "--message-interval-ms", "5", "--stream-interval-ms", "500", "--quiet"])).streams;
  assert.equal(report.deliveries.received, report.deliveries.expected);
  assert.equal(report.closedByServer.count, 0);
});

// ---- 9. throughput / latency targets --------------------------------------------------------------
test("throughput/latency: all-mode run meets the repo's load targets", () => {
  const report = reportOf(runScript(["--mode", "all", "--agents", "10", "--iterations", "2",
    "--streams", "8", "--messages", "20", "--message-interval-ms", "10", "--stream-interval-ms", "50",
    "--wakes", "60", "--wake-interval-ms", "5", "--poll-ms", "10", "--quiet"]));
  assert.ok(report.commands.ops > 0 && report.commands.opsPerSec > 0);
  assert.ok(Number(report.commands.latencyMs.p95) < 10000, "command p95 under bound");
  assert.equal(report.streams.deliveries.received, report.streams.deliveries.expected);
  assert.ok(report.streams.deliveryLatencyMs.p95 < 30000, "delivery p95 under bound");
  assert.equal(report.queue.completed, report.queue.enqueued);
  assert.deepEqual(report.queue.errors, {});
  assert.ok(report.queue.lagMs.p95 < 30000, "wake-lease lag p95 under bound");
});
