// Fail-first conformance tests for FIX-25: every telemetry emitter's output
// must validate against the common v:1 JSONL schema
// (scripts/telemetry-schema.mjs, canonical from FIX-54).
//
// Each test drives the emitter's REAL output path with offline fixtures and
// validates every record it produces. Written fail-first: before the FIX-25
// convergence edits, the FIX-22c / FIX-55 / FIX-78 legs fail because their
// records lack the v:1 envelope; after convergence all legs pass while every
// legacy field the squads' readers depend on is still present.
//
// Run: TMPDIR=$PWD/.tmp node --test tests/telemetry-schema.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

import { SCHEMA_VERSION, KINDS, validateRecord } from "../scripts/telemetry-schema.mjs";
import { TelemetryCollector } from "../scripts/room-telemetry-collector.mjs";
import { sampleOnce } from "../telemetry/ci-queue/queue-depth-sampler.mjs";
import { buildDigest, normalizeCiQueue } from "../scripts/capacity-digest.mjs";
import { runProbe } from "../scripts/board-read-probe.mjs";

function assertValid(record, label) {
  const { ok, errors } = validateRecord(record);
  assert.ok(ok, `${label} must validate against the common v:1 schema: ${errors.join("; ")}`);
}

// --- FIX-54: the canonical emitter; its records are the reference shape ---

function fakeClock() {
  let now = 1_700_000_000_000;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

test("FIX-54 collector sample records validate against the common schema", async () => {
  const clock = fakeClock();
  let seq = 5000;
  const probe = async () => ({ sequence: ++seq, eventCount: 2, eventCountTotal: seq });
  const dir = mkdtempSync(join(tmpdir(), "fix25-"));
  const collector = new TelemetryCollector({
    probe,
    clock: () => clock.now(),
    sleeper: (ms) => new Promise((r) => setImmediate(() => { clock.advance(ms); r(); })),
    checkpointPath: join(dir, "checkpoint.json"),
    outputPath: join(dir, "telemetry.jsonl"),
    options: { emitEvery: 1, checkpointEvery: 100, intervalMs: 1 },
  });
  await collector.tick();
  await collector.tick();
  const lines = readFileSync(join(dir, "telemetry.jsonl"), "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, "expected at least 2 emitted sample lines");
  for (const line of lines) assertValid(JSON.parse(line), "FIX-54 sample");
});

// --- FIX-22c: CI queue-depth gauge (drifts: no v/ts/kind envelope yet) ---

function fixtureSource() {
  return {
    name: "fixture",
    async fetch() { return { queued: 12, running: 8, waits_s: [60, 120, 300, 480, 900, 1500] }; },
  };
}

test("FIX-22c gauge records validate against the common schema", async () => {
  const record = await sampleOnce(fixtureSource(), {
    repo: "Uuriko/project-room",
    now: "2026-10-08T19:45:00.000Z",
    previousSamples: [],
  });
  assertValid(record, "FIX-22c gauge");
});

test("FIX-22c keeps every legacy field its readers depend on", async () => {
  const record = await sampleOnce(fixtureSource(), {
    repo: "Uuriko/project-room",
    now: "2026-10-08T19:45:00.000Z",
    previousSamples: [],
  });
  // FIX-55's normalizeCiQueue reads these; the queue-depth-schema.json
  // contract requires them. Convergence must not rename or drop them.
  assert.equal(record.type, "ci.queue_depth_sample");
  assert.equal(record.timestamp, "2026-10-08T19:45:00.000Z");
  assert.equal(record.queued, 12);
  assert.equal(record.running, 8);
  assert.equal(record.p50_wait_s, 390);
  assert.equal(record.interval_s, 900);
  assert.ok(record.knee && typeof record.knee.alert === "boolean");
  // The envelope aliases the legacy timestamp; both name the same instant.
  assert.equal(record.ts, record.timestamp);
});

// --- FIX-55: capacity digest (drifts: no v/ts/kind envelope yet) ---

test("FIX-55 digest payloads validate against the common schema", async () => {
  const sample = await sampleOnce(fixtureSource(), {
    repo: "Uuriko/project-room",
    now: "2026-10-09T13:50:00.000Z",
    previousSamples: [],
  });
  const digest = buildDigest({
    board: { openClaims: 142, cap: 200 },
    ciQueue: sample,
    now: "2026-10-09T13:50:00Z",
  });
  assertValid(digest, "FIX-55 digest");
});

test("FIX-55 keeps its payload shape for the webhook relay", async () => {
  const digest = buildDigest({ board: { openClaims: 200, cap: 200 }, ciQueue: null, now: "2026-10-09T13:50:00Z" });
  assert.equal(typeof digest.text, "string");
  assert.ok(Array.isArray(digest.alerts));
  assert.equal(digest.alerts[0].kind, "board_full");
  assert.equal(digest.alerts[0].level, "critical");
  assert.equal(digest.gauges.board.open, 200);
  assert.equal(digest.gauges.board.full, true);
  assert.equal(digest.generatedAt, "2026-10-09T13:50:00Z");
  // normalizeCiQueue still accepts the converged FIX-22c record shape.
  const sample = await sampleOnce(fixtureSource(), { now: "2026-10-09T13:50:00.000Z", previousSamples: [] });
  const ci = normalizeCiQueue(sample);
  assert.equal(ci.queued, 12);
  assert.equal(ci.timestamp, "2026-10-09T13:50:00.000Z");
});

// --- FIX-78: board-read latency probe (drifts: no v/ts/kind envelope yet) ---

test("FIX-78 probe reports validate against the common schema", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const result = await runProbe({
      baseUrl: `http://127.0.0.1:${port}`,
      path: "/",
      runs: 2,
      ladder: [1],
      timeoutMs: 5000,
    });
    assertValid(result, "FIX-78 probe");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("FIX-78 keeps its attribution payload for SLO readers", async () => {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const result = await runProbe({
      baseUrl: `http://127.0.0.1:${port}`,
      path: "/",
      runs: 2,
      ladder: [1],
      timeoutMs: 5000,
    });
    assert.ok(result.target && typeof result.target.url === "string");
    assert.ok(result.slo && result.slo.name === "board-read-latency");
    assert.ok(result.baseline && result.baseline.summary);
    assert.ok(Array.isArray(result.ladder) && result.ladder.length === 1);
    assert.ok(result.method && typeof result.method.note === "string");
    assert.ok(!Number.isNaN(Date.parse(result.ts)), "probe ts parses as a date-time");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- schema module self-checks ---

test("schema version is pinned at 1 and all six kinds are registered", () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.deepEqual([...KINDS].sort(), ["alarm", "checkpoint", "digest", "gauge", "probe", "sample"]);
});

test("validator rejects non-conforming records", () => {
  assert.equal(validateRecord(null).ok, false);
  assert.equal(validateRecord({ v: 1, ts: "2026-10-09T00:00:00.000Z" }).ok, false); // no kind
  assert.equal(validateRecord({ v: 2, ts: "2026-10-09T00:00:00.000Z", kind: "gauge" }).ok, false); // wrong v
  assert.equal(validateRecord({ v: 1, ts: "not-a-date", kind: "gauge" }).ok, false); // bad ts
  assert.equal(validateRecord({ v: 1, ts: "2026-10-09T00:00:00.000Z", kind: "nope" }).ok, false); // unknown kind
  assert.equal(validateRecord({ v: 1, ts: "2026-10-09T00:00:00.000Z", kind: "gauge" }).ok, false); // missing gauge fields
});
