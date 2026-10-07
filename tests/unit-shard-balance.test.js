import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

// Lane G4 (shard balance): the unit-shards planner balances ESTIMATED loads
// perfectly, but the estimates come from a checked-in durations file that
// decays (live evidence 2026-10-07: estimated max/min 1.00, actual shard
// wall times ~2.5x apart). These tests pin the self-updating pipeline:
// per-file duration capture (reporter), median aggregation over recent CI
// runs (refresh), and a balance bound on representative skewed data.

import { aggregateFileDurations } from "../scripts/unit-file-durations-reporter.mjs";
import {
  aggregateDurations,
  median,
  normalizeRepoPath,
  readDurationsPayload,
} from "../scripts/unit-durations-refresh.mjs";

// Deterministic PRNG so the "representative data" fixture is stable.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("reporter takes the file-level wall time from the file's own test:complete", () => {
  // Real node --test event shapes (Node 24): each file gets a file-level
  // `test:complete` whose name is the file's own path and whose
  // details.duration_ms is the file's wall-clock cost in the run. Individual
  // tests contribute the test count and summed test time.
  const events = [
    { type: "test:enqueue", data: { name: "tests/a.test.js", file: "/repo/tests/a.test.js" }, at: 1000 },
    { type: "test:start", data: { name: "a1", file: "/repo/tests/a.test.js" }, at: 1010 },
    { type: "test:complete", data: { name: "a1", file: "/repo/tests/a.test.js", details: { duration_ms: 50 } }, at: 1060 },
    { type: "test:pass", data: { name: "a1", file: "/repo/tests/a.test.js", details: { duration_ms: 50 } }, at: 1061 },
    { type: "test:start", data: { name: "a2", file: "/repo/tests/a.test.js" }, at: 1070 },
    { type: "test:complete", data: { name: "a2", file: "/repo/tests/a.test.js", details: { duration_ms: 80 } }, at: 1160 },
    { type: "test:pass", data: { name: "a2", file: "/repo/tests/a.test.js", details: { duration_ms: 80 } }, at: 1161 },
    { type: "test:complete", data: { name: "tests/a.test.js", file: "/repo/tests/a.test.js", details: { duration_ms: 240.4 } }, at: 1250 },
    { type: "test:enqueue", data: { name: "tests/b.test.js", file: "/repo/tests/b.test.js" }, at: 1100 },
    { type: "test:start", data: { name: "b1", file: "/repo/tests/b.test.js" }, at: 1110 },
    { type: "test:complete", data: { name: "b1", file: "/repo/tests/b.test.js", details: { duration_ms: 900 } }, at: 2050 },
    { type: "test:pass", data: { name: "b1", file: "/repo/tests/b.test.js", details: { duration_ms: 900 } }, at: 2051 },
    { type: "test:complete", data: { name: "tests/b.test.js", file: "/repo/tests/b.test.js", details: { duration_ms: 980.6 } }, at: 2090 },
  ];
  const out = aggregateFileDurations(events, { cwd: "/repo" });
  assert.deepEqual(Object.keys(out.files).sort(), ["tests/a.test.js", "tests/b.test.js"]);
  const a = out.files["tests/a.test.js"];
  const b = out.files["tests/b.test.js"];
  assert.equal(a.tests, 2);
  assert.equal(a.sumMs, 130);
  assert.equal(a.ms, 240); // runner's file-level wall time wins over span/sum
  assert.equal(b.tests, 1);
  assert.equal(b.ms, 981);
});

test("reporter falls back to observed span when the file point is missing", () => {
  const events = [
    { type: "test:start", data: { name: "a1", file: "/repo/tests/a.test.js" }, at: 1000 },
    { type: "test:pass", data: { name: "a1", file: "/repo/tests/a.test.js", details: { duration_ms: 50 } }, at: 1060 },
    // aborted run: no file-level test:complete for a
  ];
  const out = aggregateFileDurations(events, { cwd: "/repo" });
  assert.equal(out.files["tests/a.test.js"].ms, 60); // max(span 60, sum 50)
});

