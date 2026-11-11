import test from "node:test";
import assert from "node:assert/strict";
import { pct } from "../scripts/measure-baseline.mjs";

test("measure-baseline pct uses nearest-rank percentiles", () => {
  const v = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(pct(v, 50), 10);
  assert.equal(pct(v, 95), 19);
  assert.equal(pct([], 50), null);
  assert.equal(pct([7], 95), 7);
});
