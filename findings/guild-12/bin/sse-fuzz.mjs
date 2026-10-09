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

async function boot({ streamInterval = 15, streamQueueCap = 65536 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "g12-fuzz-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const server = createRoomServer({ store, streamInterval, streamQueueCap });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const keys = { owner: store.issueAccessKey("commons", "owner") };
  const live = { sockets: [], readers: [], controllers: [] };
  const close = async () => {
    for (const s of live.sockets) s.destroy();
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
async function openStalled(ctx, after, key) {
  const socket = connect(ctx.port, "127.0.0.1"); ctx.live.sockets.push(socket);
  await new Promise((res, rej) => { socket.once("connect", res); socket.once("error", rej); });
  socket.write(`GET /api/rooms/commons/stream?after=${after} HTTP/1.1\r\nHost: 127.0.0.1:${ctx.port}\r\nAuthorization: Bearer ${key}\r\nAccept: text/event-stream\r\n\r\n`);
  const head = await new Promise(res => socket.once("data", c => res(c.toString("utf8"))));
  if (!/^HTTP\/1\.1 200 /.test(head)) bad(`stalled open got: ${head.split("\r\n")[0]}`);
  socket.pause();
  return socket;
}

async function openReading(ctx, after, key, { signalMs = 30000 } = {}) {
  const controller = new AbortController(); ctx.live.controllers.push(controller);
  const response = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=${after}`,
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
  try {
    const start = ctx.store.room("commons").sequence;
    const stalled = await openStalled(ctx, start, ctx.keys.owner);
    const reading = await openReading(ctx, start, ctx.keys.owner);
    let produced = 0, lagged = false;
    const t0 = Date.now();
    for (let b = 0; b < 250 && !lagged; b++) {
      ctx.store.transaction(() => { for (let i = 0; i < 40; i++) { ctx.store.command(ctx.keys.owner, "commons", post()); produced++; } });
      await sleep(30);
      lagged = await new Promise(res => {
        let raw = "";
        const onData = c => { raw += c.toString("utf8"); if (raw.includes("event: stream_lagging")) { stalled.off("data", onData); res(true); } };
        stalled.on("data", onData); stalled.resume(); stalled.pause();
        setTimeout(() => { stalled.off("data", onData); res(raw.includes("event: stream_lagging")); }, 50);
      }).catch(() => false);
      // check close by polling: server destroys socket after STREAM_DRAIN_GRACE_MS
    }
    if (!lagged) bad(`no stream_lagging after ${produced} events`);
    const closed = await new Promise(res => { stalled.once("close", () => res(true)); setTimeout(() => res(false), 8000); });
    await sleep(300);
    // peer still healthy: post and read
    ctx.store.command(ctx.keys.owner, "commons", post());
    await sleep(500);
    const peerIds = reading.received.ids;
    if (!peerIds.length) bad("reading peer received nothing");
    if (!closed) bad("stalled socket not destroyed after lagging");
    ok(`lagging event after ~${produced} events, socket dropped=${closed} in ${Date.now() - t0}ms, peer got ${peerIds.length} events`);
  } finally { await ctx.close(); }
}

async function F2() { // disconnect mid-stream storm: 200 rapid open/abort, no slot leak
  const ctx = await boot();
  try {
    for (let i = 0; i < 200; i++) {
      const r = await openReading(ctx, ctx.store.room("commons").sequence, ctx.keys.owner);
      if (r.status === 200) { await sleep(2); r.controller.abort(); }
      else bad(`storm iteration ${i}: status ${r.status}`);
    }
    await sleep(500);
    const a = await openReading(ctx, 0, ctx.keys.owner);
    const b = await openReading(ctx, 0, ctx.keys.owner);
    const c = await openReading(ctx, 0, ctx.keys.owner);
    if (a.status !== 200 || b.status !== 200 || c.status !== 200) bad("slots leaked after storm");
    const d = await openReading(ctx, 0, ctx.keys.owner);
    if (d.status !== 429) bad(`4th stream after storm: expected 429, got ${d.status}`);
    ok("200 open/abort cycles, 3 slots reusable, 4th correctly 429");
  } finally { await ctx.close(); }
}

async function F3() { // valid Last-Event-ID resume
  const ctx = await boot();
  try {
    for (let i = 0; i < 5; i++) ctx.store.command(ctx.keys.owner, "commons", post());
    const seq = ctx.store.room("commons").sequence;
    const r = await openReading(ctx, seq - 2, ctx.keys.owner);
    await sleep(800);
    const got = r.received.ids;
    if (!got.length || Math.min(...got) <= seq - 2) bad(`resume got ids ${got.slice(0, 5)}; expected all > ${seq - 2}`);
    // resume from the very tip: no room events, only heartbeats
    const tip = await openReading(ctx, seq, ctx.keys.owner);
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
      { headers: { Authorization: `Bearer ${ctx.keys.owner}` }, signal: AbortSignal.timeout(10000) });
    const body = await res.text().catch(() => "");
    // eventsAfter rejects 409 cursor_ahead before writeHead -> JSON error, no hang
    if (![409, 422].includes(res.status)) bad(`future cursor: status ${res.status}, body ${body.slice(0, 120)}`);
    const healthy = await openReading(ctx, 0, ctx.keys.owner);
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
        { headers: { Authorization: `Bearer ${ctx.keys.owner}` }, signal: AbortSignal.timeout(10000) });
      await res.text().catch(() => {});
      if (res.status === 500) bad(`garbage cursor ${JSON.stringify(p.slice(0, 20))} -> 500`);
      if (![200, 400, 401, 403, 404, 409, 422, 429].includes(res.status)) bad(`garbage cursor ${JSON.stringify(p.slice(0, 20))} -> unexpected ${res.status}`);
    }
    const healthy = await openReading(ctx, 0, ctx.keys.owner);
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
    r = await fetch(`${ctx.origin}/api/rooms/no-such-room/stream?after=0`, { headers: { Authorization: `Bearer ${ctx.keys.owner}` }, signal: AbortSignal.timeout(10000) });
    checks.push(["bad-room", r.status === 404 || r.status === 403]);
    r = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`, { method: "POST", headers: { Authorization: `Bearer ${ctx.keys.owner}` }, signal: AbortSignal.timeout(10000) });
    checks.push(["post-stream", r.status === 405 || r.status === 403]);
    // Last-Event-ID header precedence over query param
    for (let i = 0; i < 3; i++) ctx.store.command(ctx.keys.owner, "commons", post());
    const seq = ctx.store.room("commons").sequence;
    const hdr = await openReading(ctx, 0, ctx.keys.owner); // placeholder, replaced below
    hdr.controller.abort();
    const ctrl = new AbortController(); ctx.live.controllers.push(ctrl);
    const res = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`,
      { headers: { Authorization: `Bearer ${ctx.keys.owner}`, "Last-Event-ID": String(seq) }, signal: ctrl.signal });
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

async function openMany(ctx, count, { read = false } = {}) {
  // 3 streams per credential; returns { ok200, rejected }
  const creds = [];
  for (let i = 0; i < Math.ceil(count / 3); i++) creds.push(ctx.store.issueAccessKey("commons", "owner"));
  let ok200 = 0, rejected = 0;
  const readers = [];
  await Promise.all(creds.flatMap((key, ci) =>
    [0, 1, 2].map(async si => {
      const idx = ci * 3 + si;
      if (idx >= count) return;
      try {
        const controller = new AbortController(); ctx.live.controllers.push(controller);
        const res = await fetch(`${ctx.origin}/api/rooms/commons/stream?after=0`,
          { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        if (res.status === 200) { ok200++; if (read) { const rd = res.body.getReader(); readers.push(rd); ctx.live.readers.push(rd); (async () => { for (;;) { const { done } = await rd.read(); if (done) return; } })().catch(() => {}); } else { res.body.cancel().catch(() => {}); controller.abort(); } }
        else { rejected++; await res.text().catch(() => {}); }
      } catch { rejected++; }
    })));
  return { ok200, rejected };
}

async function F11() { await loadN(300, "F11"); }
async function F12() { await loadN(500, "F12"); }

async function loadN(n, label) {
  const ctx = await boot();
  try {
    const meter = lagMeter();
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    const { ok200, rejected } = await openMany(ctx, n);
    const wall = Date.now() - t0;
    const lag = meter.stop();
    const cpu1 = process.cpuUsage(cpu0);
    const cpuMs = Math.round((cpu1.user + cpu1.system) / 1000);
    // global cap is 100 streams: exactly 100 accepted, rest 429
    if (ok200 !== 100) bad(`${label}: expected 100 accepted, got ${ok200} (rejected ${rejected})`);
    // server still responsive afterwards
    const probe = await openReading(ctx, 0, ctx.keys.owner);
    if (probe.status !== 429 && probe.status !== 200) bad(`${label}: post-load probe status ${probe.status}`);
    try { probe.controller.abort(); } catch {}
    ok(`${n} attempts: 100 accepted/${rejected} rejected in ${wall}ms, event-loop lag max=${lag.max}ms p99=${lag.p99}ms, cpu=${cpuMs}ms`);
  } finally { await ctx.close(); }
}

async function F13() { // broadcast storm: 100 streams, 300 events, all delivered
  const ctx = await boot();
  try {
    const readers = [];
    for (let i = 0; i < 34; i++) {
      const key = ctx.store.issueAccessKey("commons", "owner");
      for (let s = 0; s < 3; s++) {
        const r = await openReading(ctx, ctx.store.room("commons").sequence, key);
        if (r.status === 200) readers.push(r);
      }
    }
    if (readers.length < 90) bad(`only ${readers.length} streams opened`);
    const N = 300;
    for (let i = 0; i < N; i++) ctx.store.command(ctx.keys.owner, "commons", post());
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
  try {
    const start = ctx.store.room("commons").sequence;
    const stalled = await openStalled(ctx, start, ctx.keys.owner);
    const readers = [];
    for (let i = 0; i < 5; i++) readers.push(await openReading(ctx, start, ctx.store.issueAccessKey("commons", "owner")));
    let produced = 0, lagged = false;
    for (let b = 0; b < 250 && !lagged; b++) {
      ctx.store.transaction(() => { for (let i = 0; i < 40; i++) { ctx.store.command(ctx.keys.owner, "commons", post()); produced++; } });
      await sleep(30);
      lagged = await new Promise(res => {
        let raw = "";
        const onData = c => { raw += c.toString("utf8"); if (raw.includes("event: stream_lagging")) { stalled.off("data", onData); res(true); } };
        stalled.on("data", onData); stalled.resume(); stalled.pause();
        setTimeout(() => { stalled.off("data", onData); res(raw.includes("event: stream_lagging")); }, 50);
      }).catch(() => false);
    }
    if (!lagged) bad("stalled consumer never lagged");
    await sleep(500);
    // post more; readers must keep receiving
    const mark = readers.map(r => r.received.ids.length);
    for (let i = 0; i < 20; i++) ctx.store.command(ctx.keys.owner, "commons", post());
    await sleep(800);
    const after = readers.map(r => r.received.ids.length);
    const stuck = after.filter((n, i) => n <= mark[i]);
    for (const r of readers) try { r.controller.abort(); } catch {}
    if (stuck.length) bad(`${stuck.length}/5 readers stalled after lagging-drop`);
    ok(`stalled dropped after ~${produced} events; all 5 readers kept receiving`);
  } finally { await ctx.close(); }
}

async function F15() { // chaos: everything at once, room must stay healthy
  const ctx = await boot({ streamQueueCap: 32 * 1024 });
  try {
    const t0 = Date.now();
    const readers = [];
    for (let i = 0; i < 10; i++) readers.push(await openReading(ctx, 0, ctx.store.issueAccessKey("commons", "owner")));
    const stalled = await openStalled(ctx, 0, ctx.keys.owner);
    const jobs = [];
    jobs.push((async () => { for (let i = 0; i < 300; i++) { ctx.store.command(ctx.keys.owner, "commons", post()); if (i % 30 === 0) await sleep(5); } })());
    jobs.push((async () => { for (let i = 0; i < 60; i++) { const r = await openReading(ctx, 0, ctx.store.issueAccessKey("commons", "owner")); await sleep(3); try { r.controller.abort(); } catch {} } })());
    jobs.push((async () => { for (let i = 0; i < 20; i++) { const k = ctx.store.issueAccessKey("commons", "owner"); ctx.store.wakeQueue.pause(k, "commons", { requestId: randomUUID(), reason: "chaos" }); ctx.store.wakeQueue.resume(k, "commons", { requestId: randomUUID() }); } })());
    await Promise.all(jobs);
    await sleep(1000);
    // room healthy? post one message and read it back on a fresh stream
    const before = ctx.store.room("commons").sequence;
    ctx.store.command(ctx.keys.owner, "commons", post());
    const probe = await openReading(ctx, before, ctx.keys.owner);
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