test("reporter ignores files with no completed tests", () => {
  const events = [
    { type: "test:start", data: { name: "x", file: "/repo/tests/x.test.js" }, at: 100 },
    // run aborted: no terminal event for x
  ];
  const out = aggregateFileDurations(events, { cwd: "/repo" });
  assert.deepEqual(out.files, {});
});

test("median rejects a single slow outlier run", () => {
  assert.equal(median([100, 110, 105, 5000, 102]), 105);
  assert.equal(median([50]), 50);
  assert.equal(median([80, 120]), 100);
});

test("refresh aggregates per-file medians across runs, dropping thin data", () => {
  const runs = [
    { runId: "r1", files: { "tests/a.test.js": 100, "tests/b.test.js": 900, "tests/c.test.js": 50 } },
    { runId: "r2", files: { "tests/a.test.js": 110, "tests/b.test.js": 950, "tests/c.test.js": 55 } },
    { runId: "r3", files: { "tests/a.test.js": 105, "tests/b.test.js": 5000, "tests/c.test.js": 52 } }, // b flaked slow
    { runId: "r4", files: { "tests/a.test.js": 102, "tests/d.test.js": 700 } }, // d seen once
  ];
  const agg = aggregateDurations(runs, { minObservations: 2, maxObservationMs: 30 * 60 * 1000 });
  assert.equal(agg.milliseconds["tests/a.test.js"], 104); // median of 100,102,105,110
  assert.equal(agg.milliseconds["tests/b.test.js"], 950); // outlier 5000 rejected by median
  assert.equal(agg.milliseconds["tests/c.test.js"], 52);
  assert.ok(!("tests/d.test.js" in agg.milliseconds), "single-observation file stays on planner default");
  assert.equal(agg.meta.runsWithData, 4);
});

test("refresh fails closed when no run has durations data", () => {
  assert.throws(
    () => aggregateDurations([], { minObservations: 2, maxObservationMs: 30 * 60 * 1000 }),
    /no durations data/i
  );
  assert.throws(
    () => aggregateDurations([{ runId: "r1", files: {} }], { minObservations: 2, maxObservationMs: 30 * 60 * 1000 }),
    /no durations data/i
  );
});

test("normalizeRepoPath maps absolute event paths back to repo-relative keys", () => {
  assert.equal(normalizeRepoPath("/repo/tests/a.test.js", "/repo"), "tests/a.test.js");
  assert.equal(normalizeRepoPath("tests/a.test.js", "/repo"), "tests/a.test.js");
  assert.equal(normalizeRepoPath("/other/tests/a.test.js", "/repo"), "/other/tests/a.test.js");
});

test("readDurationsPayload skips malformed or reporter-errored artifacts", t => {
  const dir = mkdtempSync(join(tmpdir(), "durations-payload-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({
    version: 1,
    files: {
      "tests/a.test.js": { tests: 2, sumMs: 10, spanMs: 12, ms: 12 },
      "tests/b.test.js": { tests: 1, sumMs: 0, spanMs: 0, ms: 0 }, // non-positive: dropped
      "tests/c.test.js": { tests: 1 }, // no ms: dropped
    },
  }));
  assert.deepEqual(readDurationsPayload(good), { "tests/a.test.js": 12 });
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.equal(readDurationsPayload(bad), null);
  const errPayload = join(dir, "err.json");
  writeFileSync(errPayload, JSON.stringify({ version: 1, error: "boom", files: {} }));
  assert.equal(readDurationsPayload(errPayload), null);
  const noMap = join(dir, "nomap.json");
  writeFileSync(noMap, JSON.stringify({ version: 1 }));
  assert.equal(readDurationsPayload(noMap), null);
});

