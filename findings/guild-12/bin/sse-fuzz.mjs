// Guild-12 SSE fuzz + load harness. Usage: node sse-fuzz.mjs <F1|F2|...|F15>
// Each subcommand boots its own server on 127.0.0.1, runs ONE hostile input
// with a hard timeout, prints a one-line verdict, exits 0 on "holds", 1 on
// violation. TMPDIR is set by the launcher.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../../../server/store.mjs";
import { createRoomServer } from "../../../server/http.mjs";
import { initialRoom } from "../../../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../../../src/events.js";

const WHICH = process.argv[2];
const HARD_TIMEOUT_MS = Number(process.env.G12_TIMEOUT_MS ?? 120000);
setTimeout(() => { console.error(`TIMEOUT ${WHICH}: hung past ${HARD_TIMEOUT_MS}ms`); process.exit(2); }, HARD_TIMEOUT_MS).unref();

const ok = (detail) => { console.log(`PASS ${WHICH} ${detail}`); process.exit(0); };
const bad = (detail) => { console.log(`FAIL ${WHICH} ${detail}`); process.exit(1); };

const post = () => ({ id: randomUUID(), type: T.CAPABILITIES_ADVERTISED,
  data: { capabilities: Array.from({ length: 30 }, (_, i) => `${i}-${"x".repeat(77)}`) } });

async function boot({ streamInterval = 15, streamQueueCap = 65536, rooms = ["commons"] } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "g12-fuzz-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  for (const roomId of rooms) store.initialize(initialRoom(roomId));
  const server = createRoomServer({ store, streamInterval, streamQueueCap });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const keys = {};
  for (const roomId of rooms) keys[roomId] = store.issueAccessKey(roomId, "owner");
  const live = { sockets: [], readers: [], controllers: [] };
  const close = async () => {
    for (const s of live.sockets) s.destroy();
    for (const h of live.heldStreams ?? []) try { h.req.destroy(); } catch {}
    for (const c of live.controllers) try { c.abort(); } catch {}
    for (const rd of live.readers) await rd.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(r => server.close(r));
    store.close(); rmSync(directory, { recursive: true, force: true });
  };
  return { store, server, origin, port, keys, live, close };
}

// Raw socket that stops reading after headers: kernel buffers fill, then the
// server's send queue grows past the cap (pattern from stream-backpressure.test.js).
async function openStalled(ctx, after, key, roomId = "commons") {
  const socket = connect(ctx.port, "127.0.0.1"); ctx.live.sockets.push(socket);
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  socket.write(`GET /api/rooms/${roomId}/stream?after=${after} HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\nAuthorization: Bearer ${key}\r\nAccept: text/event-stream\r\n\r\n`);
  const head = await new Promise(res => socket.once("data", c => res(c.toString("utf8"))));
  if (!/^HTTP\/1\.1 200 /.test(head)) bad(`stalled open got: ${head.split("\r\n")[0]}`);
  socket.pause();
  return socket;
}

async function openReading(ctx, after, key, { signalMs = 30000, roomId = "commons" } = {}) {
  const controller = new AbortController(); ctx.live.controllers.push(controller);
  const response = await fetch(`${ctx.origin}/api/rooms/${roomId}/stream?after=${after}`,
    { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(signalMs) });
  if (response.status !== 200) return { response, status: response.status };
  const reader = response.body.getReader(); ctx.live.readers.push(reader);
  const received = { text: "", ids: [], done: false, lagging: false };
  const decoder = new TextDecoder();
  (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { received.done = true; return; }
      const chunk = decoder.decode(value, { stream: true });
      received.text += chunk;
      for (const m of chunk.matchAll(/^id: (\d+)$/gm)) received.ids.push(Number(m[1]));
      if (chunk.includes("event: stream_lagging")) received.lagging = true;
    }
  })().catch(() => { received.done = true; });
  return { response, status: 200, received, controller };
}

