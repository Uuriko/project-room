// Fail-first acceptance tests for FIX-54: read-only room telemetry collector
// with self-instrumentation (read-latency p50/p99, timeout rate,
// metric.surface_degraded alarm) and disk cursor checkpointing.
//
// Run: node --test tests/room-telemetry-collector.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import {
  SCHEMA_VERSION,
  percentile,
  summarizeReadLatencies,
  ReadWindow,
  TelemetryCollector,
  roomProbeFromEnvironment,
} from '../scripts/room-telemetry-collector.mjs';

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; return t; } };
}

function scriptedProbe(clock, { latencies = [5], events = [0] } = {}) {
  let i = 0, sequence = 1000, eventTotal = 0;
  return async () => {
    const lat = latencies[i % latencies.length];
    const ev = events[i % events.length];
    i += 1;
    clock.advance(lat);
    await Promise.resolve();
    eventTotal += ev;
    sequence += ev;
    return { sequence, eventCount: ev, eventCountTotal: eventTotal };
  };
}

function collectorOptions(clock, dir, overrides = {}) {
  return {
    clock: () => clock.now(),
    // Models elapsed time: yields to the event loop before advancing the
    // fake clock, so a promptly-settling probe always wins the timeout race
    // (microtasks drain before this macrotask) while a stuck probe loses it.
    sleeper: (ms) => new Promise(r => setImmediate(() => { clock.advance(ms); r(); })),
    checkpointPath: join(dir, 'checkpoint.json'),
    outputPath: join(dir, 'telemetry.jsonl'),
    options: overrides,
  };
}

function readJsonl(path) {
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

test('schema version is pinned', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('percentile: known arrays give exact p50/p99', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  // rank = (p/100)*(n-1); n=10 -> p50 rank 4.5 -> (50+60)/2 = 55
  assert.equal(percentile(sorted, 50), 55);
  // p99 rank 8.91 -> 90 + 0.91*10 = 99.1
  assert.equal(percentile(sorted, 99), 99.1);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([42], 99), 42);
  assert.throws(() => percentile([], 50), /empty/);
});

test('summarizeReadLatencies: 20/20-style fixture distribution in, correct p50/p99 out', () => {
  // 1..100 ms, a known uniform fixture distribution.
  const samples = Array.from({ length: 100 }, (_, i) => i + 1);
  const s = summarizeReadLatencies(samples);
  assert.equal(s.count, 100);
  assert.equal(s.min, 1);
  assert.equal(s.max, 100);
  assert.equal(s.mean, 50.5);
  // rank 49.5 -> 50.5
  assert.equal(s.p50, 50.5);
  // rank 98.01 -> 99.01
  assert.equal(s.p99, 99.01);
});

test('ReadWindow tracks reads, timeouts and timeout rate', () => {
  const w = new ReadWindow(50);
  const clock = fakeClock();
  for (let i = 0; i < 16; i++) w.push({ latencyMs: 10 + i, ok: true, timedOut: false, at: clock.now(), sequence: 1000 + i, eventCount: 0 });
  for (let i = 0; i < 4; i++) w.push({ latencyMs: 10000, ok: false, timedOut: true, at: clock.now(), sequence: 1016, eventCount: 0 });
  const st = w.stats(clock.now());
  assert.equal(st.reads, 20);
  assert.equal(st.timeouts, 4);
  assert.equal(st.timeoutRate, 0.2);
  assert.equal(st.latency.count, 16);
  assert.equal(st.latency.min, 10);
});

test('collector: controlled latency distribution yields correct p50/p99 in JSONL samples', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  const latencies = [4, 8, 12, 16, 20, 24, 28, 32, 36, 40];
  const probe = scriptedProbe(clock, { latencies });
  const c = new TelemetryCollector({ probe, ...collectorOptions(clock, dir, { emitEvery: 10, checkpointEvery: 100 }) });
  for (let i = 0; i < 10; i++) await c.tick();
  await c.checkpoint();
  const records = readJsonl(join(dir, 'telemetry.jsonl'));
  const samples = records.filter(r => r.kind === 'sample');
  assert.equal(samples.length, 1);
  const s = samples[0];
  assert.equal(s.v, 1);
  assert.equal(typeof s.ts, 'string');
  assert.equal(s.window.reads, 10);
  assert.equal(s.window.timeouts, 0);
  assert.equal(s.window.timeoutRate, 0);
  assert.equal(s.window.latency.p50, 22); // rank 4.5 -> (20+24)/2
  assert.equal(s.window.latency.p99, 39.64); // rank 8.91 -> 36 + 0.91*4
  assert.equal(s.self.probes, 10);
  assert.equal(s.self.timeouts, 0);
  assert.ok(s.self.uptimeMs >= 0);
  assert.ok(existsSync(join(dir, 'checkpoint.json')));
});