test("unitPlan balances representative skewed weights within a 25% bound", t => {
  const dir = mkdtempSync(join(tmpdir(), "shard-balance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  for (const name of ["unit-shards.mjs", "unit-ci-durations.json"]) {
    cpSync(join("scripts", name), join(dir, "scripts", name));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  // Representative catalog shape (mirrors the observed stale catalog):
  // ~65% small files (0.1-2s), ~25% medium (2-60s), ~8% heavy (60-150s),
  // ~2% clamped heavies (~300s). Deterministic seed.
  const rand = mulberry32(20261007);
  const weights = {};
  const N = 120;
  for (let i = 0; i < N; i++) {
    const file = `tests/rep-${String(i).padStart(3, "0")}.test.js`;
    const r = rand();
    let w;
    if (r < 0.65) w = 100 + rand() * 1900;
    else if (r < 0.90) w = 2000 + rand() * 58000;
    else if (r < 0.98) w = 60000 + rand() * 90000;
    else w = 300000;
    weights[file] = Math.round(w);
    writeFileSync(join(dir, file), "import test from 'node:test';\ntest('x', () => {});\n");
  }
  writeFileSync(join(dir, "scripts/unit-ci-durations.json"), JSON.stringify({ milliseconds: weights }));
  const out = spawnSync(process.execPath, ["-e", `
    import("./scripts/unit-shards.mjs").then(({ unitPlan }) => {
      const plan = unitPlan(".");
      console.log(JSON.stringify(plan.shards.map(s => Math.round(s.estimatedMs))));
    });
  `], { cwd: dir, encoding: "utf8", timeout: 120000 });
  assert.equal(out.status, 0, out.stderr);
  const loads = JSON.parse(out.stdout.trim());
  assert.equal(loads.length, 3);
  const ratio = Math.max(...loads) / Math.min(...loads);
  assert.ok(ratio <= 1.25, `shard loads ${loads} exceed 25% bound (ratio ${ratio.toFixed(2)})`);
});

test("unit-ci records per-file durations into the evidence artifact", async t => {
  const dir = mkdtempSync(join(tmpdir(), "unit-ci-durations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  for (const name of ["check-deps.mjs", "failing-tests.mjs", "unit-ci.mjs", "unit-ci-durations.json", "unit-shards.mjs", "unit-file-durations-reporter.mjs"]) {
    cpSync(join("scripts", name), join(dir, "scripts", name));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "scripts/unit-ci-durations.json"), JSON.stringify({ milliseconds: {} }));
  // Six busy-loop fixtures (~150ms each); the greedy planner spreads them
  // 2-2-2 across the three shards, so every shard is non-empty.
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(dir, `tests/probe-${i}.test.js`),
      `import test from 'node:test';\ntest('probe ${i}', () => { const s = Date.now(); while (Date.now() - s < 150) {} });\n`);
  }
  const env = { ...process.env, TMPDIR: "", GITHUB_SHA: "fixture", GITHUB_RUN_ID: "fixture", GITHUB_RUN_ATTEMPT: "1" };
  delete env.NODE_TEST_CONTEXT; // fixture launches an independent runner
  let totalFiles = 0;
  for (let shard = 1; shard <= 3; shard++) {
    const run = spawnSync(process.execPath, ["scripts/unit-ci.mjs", `--shard=${shard}/3`],
      { cwd: dir, env, encoding: "utf8", timeout: 60000 });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const names = readdirSync(join(dir, "test-results"))
      .filter(n => n === `unit-file-durations-${shard}-of-3.json`);
    assert.equal(names.length, 1, `shard ${shard}: expected one durations file`);
    const payload = JSON.parse(readFileSync(join(dir, "test-results", names[0]), "utf8"));
    const keys = Object.keys(payload.files);
    assert.ok(keys.length > 0, `shard ${shard}: durations file must record per-file timings`);
    for (const k of keys) {
      assert.ok(payload.files[k].ms > 0, `${k} has non-positive duration`);
      assert.match(k, /^tests\//, `${k} must be a repo-relative path`);
    }
    totalFiles += keys.length;
  }
  assert.equal(totalFiles, 6, "every fixture file recorded exactly once across shards");
});