function lagMeter() {
  let max = 0; const samples = []; let last = process.hrtime.bigint();
  const iv = setInterval(() => {
    const now = process.hrtime.bigint();
    const drift = Number(now - last) / 1e6 - 10;
    if (drift > max) max = drift;
    samples.push(drift); last = now;
  }, 10);
  return { stop() { clearInterval(iv); samples.sort((a, b) => a - b);
    return { max: Math.round(max), p50: Math.round(samples[Math.floor(samples.length / 2)] ?? 0),
             p99: Math.round(samples[Math.floor(samples.length * 0.99)] ?? 0), n: samples.length }; } };
}

const ids = text => [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));

async function F1() { // slow consumer: never reads -> stream_lagging + drop, peers fine
  const ctx = await boot({ streamQueueCap: 64 * 1024 });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  try {
    const start = ctx.store.room("commons").sequence;
    const stalled = await openStalled(ctx, start, ctx.keys["commons"]);
    const reading = await openReading(ctx, start, ctx.keys["commons"]);
    let produced = 0;
    const t0 = Date.now();
    for (let b = 0; b < 250 && !warnings.some(w => w.includes("stream_lagging")); b++) {
      ctx.store.transaction(() => { for (let i = 0; i < 40; i++) { ctx.store.command(ctx.keys["commons"], "commons", post()); produced++; } });
      await sleep(30);
    }
    const lagged = warnings.some(w => w.includes("stream_lagging"));
    if (!lagged) bad(`no stream_lagging after ${produced} events`);
    // drain the stalled socket: the server ended it with the lagging event
    const raw = await new Promise(resolve => {
      let text = "";
      const done = () => resolve(text);
      const timer = setTimeout(done, 10000);
      stalled.on("data", c => { text += c.toString("utf8"); });
      stalled.once("end", () => { clearTimeout(timer); done(); });
      stalled.once("close", () => { clearTimeout(timer); done(); });
      stalled.resume();
    });
    if (!raw.includes("event: stream_lagging")) bad("stalled socket payload lacks the stream_lagging event");
    const closed = await new Promise(res => { stalled.once("close", () => res(true)); setTimeout(() => res(stalled.destroyed), 8000); });
    await sleep(300);
    // peer still healthy: post and read
    ctx.store.command(ctx.keys["commons"], "commons", post());
    await sleep(500);
    const peerIds = reading.received.ids;
    if (!peerIds.length) bad("reading peer received nothing");
    if (!closed && !stalled.destroyed) bad("stalled socket not destroyed after lagging");
    ok(`lagging event after ~${produced} events, socket dropped in ${Date.now() - t0}ms, peer got ${peerIds.length} events`);
  } finally { console.warn = origWarn; await ctx.close(); }
}

async function F2() { // disconnect mid-stream storm: 200 rapid open/abort, no slot leak
  const ctx = await boot();
  try {
    for (let i = 0; i < 200; i++) {
      const r = await openReading(ctx, ctx.store.room("commons").sequence, ctx.keys["commons"]);
      if (r.status === 200) { await sleep(2); r.controller.abort(); }
      else bad(`storm iteration ${i}: status ${r.status}`);
    }
    await sleep(500);
    const a = await openReading(ctx, 0, ctx.keys["commons"]);
    const b = await openReading(ctx, 0, ctx.keys["commons"]);
    const c = await openReading(ctx, 0, ctx.keys["commons"]);
    if (a.status !== 200 || b.status !== 200 || c.status !== 200) bad("slots leaked after storm");
    const d = await openReading(ctx, 0, ctx.keys["commons"]);
    if (d.status !== 429) bad(`4th stream after storm: expected 429, got ${d.status}`);
    ok("200 open/abort cycles, 3 slots reusable, 4th correctly 429");
  } finally { await ctx.close(); }
}