test('collector: injected timeout burst drives timeout rate and fires metric.surface_degraded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  const hang = async () => new Promise(() => {}); // never settles
  const c = new TelemetryCollector({
    probe: hang,
    ...collectorOptions(clock, dir, {
      readTimeoutMs: 50, minSamplesForAlarm: 4, degradedTimeoutRate: 0.5,
      degradedP99Ms: 10_000, emitEvery: 100, checkpointEvery: 100,
    }),
  });
  for (let i = 0; i < 4; i++) await c.tick();
  const records = readJsonl(join(dir, 'telemetry.jsonl'));
  const alarms = records.filter(r => r.kind === 'alarm' && r.alarm === 'metric.surface_degraded');
  assert.equal(alarms.length, 1);
  assert.equal(alarms[0].active, true);
  assert.match(alarms[0].reason, /timeout/);
  assert.equal(alarms[0].window.timeoutRate, 1);
  assert.equal(alarms[0].window.reads, 4);
  assert.equal(alarms[0].window.timeouts, 4);
  // no duplicate alarm while still degraded
  await c.tick();
  const records2 = readJsonl(join(dir, 'telemetry.jsonl'));
  assert.equal(records2.filter(r => r.kind === 'alarm' && r.active === true).length, 1);
});

test('collector: high p99 alone fires the degraded alarm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  const probe = scriptedProbe(clock, { latencies: [5000] });
  return (async () => {
    const c = new TelemetryCollector({
      probe,
      ...collectorOptions(clock, dir, { minSamplesForAlarm: 4, degradedP99Ms: 2000, emitEvery: 100, checkpointEvery: 100 }),
    });
    for (let i = 0; i < 4; i++) await c.tick();
    const records = readJsonl(join(dir, 'telemetry.jsonl'));
    const alarms = records.filter(r => r.kind === 'alarm' && r.active === true);
    assert.equal(alarms.length, 1);
    assert.match(alarms[0].reason, /p99/);
    assert.ok(alarms[0].window.latency.p99 >= 5000);
  })();
});

test('collector: recovery clears the alarm exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  let mode = 'bad';
  const probe = async () => {
    if (mode === 'bad') { clock.advance(50); await new Promise(() => {}); }
    clock.advance(5);
    return { sequence: 1, eventCount: 0, eventCountTotal: 0 };
  };
  const c = new TelemetryCollector({
    probe,
    ...collectorOptions(clock, dir, { readTimeoutMs: 50, minSamplesForAlarm: 4, degradedTimeoutRate: 0.5, emitEvery: 100, checkpointEvery: 100, windowSamples: 8 }),
  });
  for (let i = 0; i < 4; i++) await c.tick(); // degraded
  mode = 'good';
  for (let i = 0; i < 8; i++) { clock.advance(1000); await c.tick(); } // refill window with healthy reads
  const records = readJsonl(join(dir, 'telemetry.jsonl'));
  const fired = records.filter(r => r.kind === 'alarm' && r.active === true);
  const cleared = records.filter(r => r.kind === 'alarm' && r.active === false);
  assert.equal(fired.length, 1);
  assert.equal(cleared.length, 1);
  assert.ok(cleared[0].window.timeoutRate <= 0.5, `cleared at rate ${cleared[0].window.timeoutRate}`);
  assert.ok(cleared[0].window.reads >= 4);
});

test('checkpoint: restart resumes cursor, window stats and counters without re-scanning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  let seq = 5000;
  const probe = async () => { clock.advance(7); seq += 2; return { sequence: seq, eventCount: 2, eventCountTotal: seq - 5000 }; };
  const mk = () => new TelemetryCollector({ probe, ...collectorOptions(clock, dir, { emitEvery: 100, checkpointEvery: 100 }) });
  const a = await mk();
  assert.equal(a.self.restarts, 0);
  for (let i = 0; i < 6; i++) await a.tick();
  await a.checkpoint();
  const before = a.stats();
  // brand-new collector instance, same checkpoint path: resumes
  const b = await mk();
  assert.equal(b.self.restarts, 1);
  const after = b.stats();
  assert.equal(after.cursor.sequence, before.cursor.sequence);
  assert.equal(after.cursor.sequence, 5012);
  assert.equal(after.reads, before.reads);
  assert.equal(after.self.probes, before.self.probes);
  assert.equal(after.window.latency.count, before.window.latency.count);
  assert.equal(after.window.latency.p50, before.window.latency.p50);
  // probe continues from the checkpointed cursor, not from zero
  let seenCursor = -1;
  const probe2 = async ({ cursor }) => { seenCursor = cursor.sequence; clock.advance(1); return { sequence: cursor.sequence + 1, eventCount: 1, eventCountTotal: 1 }; };
  const c2 = new TelemetryCollector({ probe: probe2, ...collectorOptions(clock, dir, { emitEvery: 100, checkpointEvery: 100 }) });
  await c2.tick();
  assert.equal(seenCursor, 5012);
});

