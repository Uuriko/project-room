// FIX-22c: CI queue-depth telemetry emitter + rho>1 knee detector.
// Fail-first coverage for the four acceptance criteria:
//  1. emitter produces ci.queue_depth_sample records with queued/running/p50-wait
//     fields on the 15-minute cadence (scripted sampler run)
//  2. knee detector fires on a synthetic diverging queue, stays quiet on stable
//  3. produced records match telemetry/ci-queue/queue-depth-schema.json
//  4. no credentials, no external writes: reads CI state locally, records locally

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  sampleOnce,
  detectKnee,
  p50,
  writeSample,
  loadSamples,
  SAMPLE_TYPE,
  DEFAULT_INTERVAL_S,
} from "../telemetry/ci-queue/queue-depth-sampler.mjs";
import { validateRecord } from "../telemetry/ci-queue/validate-record.mjs";
import { createGitHubActionsSource } from "../telemetry/ci-queue/github-actions-source.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runSample = path.join(repoRoot, "telemetry/ci-queue/run-sample.mjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "ciqd-"));
}

// A scripted (offline) source: returns a fixed queue snapshot, no CI access.
function scriptedSource(snapshot) {
  return { async fetch() { return snapshot; } };
}

// AC1: emitter produces ci.queue_depth_sample records with the required fields.
test("AC1: sampleOnce emits ci.queue_depth_sample with queued/running/p50-wait fields", async () => {
  const record = await sampleOnce(
    scriptedSource({ queued: 12, running: 8, waits_s: [60, 120, 300, 480, 900, 1500] }),
    { repo: "Uuriko/project-room", now: "2026-10-08T19:45:00.000Z" }
  );
  assert.equal(record.type, SAMPLE_TYPE);
  assert.equal(record.type, "ci.queue_depth_sample");
  assert.equal(record.queued, 12);
  assert.equal(record.running, 8);
  assert.equal(record.p50_wait_s, 390); // median of [60,120,300,480,900,1500]
  assert.equal(record.repo, "Uuriko/project-room");
  assert.equal(record.timestamp, "2026-10-08T19:45:00.000Z");
  assert.equal(record.interval_s, DEFAULT_INTERVAL_S);
  assert.equal(record.interval_s, 900);
});

// AC1: 15-minute cadence -> run-sample.mjs appends exactly one record per invocation.
test("AC1: run-sample.mjs scripted run appends one local record", () => {
  const dir = tmpDir();
  const out = path.join(dir, "samples.jsonl");
  const fixture = path.join(dir, "fixture.json");
  fs.writeFileSync(fixture, JSON.stringify({ queued: 5, running: 3, waits_s: [100, 200] }));
  const r = execFileSync(process.execPath, [runSample, "--out", out, "--source-fixture", fixture, "--repo", "Uuriko/project-room", "--now", "2026-10-08T20:00:00.000Z"], { encoding: "utf8" });
  assert.match(r, /sample recorded/);
  const lines = fs.readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.type, "ci.queue_depth_sample");
  assert.equal(rec.queued, 5);
  assert.equal(rec.running, 3);
  assert.equal(rec.p50_wait_s, 150);
});

// AC2: knee detector fires on a synthetic diverging queue (rho > 1).
test("AC2: detectKnee fires on a superlinearly diverging queue", () => {
  const samples = [4, 9, 16, 25, 36, 49, 64, 81].map((queued, i) => ({
    timestamp: new Date(Date.UTC(2026, 9, 8, 12, 0) + i * 15 * 60 * 1000).toISOString(),
    queued,
  }));
  const verdict = detectKnee(samples);
  assert.equal(verdict.alert, true);
  assert.match(verdict.reason, /diverging|growing/i);
});

// AC2: quiet on a stable queue (oscillating around a mean, no drift).
test("AC2: detectKnee stays quiet on a stable queue", () => {
  const samples = [5, 7, 6, 5, 8, 6, 7, 5].map((queued, i) => ({
    timestamp: new Date(Date.UTC(2026, 9, 8, 12, 0) + i * 15 * 60 * 1000).toISOString(),
    queued,
  }));
  const verdict = detectKnee(samples);
  assert.equal(verdict.alert, false);
});

// AC2: quiet on a draining queue (rho < 1, queue emptying).
test("AC2: detectKnee stays quiet on a draining queue", () => {
  const samples = [40, 32, 26, 18, 12, 8, 4, 2].map((queued, i) => ({
    timestamp: new Date(Date.UTC(2026, 9, 8, 12, 0) + i * 15 * 60 * 1000).toISOString(),
    queued,
  }));
  const verdict = detectKnee(samples);
  assert.equal(verdict.alert, false);
});

