// Tests for sharded coverage collection (CI: the coverage gate measures the
// unit shards instead of re-running the whole suite).
//
// Test-audit authoring gate answers:
// 1. Contract protected: (a) scripts/unit-ci.mjs collects V8 coverage from its
//    shard's test processes and writes a compact covered-line summary into
//    the shard evidence under test-results/ (raw payloads never ride the
//    artifact); (b) scripts/coverage-thresholds.mjs unions per-shard
//    summaries and enforces the same per-module thresholds as the raw-payload
//    path. If the summary is missing, stale, or mis-unioned, the gate
//    measures the wrong thing while reporting success.
// 2. Credible regressions: a refactor of unit-ci.mjs drops the summary write
//    (gate evaluates nothing, fails closed on every PR); the summary records
//    per-shard covered counts instead of line sets (union over-counts lines
//    covered in two shards, inflating coverage); a shard summary goes missing
//    and the evaluator silently scores partial data as complete.
// 3. Existing coverage: tests/coverage-thresholds.test.js owns the raw-payload
//    math; tests/unit-shards.test.js owns shard allocation and receipts.
//    Neither reaches the summary write or the cross-shard union.
// 4. No production seam: the integration test runs the real unit-ci.mjs in a
//    fixture dir and the real summarizer over real V8 payloads; the pure
//    tests use synthetic payloads through the exported functions.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  summarizeCoverage,
  evaluateSummaries,
  evaluateModules,
  groupFunctionsByUrl,
  loadConfig,
} from "../scripts/coverage-thresholds.mjs";

const scriptUrl = (root, rel) => `file://${root}/${rel}`;
const payload = (url, functions) => ({ result: [{ url, functions }] });
const fn = (name, ranges) => ({ functionName: name, ranges });
const range = (start, end, count) => ({ startOffset: start, endOffset: end, count });

function fixtureConfig(dir) {
  return { version: 1, modules: { lib: { dir: "lib", threshold: 0 } } };
}

test("summarizeCoverage + evaluateSummaries agree with the raw-payload path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-sum-"));
  try {
    mkdirSync(join(dir, "lib"));
    const src = "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n";
    writeFileSync(join(dir, "lib", "x.mjs"), src);
    const config = fixtureConfig(dir);
    const url = scriptUrl(dir, "lib/x.mjs");
    // Payload 1 covers function a (lines 1-3), payload 2 covers function b.
    const grouped = groupFunctionsByUrl(
      [
        payload(url, [fn("", [range(0, src.length, 1)]), fn("a", [range(17, 32, 1)]), fn("b", [range(33, 48, 0)])]),
        payload(url, [fn("", [range(0, src.length, 1)]), fn("a", [range(17, 32, 0)]), fn("b", [range(33, 48, 1)])]),
      ],
      dir
    );
    const raw = evaluateModules(dir, config, grouped);
    const summary = summarizeCoverage(dir, config, grouped);
    assert.equal(summary.version, 1);
    assert.deepEqual(Object.keys(summary.modules), ["lib"]);
    const evaled = evaluateSummaries(dir, config, [summary]);
    assert.equal(evaled.lib.pct, raw.lib.pct);
    assert.equal(evaled.lib.covered, raw.lib.covered);
    assert.equal(evaled.lib.coverable, raw.lib.coverable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateSummaries unions covered lines across shards without double counting", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-union-"));
  try {
    mkdirSync(join(dir, "lib"));
    const src = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";
    writeFileSync(join(dir, "lib", "y.mjs"), src);
    const config = fixtureConfig(dir);
    // Shard 1 covers lines 1-2, shard 2 covers lines 2-3 (0-based 0-1 and 1-2).
    // Union must be lines 1-3 (0-based 0,1,2): 3 of 4 coverable = 75%.
    const s1 = { version: 1, modules: { lib: { files: { "lib/y.mjs": [0, 1] } } } };
    const s2 = { version: 1, modules: { lib: { files: { "lib/y.mjs": [1, 2] } } } };
    const evaled = evaluateSummaries(dir, config, [s1, s2]);
    assert.equal(evaled.lib.covered, 3);
    assert.equal(evaled.lib.coverable, 4);
    assert.equal(evaled.lib.pct, 75);
    // A file with no data in any summary drags the module down (decay-catching).
    const empty = evaluateSummaries(dir, config, [{ version: 1, modules: { lib: { files: {} } } }]);
    assert.equal(empty.lib.covered, 0);
    assert.deepEqual(empty.lib.zeroCoverageFiles, ["lib/y.mjs"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evaluateSummaries rejects malformed summaries instead of scoring partial data", () => {
  const dir = mkdtempSync(join(tmpdir(), "cov-bad-"));
  try {
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "lib", "z.mjs"), "const a = 1;\n");
    const config = fixtureConfig(dir);
    assert.throws(() => evaluateSummaries(dir, config, [null]), /summary/);
    assert.throws(() => evaluateSummaries(dir, config, [{ version: 2, modules: {} }]), /version/);
    assert.throws(
      () => evaluateSummaries(dir, config, [{ version: 1, modules: { lib: { files: { "lib/z.mjs": "nope" } } } }]),
      /covered lines/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unit shard run writes a compact coverage summary into the shard evidence", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unit-cov-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "scripts"));
  mkdirSync(join(dir, "tests"));
  mkdirSync(join(dir, "lib"));
  for (const name of ["check-deps.mjs", "unit-ci.mjs", "unit-ci-durations.json", "unit-shards.mjs", "coverage-thresholds.mjs"]) {
    cpSync(join("scripts", name), join(dir, "scripts", name));
  }
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(dir, "coverage-thresholds.json"), JSON.stringify(fixtureConfig(dir)));
  writeFileSync(join(dir, "lib", "a.mjs"), "export function double(n) {\n  return n * 2;\n}\n");
  writeFileSync(
    join(dir, "tests", "a.test.js"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { double } from '../lib/a.mjs';\ntest('doubles', () => { assert.equal(double(21), 42); });\n"
  );
  writeFileSync(
    join(dir, "scripts", "unit-ci-durations.json"),
    JSON.stringify({ milliseconds: { "tests/a.test.js": 500 } })
  );
  const env = { ...process.env, TMPDIR: join(dir, ".tmp") };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["scripts/unit-ci.mjs", "--shard=1/3"], {
    cwd: dir, env, encoding: "utf8", timeout: 120000,
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const summaryPath = join(dir, "test-results", "coverage-shard-1.json");
  assert.ok(existsSync(summaryPath), "shard writes test-results/coverage-shard-1.json");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(summary.version, 1);
  const covered = summary.modules?.lib?.files?.["lib/a.mjs"];
  assert.ok(Array.isArray(covered) && covered.length > 0, "summary carries covered lines for lib/a.mjs");
  // Raw V8 payloads stay local: the artifact must carry only the compact summary.
  // (Raw payloads are named coverage-<pid>-<timestamp>-<thread>.json; the
  // summary is coverage-shard-<i>.json.)
  const rawPayloads = readdirSync(join(dir, "test-results"), { recursive: true })
    .filter((n) => /^coverage-\d+-/.test(String(n)));
  assert.deepEqual(rawPayloads, [], "no raw coverage payloads under test-results/");
  // The summary round-trips through the evaluator against the fixture source.
  const config = loadConfig(join(dir, "coverage-thresholds.json"), dir);
  const evaled = evaluateSummaries(dir, config, [summary]);
  assert.ok(evaled.lib.pct > 0, `expected measured coverage, got ${evaled.lib.pct}`);
});
