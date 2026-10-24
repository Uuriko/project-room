import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  listCoveragePayloads,
  prepareCoverageDir,
  runTestFiles,
  shardCoverageDir,
} from "../scripts/unit-ci.mjs";
import { readCoveragePayloads } from "../scripts/coverage-thresholds.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, "fixtures", "unit-ci", name);

test("runTestFiles returns status 0 and no failures when all pass", () => {
  const { status, signal, failures } = runTestFiles([fixture("pass-probe.mjs")]);
  assert.equal(status, 0);
  assert.equal(signal, null);
  assert.deepEqual(failures, []);
});

test("runTestFiles names the failing test on a red run", () => {
  const { status, failures } = runTestFiles([
    fixture("pass-probe.mjs"),
    fixture("fail-probe.mjs"),
  ]);
  assert.notEqual(status, 0);
  assert.ok(
    failures.some((f) => f.includes("probe fails deterministically")),
    `expected the failing probe name, got: ${JSON.stringify(failures)}`
  );
});

// --- T-1: shard-side coverage collection ---

test("shardCoverageDir lives inside the shard's existing test-results evidence tree", () => {
  assert.equal(shardCoverageDir({ index: 2, total: 3 }), "test-results/coverage-shard-2-of-3");
});

test("prepareCoverageDir drops stale payloads and manifests but keeps other files", () => {
  const dir = mkdtempSync(join(tmpdir(), "unit-ci-cov-"));
  try {
    writeFileSync(join(dir, "coverage-123.json"), "{}");
    writeFileSync(join(dir, "coverage-manifest.json"), "{}");
    writeFileSync(join(dir, "keep.txt"), "keep");
    prepareCoverageDir(dir);
    assert.deepEqual(listCoveragePayloads(dir), []);
    assert.equal(existsSync(join(dir, "coverage-manifest.json")), false);
    assert.equal(existsSync(join(dir, "keep.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runTestFiles with coverageDir emits V8 payloads for the files it ran", () => {
  const dir = mkdtempSync(join(tmpdir(), "unit-ci-cov-run-"));
  try {
    const covDir = join(dir, "coverage");
    const { status } = runTestFiles([fixture("pass-probe.mjs")], { coverageDir: covDir });
    assert.equal(status, 0);
    const payloads = listCoveragePayloads(covDir);
    assert.ok(payloads.length >= 1, "expected at least one V8 coverage payload");
    const urls = [];
    for (const payload of readCoveragePayloads(covDir)) {
      for (const script of payload.result ?? []) urls.push(script.url);
    }
    assert.ok(
      urls.some((u) => typeof u === "string" && u.endsWith("pass-probe.mjs")),
      `expected a payload for the probe file, got: ${JSON.stringify(urls.slice(0, 10))}`
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