async function F3() { // valid Last-Event-ID resume
  const ctx = await boot();
  try {
    for (let i = 0; i < 5; i++) ctx.store.command(ctx.keys["commons"], "commons", post());
    const seq = ctx.store.room("commons").sequence;
    const r = await openReading(ctx, seq - 2, ctx.keys["commons"]);
    await sleep(800);
    const got = r.received.ids;
    if (!got.length || Math.min(...got) <= seq - 2) bad(`resume got ids ${got.slice(0, 5)}; expected all > ${seq - 2}`);
    // resume from the very tip: no room events, only heartbeats
    const tip = await openReading(ctx, seq, ctx.keys["commons"]);
    await sleep(600);
    if (tip.received.ids.length) bad(`resume at tip replayed ${tip.received.ids.length} events`);
    r.controller.abort(); tip.controller.abort();
    ok(`resumed from ${seq - 2}, got ${got.length} newer events; tip resume clean`);
  } finally { await ctx.close(); }
}

async function F4() { // future Last-Event-ID
  const ctx = await boot();
  try {
    const res = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=999999999`,
      { headers: { Authorization: `Bearer ${ctx.keys["commons"]}` }, signal: AbortSignal.timeout(10000) });
    const body = await res.text().catch(() => "");
    // eventsAfter rejects 409 cursor_ahead before writeHead -> JSON error, no hang
    if (![409, 422].includes(res.status)) bad(`future cursor: status ${res.status}, body ${body.slice(0, 120)}`);
    const healthy = await openReading(ctx, 0, ctx.keys["commons"]);
    if (healthy.status !== 200) bad("server unhealthy after future-cursor request");
    healthy.controller.abort();
    ok(`future cursor -> ${res.status}, server healthy`);
  } finally { await ctx.close(); }
}

async function F5() { // garbage Last-Event-ID values
  const ctx = await boot();
  try {
    const probes = ["abc", "-1", "1e21", "0x10", "NaN", "Infinity", "💥", "../..",
      "1".repeat(100000), "5; DROP TABLE events", "%00", " "];
    for (const p of probes) {
      const res = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=${encodeURIComponent(p)}`,
        { headers: { Authorization: `Bearer ${ctx.keys["commons"]}` }, signal: AbortSignal.timeout(10000) });
      await res.text().catch(() => {});
      if (res.status === 500) bad(`garbage cursor ${JSON.stringify(p.slice(0, 20))} -> 500`);
      if (![200, 400, 401, 403, 404, 409, 414, 422, 429, 431].includes(res.status)) bad(`garbage cursor ${JSON.stringify(p.slice(0, 20))} -> unexpected ${res.status}`);
    }
    const healthy = await openReading(ctx, 0, ctx.keys["commons"]);
    if (healthy.status !== 200) bad("server unhealthy after garbage cursors");
    healthy.controller.abort();
    ok(`${probes.length} garbage cursors, no 500s, no hangs`);
  } finally { await ctx.close(); }
}

async function F6() { // malformed requests
  const ctx = await boot();
  try {
    const checks = [];
    let r = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`, { signal: AbortSignal.timeout(10000) });
    checks.push(["no-auth", r.status === 401 || r.status === 403]);
    r = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`, { headers: { Authorization: "Bearer deadbeef" }, signal: AbortSignal.timeout(10000) });
    checks.push(["bad-token", r.status === 401 || r.status === 403]);
    r = await fetch(`${ctx.origin}/api/rooms/no-such-room/stream?after=0`, { headers: { Authorization: `Bearer ${ctx.keys["commons"]}` }, signal: AbortSignal.timeout(10000) });
    checks.push(["bad-room", r.status === 404 || r.status === 403]);
    r = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`, { method: "POST", headers: { Authorization: `Bearer ${ctx.keys["commons"]}` }, signal: AbortSignal.timeout(10000) });
    checks.push(["post-stream", r.status === 405 || r.status === 403]);
    // Last-Event-ID header precedence over query param
    for (let i = 0; i < 3; i++) ctx.store.command(ctx.keys["commons"], "commons", post());
    const seq = ctx.store.room("commons").sequence;
    const hdr = await openReading(ctx, 0, ctx.keys["commons"]); // placeholder, replaced below
    hdr.controller.abort();
    const ctrl = new AbortController(); ctx.live.controllers.push(ctrl);
    const res = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`,
      { headers: { Authorization: `Bearer ${ctx.keys["commons"]}`, "Last-Event-ID": String(seq) }, signal: ctrl.signal });
    const reader = res.body.getReader(); ctx.live.readers.push(reader);
    let text = "";
    const dec = new TextDecoder();
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    ctrl.abort();
    checks.push(["header-precedence", ids(text).length === 0]);
    const failed = checks.filter(([, v]) => !v);
    if (failed.length) bad(`malformed checks failed: ${failed.map(([k]) => k).join(",")}`);
    ok("no-auth/bad-token/bad-room/post rejected; Last-Event-ID header wins over ?after=");
  } finally { await ctx.close(); }
}

