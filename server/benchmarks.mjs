// Cross-room benchmarks (G016). A pure benchmark comparator: take per-
// room metric snapshots and compute rankings, percentiles, and deltas vs
// a baseline room. The module is pure and dependency-free. Frozen outputs;
// malformed inputs throw BenchmarkError. Dashboard wiring is a later slice.
class BenchmarkError extends Error { constructor(code, message) { super(message); this.name = "BenchmarkError"; this.code = code; } }
const fail = (code, message) => { throw new BenchmarkError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_benchmark", message); };
// Rank rooms by a metric (higher is better). rooms is [{ roomId, metrics: { <key>: number } }].
export function rankRooms({ rooms, metricKey }) {
  check(Array.isArray(rooms) && rooms.length > 0, "rooms must be a non-empty array");
  check(typeof metricKey === "string" && metricKey.length > 0, "metricKey must be a non-empty string");
  for (const room of rooms) {
    check(room !== null && typeof room === "object", "every room must be an object");
    check(typeof room.roomId === "string" && room.roomId.length > 0, "every room must have roomId");
    check(room.metrics !== null && typeof room.metrics === "object", "every room must have metrics");
    check(typeof room.metrics[metricKey] === "number" && Number.isFinite(room.metrics[metricKey]),
      `metric "${metricKey}" must be a finite number for every room`);
  }
  const sorted = [...rooms].sort((a, b) => b.metrics[metricKey] - a.metrics[metricKey]);
  return Object.freeze(sorted.map((room, index) => Object.freeze({
    roomId: room.roomId, rank: index + 1, value: room.metrics[metricKey] })));
}
// Compute percentile bands for a metric across rooms.
export function percentileBands({ rooms, metricKey }) {
  const ranking = rankRooms({ rooms, metricKey });
  const values = ranking.map(r => r.value).sort((a, b) => a - b);
  const percentile = p => {
    const index = (p / 100) * (values.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    return values[lower] + (values[upper] - values[lower]) * (index - lower);
  };
  return Object.freeze({ metricKey, count: values.length,
    p50: percentile(50), p75: percentile(75), p90: percentile(90), min: values[0], max: values[values.length - 1] });
}
// Delta of each room vs a baseline room (by roomId).
export function deltasVsBaseline({ rooms, metricKey, baselineRoomId }) {
  check(typeof baselineRoomId === "string" && baselineRoomId.length > 0,
    "baselineRoomId must be a non-empty string");
  const baseline = rooms.find(r => r.roomId === baselineRoomId);
  check(baseline !== undefined, `baseline room "${baselineRoomId}" not found`);
  const baselineValue = baseline.metrics[metricKey];
  return Object.freeze(rooms.map(room => Object.freeze({
    roomId: room.roomId, value: room.metrics[metricKey],
    delta: room.metrics[metricKey] - baselineValue,
    deltaPct: baselineValue === 0 ? null : ((room.metrics[metricKey] - baselineValue) / Math.abs(baselineValue)) * 100 })));
}
export { BenchmarkError };