test('event-emission rate: fixture event counts in, correct events/sec out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const clock = fakeClock();
  // 10 events per tick, ticks 1s apart -> 10 events/sec
  const probe = scriptedProbe(clock, { latencies: [10], events: [10] });
  const c = new TelemetryCollector({ probe, ...collectorOptions(clock, dir, { emitEvery: 5, checkpointEvery: 100 }) });
  // probe latency is 10ms of the 1000ms tick cadence -> 10 events/sec exactly
  for (let i = 0; i < 5; i++) { await c.tick(); clock.advance(990); }
  const records = readJsonl(join(dir, 'telemetry.jsonl'));
  const s = records.filter(r => r.kind === 'sample').at(-1);
  assert.equal(s.window.eventCountTotal, 50);
  assert.ok(Math.abs(s.window.eventRatePerSec - 10) < 0.001, `rate was ${s.window.eventRatePerSec}`);
});

test('read-only audit: zero mutating HTTP calls against a fixture server', async () => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    const url = new URL(req.url, 'http://127.0.0.1');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/work-claims')) { res.end(JSON.stringify({ claims: [], hasMore: false })); return; }
    if (url.pathname.endsWith('/events')) {
      const after = Number(url.searchParams.get('after') || 0);
      res.end(JSON.stringify({ events: [{ sequence: after + 1, event: { type: 'message.posted' } }], hasMore: false }));
      return;
    }
    res.end(JSON.stringify({}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), 'tel-'));
  const env = {
    ROOM_AGENT_ORIGIN: `http://127.0.0.1:${port}`,
    ROOM_AGENT_ROOM: 'audit-room',
    ROOM_AGENT_TOKEN: 'a'.repeat(43), // RoomAgentClient token shape; fixture server ignores it
    ROOM_AGENT_MEMBER: 'audit-member',
  };
  try {
    const probe = roomProbeFromEnvironment(env);
    const c = new TelemetryCollector({
      probe,
      clock: () => Date.now(),
      sleeper: (ms) => new Promise(r => setTimeout(r, ms)),
      checkpointPath: join(dir, 'checkpoint.json'),
      outputPath: join(dir, 'telemetry.jsonl'),
      readTimeoutMs: 5000, emitEvery: 3, checkpointEvery: 3, minSamplesForAlarm: 100,
    });
    for (let i = 0; i < 3; i++) await c.tick();
    await c.checkpoint();
    assert.ok(methods.length > 0, 'probe made no HTTP calls at all');
    const mutating = methods.filter(m => m !== 'GET');
    assert.deepEqual(mutating, [], `mutating calls observed: ${mutating.join(',')}`);
    // only the collector's own files were written locally
    assert.deepEqual(readdirSync(dir).sort(), ['checkpoint.json', 'telemetry.jsonl']);
  } finally {
    server.close();
  }
});

test('read-only audit: probe that attempts a write is rejected before any room state changes', async () => {
  const methods = [];
  const server = createServer((req, res) => {
    methods.push(req.method);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({}));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    // A misbehaving probe adapter that tries to POST: the collector wraps every
    // probe call with a read-only guard that only permits GET-targeted probes.
    const evilProbe = async ({ signal }) => {
      await fetch(`http://127.0.0.1:${port}/api/rooms/x/work-claims`, { method: 'POST', signal, body: '{}' });
      return { sequence: 0, eventCount: 0, eventCountTotal: 0 };
    };
    const dir = mkdtempSync(join(tmpdir(), 'tel-'));
    const clock = fakeClock();
    const c = new TelemetryCollector({
      probe: (args) => c.guardedProbe(evilProbe, args),
      ...collectorOptions(clock, dir, { emitEvery: 100, checkpointEvery: 100 }),
    });
    await assert.rejects(() => c.tick(), /read-only/);
    assert.deepEqual(methods, [], 'no HTTP call may escape the guard');
  } finally {
    server.close();
  }
});