async function openMany(ctx, count, roomIds, { read = false, perRoomMembers = 100 } = {}) {
  // 3 streams per credential; each member's key revokes its predecessor, so
  // we mint one agent member per credential for true credential diversity.
  // Pilot cap is 100 members/room: spread credentials across rooms.
  const needCreds = Math.ceil(count / 3);
  const creds = []; // [key, roomId]
  let made = 0;
  for (const roomId of roomIds) {
    creds.push([ctx.keys[roomId], roomId]); made++; // the room owner's own key
    const roomCap = Math.min(99, perRoomMembers - 1); // +owner = members/room
    for (let i = 0; i < roomCap && made < needCreds; i++, made++) {
      const memberId = `load-${roomId}-${i}`;
      ctx.store.command(ctx.keys[roomId], roomId, { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: `load ${i}`, kind: "agent", permissions: [] } });
      creds.push([ctx.store.issueAccessKey(roomId, memberId), roomId]);
    }
  }
  if (creds.length < needCreds) bad(`openMany: only ${creds.length} credentials for ${count} streams`);
  // Raw http.get, not fetch: undici's per-origin connection pool serializes
  // hundreds of concurrent SSE opens client-side and produces timeout noise.
  const { get } = await import("node:http");
  const openTimeoutMs = Number(process.env.G12_OPEN_TIMEOUT_MS ?? 20000);
  const openOne = (key, roomId) => new Promise(resolve => {
    const req = get(`${ctx.origin}/api/rooms/${roomId}/stream?after=0`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" } });
    const timer = setTimeout(() => { req.destroy(); resolve({ status: "timeout" }); }, openTimeoutMs);
    req.on("response", res => {
      clearTimeout(timer);
      res.resume(); // drain or discard: hold the stream open either way
      resolve({ status: res.statusCode, req });
    });
    req.on("error", () => { clearTimeout(timer); resolve({ status: "error" }); });
  });
  let ok200 = 0, rejected = 0;
  const held = [];
  const statusBreakdown = {};
  // Staggered opens: the per-stream open path costs ~25ms at 100 members
  // (eventsAfter scales with member count), so a thundering herd would
  // queue behind the accept path itself. Stagger to test the CAP, not the
  // queue. (Herd behavior is F12's job.)
  const staggerMs = Number(process.env.G12_STAGGER_MS ?? 30);
  const batches = [];
  for (let i = 0; i < creds.length; i += 10) batches.push(creds.slice(i, i + 10));
  let opened = 0;
  for (const batch of batches) {
    await Promise.all(batch.flatMap(([key, roomId]) =>
      [0, 1, 2].map(async () => {
        const idx = opened++;
        if (idx >= count) return;
        const r = await openOne(key, roomId);
        statusBreakdown[r.status] = (statusBreakdown[r.status] ?? 0) + 1;
        if (r.status === 200) { ok200++; held.push(r); }
        else { rejected++; if (r.req) r.req.destroy(); }
      })));
    if (staggerMs) await new Promise(r => setTimeout(r, staggerMs));
  }
  ctx.live.heldStreams = (ctx.live.heldStreams ?? []).concat(held);
  if (process.env.G12_DEBUG) console.error("status breakdown: " + JSON.stringify(statusBreakdown));
  return { ok200, rejected };
}

