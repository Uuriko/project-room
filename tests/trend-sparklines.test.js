// G015: trend sparklines. Pure SVG tests.
import test from "node:test";
import assert from "node:assert/strict";
import { sparkline, SparklineError } from "../server/sparklines.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SparklineError && error.code === code);

test("sparkline emits valid SVG with scaled points", () => {
  const svg = sparkline({ values: [1, 2, 3, 2, 1] });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.ok(svg.includes("<polyline"));
  assert.ok(svg.includes('stroke="#2563eb"'));
  // max value maps to y=0.00, min to y=30.00
  assert.ok(svg.includes("0.00,30.00")); // first point (min)
  assert.ok(svg.includes("50.00,0.00")); // middle point (max)
});
test("flat series does not divide by zero", () => {
  const svg = sparkline({ values: [5, 5, 5] });
  assert.ok(svg.includes("<polyline"));
});
test("malformed inputs are refused", () => {
  throwsCode(() => sparkline({ values: [] }), "invalid_sparkline");
  throwsCode(() => sparkline({ values: [1, "x"] }), "invalid_sparkline");
  throwsCode(() => sparkline({ values: [1], width: 0 }), "invalid_sparkline");
});
