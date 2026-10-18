import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, holm, mannWhitney, median, medianInterval, verdict } from "../scripts/bench/stats.mjs";

test("median and the order-statistic interval", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.deepEqual(medianInterval([5, 1, 4, 2, 3]), { low: 1, high: 5, exact: false }, "under 6 samples no 95% interval exists");
  const ci = medianInterval([1, 2, 3, 4, 5, 6]);
  assert.equal(ci.exact, true);
  assert.equal(ci.low, 1); assert.equal(ci.high, 6);
  const ten = medianInterval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([ten.low, ten.high], [2, 9]);
});

test("exact Mann-Whitney matches known values", () => {
  assert.equal(+mannWhitney([1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12]).p.toFixed(4), 0.0022, "fully separated 6 vs 6 is 2/924");
  assert.equal(mannWhitney([1, 2, 3], [1, 2, 3]).p, 1, "identical samples");
  assert.ok(mannWhitney([1, 3, 5, 7, 9, 11], [2, 4, 6, 8, 10, 12]).p > 0.5, "interleaved samples");
});

test("Holm adjustment and the verdict rule", () => {
  assert.deepEqual(holm([0.024, 0.087, 1, 0.18]).map(p => +p.toFixed(3)), [0.096, 0.261, 1, 0.36]);
  assert.deepEqual(holm([NaN, 0.01]).map(p => Number.isFinite(p) ? p : "nan"), ["nan", 0.01]);
  assert.equal(verdict(0.5, 0.001), "better");
  assert.equal(verdict(1.5, 0.001), "worse");
  assert.equal(verdict(1.05, 0.001), "~", "inside the 10% noise floor");
  assert.equal(verdict(2, 0.2), "~", "not significant");
  const c = compare([10, 11, 10, 12, 11, 10], [20, 21, 22, 20, 21, 23]);
  assert.equal(c.verdict, "worse"); assert.equal(c.ratio, 2);
});

test("a tiny fixture builds and one run reports every metric", { timeout: 60000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-smoke-"));
  try {
    const seeded = JSON.parse(execFileSync(process.execPath, ["scripts/bench/fixture.mjs", "--root", ".", "--size", "40", "--out", dir], { encoding: "utf8" }).trim().split("\n").at(-1));
    assert.equal(seeded.failed, 0);
    const run = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "scripts/bench/room-scale.mjs", "--root", ".", "--fixture", dir, "--writes", "10"], { encoding: "utf8" }).trim().split("\n").at(-1));
    for (const key of ["writeP50Ms", "storedProjectionMs", "coldRoomMs", "projectionKB", "snapshotKB", "httpFullKB", "httpRecentKB", "replayMs"]) {
      assert.ok(Number.isFinite(run[key]), `${key} measured`);
    }
    assert.equal(run.writeFailures, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("refused writes invalidate the whole write sample series without hiding read evidence", async () => {
  const { qualifiedSamples } = await import("../scripts/bench/validity.mjs");
  const samples = [{ writeFailures: 0, writeP50Ms: 10, coldRoomMs: 4 },
    { writeFailures: 1, writeP50Ms: 1, coldRoomMs: 5 }];
  assert.ok(qualifiedSamples(samples, "writeP50Ms", r => r.writeP50Ms).every(Number.isNaN));
  assert.deepEqual(qualifiedSamples(samples, "coldRoomMs", r => r.coldRoomMs), [4, 5]);
  samples[0].fixtureFailures = 1;
  assert.ok(qualifiedSamples(samples, "coldRoomMs", r => r.coldRoomMs).every(Number.isNaN));
});