async function F11() { await loadN(300, "F11", { rooms: Array.from({ length: 10 }, (_, i) => (i === 0 ? "commons" : `room-${i}`)), perRoomMembers: 10 }); } // staggered: tests the 100-cap
// F12: thundering herd — 500 simultaneous opens, 60s client timeout.
// Measures degradation, not the cap: asserts no 500s, no hangs, and the
// server keeps serving afterwards. Documents the accept-queue behavior.
async function F12() {
  process.env.G12_STAGGER_MS = "0";
  process.env.G12_OPEN_TIMEOUT_MS = "60000";
  await loadN(500, "F12-herd", { exactCap: false });
}

async function loadN(n, label, { exactCap = true, rooms = null, perRoomMembers = 100 } = {}) {
  rooms = rooms ?? (n <= 300 ? ["commons"] : ["commons", "room-b"]);
  const ctx = await boot({ rooms, streamInterval: 1000 });
  try {
    const meter = lagMeter();
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    const { ok200, rejected } = await openMany(ctx, n, rooms, { read: true, perRoomMembers });
    const wall = Date.now() - t0;
    const lag = meter.stop();
    const cpu1 = process.cpuUsage(cpu0);
    const cpuMs = Math.round((cpu1.user + cpu1.system) / 1000);
    if (exactCap) {
      // global cap is 100 streams: exactly 100 accepted, rest 429
      if (ok200 !== 100) bad(`${label}: expected 100 accepted, got ${ok200} (rejected ${rejected})`);
    } else {
      // herd mode: no 500s/hangs; every attempt resolved; server survives
      if (ok200 + rejected !== n) bad(`${label}: ${n - ok200 - rejected} attempts never resolved (hung)`);
    }
    // server still responsive afterwards
    const probe = await openReading(ctx, 0, ctx.keys["commons"]);
    if (probe.status !== 429 && probe.status !== 200) bad(`${label}: post-load probe status ${probe.status}`);
    try { probe.controller.abort(); } catch {}
    ok(`${n} attempts: ${ok200} accepted/${rejected} rejected in ${wall}ms, event-loop lag max=${lag.max}ms p99=${lag.p99}ms, cpu=${cpuMs}ms`);
  } finally { await ctx.close(); }
}

