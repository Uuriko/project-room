// G016: cross-room benchmarks. Pure comparator tests.
import test from "node:test";
import assert from "node:assert/strict";
import { rankRooms, percentileBands, deltasVsBaseline, BenchmarkError } from "../server/benchmarks.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof BenchmarkError && error.code === code);

const rooms = [
  { roomId: "r1", metrics: { messages: 100 } },
  { roomId: "r2", metrics: { messages: 300 } },
  { roomId: "r3", metrics: { messages: 200 } },
];

test("rankRooms orders by metric descending", () => {
  const ranking = rankRooms({ rooms, metricKey: "messages" });
  assert.deepEqual(ranking.map(r => r.roomId), ["r2", "r3", "r1"]);
  assert.equal(ranking[0].rank, 1);
  assert.ok(Object.isFrozen(ranking));
});
test("percentileBands computes p50/p90/min/max", () => {
  const bands = percentileBands({ rooms, metricKey: "messages" });
  assert.equal(bands.min, 100);
  assert.equal(bands.max, 300);
  assert.equal(bands.p50, 200);
  assert.ok(bands.p90 > 200);
});
test("deltasVsBaseline computes absolute and pct deltas", () => {
  const deltas = deltasVsBaseline({ rooms, metricKey: "messages", baselineRoomId: "r1" });
  const r2 = deltas.find(d => d.roomId === "r2");
  assert.equal(r2.delta, 200);
  assert.equal(r2.deltaPct, 200);
  assert.ok(Object.isFrozen(deltas));
});
test("malformed inputs are refused", () => {
  throwsCode(() => rankRooms({ rooms: [], metricKey: "m" }), "invalid_benchmark");
  throwsCode(() => deltasVsBaseline({ rooms, metricKey: "messages", baselineRoomId: "ghost" }), "invalid_benchmark");
});
