// Issue #3913 (bug sweep 2026-10-16, lane 14 SCRIPTS-OPS) Low bundle:
// F4 browser-shard verifier attempt bounds, F5 diff-size excluded-volume and
// justification-content rules, F7 workflow pin gate container/services
// coverage. Each specimen is written against the finding's demonstrated
// shape; F6 (rollback evidence binding) specimens live in
// tests/manual-rollback.test.js, whose fixture drives the real workflow.
import test from "node:test";
import assert from "node:assert/strict";
import { browserPlan, verifyBrowserShards } from "../scripts/browser-shards.mjs";
import { checkDiffSize } from "../scripts/pr-diff-size-check.mjs";
import { checkSource } from "../scripts/check-workflow-pins.mjs";

// --- F4: verifyBrowserShards bounds receipt attempts like verifyUnitShards ---

const files = Array.from({ length: 9 }, (_, i) => `scripts/check-${i}.mjs`);
const plan = browserPlan(`node --test --test-concurrency=1 ${files.join(" ")}`);
const receiptFor = (shard, runAttempt, extra = {}) => ({
  index: shard.index,
  total: 6,
  status: 0,
  signal: null,
  planHash: plan.planHash,
  revision: "rev-1",
  runId: "run-1",
  files: shard.files,
  runAttempt,
  ...extra,
});
const allReceipts = runAttempt => plan.shards.map(shard => receiptFor(shard, runAttempt));
const gate = (receipts, runAttempt) => () =>
  verifyBrowserShards(plan, receipts, { matrixResult: "success", revision: "rev-1", runId: "run-1", runAttempt });

test("F4: a receipt from a future attempt is refused (sweep shape: attempt 999 vs aggregator 1)", () => {
  assert.throws(gate(allReceipts("999"), "1"), /Browser shard receipt is from a future attempt/);
});

test("F4: a duplicate receipt for the same shard+attempt is refused, not silently dropped", () => {
  const receipts = allReceipts("1");
  receipts.push(receiptFor(plan.shards[0], "1"));
  assert.throws(gate(receipts, "1"), /Duplicate browser shard receipt attempt/);
});

test("F4: a malformed receipt attempt is refused", () => {
  for (const bad of ["abc", "0", "-1", "", 1.5]) {
    const receipts = allReceipts("1");
    receipts[0] = receiptFor(plan.shards[0], bad);
    assert.throws(gate(receipts, "1"), /Browser shard receipt has invalid run attempt/, String(bad));
  }
  assert.throws(gate(allReceipts("1"), "abc"), /invalid run attempt/);
});

test("F4: control — earlier-attempt receipts still pass a re-run aggregator, latest attempt wins", () => {
  assert.deepEqual(
    verifyBrowserShards(plan, allReceipts("1"), { matrixResult: "success", revision: "rev-1", runId: "run-1", runAttempt: "2" }),
    { scripts: 9, shards: 6 },
  );
  const shard = plan.shards[0];
  const mixed = [receiptFor(shard, "1", { status: 1 }), receiptFor(shard, "2"), ...plan.shards.slice(1).map(s => receiptFor(s, "1"))];
  assert.deepEqual(
    verifyBrowserShards(plan, mixed, { matrixResult: "success", revision: "rev-1", runId: "run-1", runAttempt: "2" }),
    { scripts: 9, shards: 6 },
  );
  const mixedFailing = [receiptFor(shard, "1"), receiptFor(shard, "2", { status: 1 }), ...plan.shards.slice(1).map(s => receiptFor(s, "1"))];
  assert.throws(gate(mixedFailing, "2"), /missing, failed, stale or mismatched evidence/);
});

// --- F5: diff-size gate — excluded volume is tallied and capped; filler is not a justification ---

const numstat = rows => rows.map(([added, removed, path]) => `${added}\t${removed}\t${path}`).join("\n");
const realJustification = [
  "## Large diff justification:",
  "This regenerates the bundled assets from one schema change, so every",
  "generated file must move together or the contract tests fail.",
].join("\n");

test("F5: 10,000 excluded lines at counted 0 no longer pass silently (sweep shape)", () => {
  const r = checkDiffSize({
    numstat: numstat([[4000, 1000, "build/bundle.js"], [3000, 1000, "dist/app.js"], [500, 500, "client/app.min.js"]]),
    prBody: "no justification",
  });
  assert.equal(r.counted, 0);
  assert.equal(r.excluded, 10000);
  assert.equal(r.ok, false);
  assert.match(r.message, /excluded/);
});

test("F5: excluded volume over the cap passes with a real justification; counted semantics unchanged", () => {
  const r = checkDiffSize({
    numstat: numstat([
      [100, 50, "server/http.mjs"],
      [5000, 2000, "package-lock.json"],
      [3000, 1000, "dist/bundle.js"],
      [800, 200, "client/app.min.js"],
      [100, 50, "docs/site.js.map"],
    ]),
    prBody: realJustification,
  });
  assert.equal(r.ok, true);
  assert.equal(r.counted, 150);
  assert.equal(r.excluded, 12150);
});

test("F5: excluded volume under the cap still needs no justification and is reported", () => {
  const r = checkDiffSize({
    numstat: numstat([[100, 50, "server/http.mjs"], [500, 200, "package-lock.json"]]),
    prBody: "no justification",
  });
  assert.equal(r.ok, true);
  assert.equal(r.counted, 150);
  assert.equal(r.excluded, 700);
  assert.match(r.message, /excluded 700/);
});

test("F5: a content-free justification (45 x characters) does not pass an over-threshold diff", () => {
  const r = checkDiffSize({
    numstat: numstat([[300, 200, "server/store.mjs"]]),
    prBody: `## Large diff justification:\n${"x".repeat(45)}\n`,
  });
  assert.equal(r.ok, false);
});

test("F5: 40+ characters of a few repeated words is still not a justification", () => {
  const r = checkDiffSize({
    numstat: numstat([[300, 200, "server/store.mjs"]]),
    prBody: `## Large diff justification:\n${"big change ".repeat(6)}\n`,
  });
  assert.equal(r.ok, false);
});

// --- F7: pin gate covers container: and services: images ---

const DIGEST = "a".repeat(64);
const job = lines => `jobs:\n  a:\n    runs-on: ubuntu-latest\n${lines}    steps:\n      - run: true\n`;

test("F7: a scalar job container image must carry a sha256 digest", () => {
  assert.equal(checkSource(job("    container: postgres:16\n")).length, 1);
  assert.deepEqual(checkSource(job(`    container: postgres@sha256:${DIGEST}\n`)), []);
});

test("F7: a container image in mapping form must carry a sha256 digest", () => {
  assert.equal(checkSource(job("    container:\n      image: postgres:16\n")).length, 1);
  assert.deepEqual(checkSource(job(`    container:\n      image: postgres@sha256:${DIGEST}\n`)), []);
});

test("F7: a services image must carry a sha256 digest", () => {
  assert.equal(checkSource(job("    services:\n      db:\n        image: redis:latest\n")).length, 1);
  assert.deepEqual(checkSource(job(`    services:\n      db:\n        image: redis@sha256:${DIGEST}\n`)), []);
});

test("F7: a docker:// services image is held to the same digest rule", () => {
  assert.equal(checkSource(job("    services:\n      db:\n        image: docker://redis:latest\n")).length, 1);
  assert.deepEqual(checkSource(job(`    services:\n      db:\n        image: docker://redis@sha256:${DIGEST}\n`)), []);
});