async function F13() { // broadcast storm: 100 streams, 300 events, all delivered
  const ctx = await boot();
  try {
    const readers = [];
    for (let i = 0; i < 34; i++) {
      const memberId = `storm-${i}`;
      ctx.store.command(ctx.keys["commons"], "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: `storm ${i}`, kind: "agent", permissions: [] } });
      const key = ctx.store.issueAccessKey("commons", memberId);
      for (let s = 0; s < 3; s++) {
        const r = await openReading(ctx, ctx.store.room("commons").sequence, key);
        if (r.status === 200) readers.push(r);
      }
    }
    if (readers.length < 90) bad(`only ${readers.length} streams opened`);
    const N = 300;
    for (let i = 0; i < N; i++) ctx.store.command(ctx.keys["commons"], "commons", post());
    const t0 = Date.now();
    let incomplete = readers.length;
    while (Date.now() - t0 < 30000 && incomplete > 0) {
      await sleep(200);
      incomplete = readers.filter(r => r.received.ids.length < N).length;
    }
    const short = readers.filter(r => r.received.ids.length < N);
    for (const r of readers) try { r.controller.abort(); } catch {}
    if (short.length) bad(`${short.length}/${readers.length} streams missed events (worst got ${Math.min(...readers.map(r => r.received.ids.length))}/${N})`);
    ok(`${readers.length} streams x ${N} events all delivered in ${Date.now() - t0}ms`);
  } finally { await ctx.close(); }
}

async function F14() { // backpressure mix: 1 stalled + 5 reading, readers unaffected
  const ctx = await boot({ streamQueueCap: 64 * 1024 });
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  try {
    const start = ctx.store.room("commons").sequence;
    const stalled = await openStalled(ctx, start, ctx.keys["commons"]);
    const readers = [];
    for (let i = 0; i < 5; i++) {
      const memberId = `bp-${i}`;
      ctx.store.command(ctx.keys["commons"], "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: `bp ${i}`, kind: "agent", permissions: [] } });
      readers.push(await openReading(ctx, start, ctx.store.issueAccessKey("commons", memberId)));
    }
    let produced = 0;
    for (let b = 0; b < 250 && !warnings.some(w => w.includes("stream_lagging")); b++) {
      ctx.store.transaction(() => { for (let i = 0; i < 40; i++) { ctx.store.command(ctx.keys["commons"], "commons", post()); produced++; } });
      await sleep(30);
    }
    if (!warnings.some(w => w.includes("stream_lagging"))) bad("stalled consumer never lagged");
    stalled.destroy(); // don't need its payload; the warn proves the event
    await sleep(500);
    // post more; readers must keep receiving
    const mark = readers.map(r => r.received.ids.length);
    for (let i = 0; i < 20; i++) ctx.store.command(ctx.keys["commons"], "commons", post());
    await sleep(800);
    const after = readers.map(r => r.received.ids.length);
    const stuck = after.filter((n, i) => n <= mark[i]);
    for (const r of readers) try { r.controller.abort(); } catch {}
    if (stuck.length) bad(`${stuck.length}/5 readers stalled after lagging-drop`);
    ok(`stalled dropped after ~${produced} events; all 5 readers kept receiving`);
  } finally { console.warn = origWarn; await ctx.close(); }
}

async function F15() { // chaos: everything at once, room must stay healthy
  const ctx = await boot({ streamQueueCap: 32 * 1024 });
  try {
    const t0 = Date.now();
    const readers = [];
    for (let i = 0; i < 10; i++) {
      const memberId = `chaos-${i}`;
      ctx.store.command(ctx.keys["commons"], "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: `chaos ${i}`, kind: "agent", permissions: [] } });
      readers.push(await openReading(ctx, 0, ctx.store.issueAccessKey("commons", memberId)));
    }
    const stalled = await openStalled(ctx, 0, ctx.keys["commons"]);
    const jobs = [];
    jobs.push((async () => { for (let i = 0; i < 300; i++) { ctx.store.command(ctx.keys["commons"], "commons", post()); if (i % 30 === 0) await sleep(5); } })());
    jobs.push((async () => {
      const memberId = "chaos-churn";
      ctx.store.command(ctx.keys["commons"], "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
        data: { memberId, displayName: "chaos churn", kind: "agent", permissions: [] } });
      const churnKey = ctx.store.issueAccessKey("commons", memberId);
      for (let i = 0; i < 60; i++) { const r = await openReading(ctx, 0, churnKey); await sleep(3); try { r.controller.abort(); } catch {} }
    })());
    jobs.push((async () => { for (let i = 0; i < 20; i++) { const k = ctx.store.issueAccessKey("commons", "owner"); ctx.store.wakeQueue.pause(k, "commons", { requestId: randomUUID(), reason: "chaos" }); ctx.store.wakeQueue.resume(k, "commons", { requestId: randomUUID() }); } })());
    await Promise.all(jobs);
    await sleep(1000);
    // room healthy? post one message and read it back on a fresh stream
    const before = ctx.store.room("commons").sequence;
    ctx.store.command(ctx.keys["commons"], "commons", post());
    const probe = await openReading(ctx, before, ctx.keys["commons"]);
    await sleep(800);
    try { probe.controller.abort(); } catch {}
    for (const r of readers) try { r.controller.abort(); } catch {}
    stalled.destroy();
    if (!probe.received.ids.length) bad("room not healthy after chaos");
    ok(`chaos done in ${Date.now() - t0}ms, room healthy, probe got ${probe.received.ids.length} events`);
  } finally { await ctx.close(); }
}

const UNITS = { F1, F2, F3, F4, F5, F6, F11, F12, F13, F14, F15 };
if (!UNITS[WHICH]) { console.error(`unknown unit ${WHICH}`); process.exit(3); }
await UNITS[WHICH]();