// AC2: hard threshold catches a sudden huge backlog even without history.
test("AC2: detectKnee fires on a backlog past the hard knee threshold", () => {
  const verdict = detectKnee([
    { timestamp: "2026-10-08T12:00:00.000Z", queued: 150 },
  ]);
  assert.equal(verdict.alert, true);
});

// AC2: too little history is inconclusive, not an alert.
test("AC2: detectKnee stays quiet with insufficient history", () => {
  const verdict = detectKnee([
    { timestamp: "2026-10-08T12:00:00.000Z", queued: 12 },
    { timestamp: "2026-10-08T12:15:00.000Z", queued: 18 },
  ]);
  assert.equal(verdict.alert, false);
});

// AC3: produced records match the documented record schema.
test("AC3: emitted records validate against queue-depth-schema.json", async () => {
  const record = await sampleOnce(
    scriptedSource({ queued: 1, running: 1, waits_s: [] }),
    { repo: "Uuriko/project-room" }
  );
  assert.deepEqual(record.p50_wait_s, null);
  const verdict = validateRecord(record);
  assert.equal(verdict.ok, true, JSON.stringify(verdict.errors));
  const bad = validateRecord({ type: "ci.queue_depth_sample", queued: "lots" });
  assert.equal(bad.ok, false);
});

// AC3: the schema document itself is well-formed JSON and names the sample type.
test("AC3: queue-depth-schema.json is well-formed and names ci.queue_depth_sample", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "telemetry/ci-queue/queue-depth-schema.json"), "utf8"));
  assert.equal(schema.title, "ci.queue_depth_sample");
  for (const f of ["type", "timestamp", "queued", "running", "p50_wait_s"]) {
    assert.ok(schema.required.includes(f), f);
  }
});

// AC4: sampler core has no network or credential-touching imports.
test("AC4: sampler core imports no network or credential modules", () => {
  const src = fs.readFileSync(path.join(repoRoot, "telemetry/ci-queue/queue-depth-sampler.mjs"), "utf8");
  for (const mod of ["node:https", "node:http", "node:net", "node:tls", "node:dns"]) {
    assert.ok(!src.includes(mod), `sampler must not import ${mod}`);
  }
  assert.ok(!/process\.env\[(?:["'])(?:.*TOKEN|.*SECRET|.*KEY)/.test(src), "sampler must not read credentials from env");
});

// AC4: writes go to a local JSONL file only.
test("AC4: writeSample appends locally and loadSamples round-trips", async () => {
  const dir = tmpDir();
  const out = path.join(dir, "samples.jsonl");
  const record = await sampleOnce(scriptedSource({ queued: 2, running: 1, waits_s: [30] }), { repo: "x/y" });
  await writeSample(out, record);
  await writeSample(out, record);
  const back = await loadSamples(out);
  assert.equal(back.length, 2);
  assert.equal(back[0].queued, 2);
  // one record per line: append-only JSONL
  assert.equal(fs.readFileSync(out, "utf8").trim().split("\n").length, 2);
});

// live source: parses gh output into a snapshot without touching the network
test("github-actions source maps gh run lists to queued/running/waits", async () => {
  const createdAt = new Date(Date.parse("2026-10-08T20:00:00.000Z") - 600 * 1000).toISOString();
  const calls = [];
  const source = createGitHubActionsSource({
    repo: "Uuriko/project-room",
    runGh: (args) => {
      calls.push(args);
      if (args.includes("queued")) return JSON.stringify([{ databaseId: 1, createdAt }, { databaseId: 2, createdAt }]);
      return JSON.stringify([{ databaseId: 3, createdAt }]);
    },
    nowMs: () => Date.parse("2026-10-08T20:00:00.000Z"),
  });
  const snap = await source.fetch();
  assert.equal(snap.queued, 2);
  assert.equal(snap.running, 1);
  assert.deepEqual(snap.waits_s, [600, 600]);
  assert.ok(calls.every((a) => a[0] === "run" && a.includes("--repo") && a.includes("Uuriko/project-room")));
  assert.ok(!calls.flat().join(" ").match(/token|secret|key/i), "no credentials in gh args");
});

// unit: p50 helper
test("p50 computes the median of wait samples", () => {
  assert.equal(p50([10, 20, 30]), 20);
  assert.equal(p50([30, 10, 20, 40]), 25);
  assert.equal(p50([]), null);
  assert.equal(p50([5]), 5);
});
