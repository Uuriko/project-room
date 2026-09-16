// Anomaly detection on event volume (G005). A pure spike/drop detector over
// a time series of event counts: each point is scored against a rolling
// baseline (mean and standard deviation of the preceding window), and points
// whose z-score exceeds the sensitivity threshold become alerts (spike when
// above, drop when below). The caller supplies the series — no store reads.
// Pure, dependency-free, deterministic; frozen outputs. Alert delivery
// (G003) is a later slice.
class AnomalyError extends Error { constructor(code, message) { super(message); this.name = "AnomalyError"; this.code = code; } }
const fail = (code, message) => { throw new AnomalyError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_anomaly_input", message); };

const seriesOf = value => {
  check(Array.isArray(value) && value.length >= 3 && value.length <= 100000, "series must be a list of 3..100000 points");
  return value.map((point, index) => {
    check(point !== null && typeof point === "object", `point ${index} must be an object`);
    check(typeof point.at === "string" && point.at.length > 0, `point ${index} needs an at timestamp`);
    check(typeof point.count === "number" && Number.isFinite(point.count) && point.count >= 0, `point ${index} count must be a non-negative number`);
    return { at: point.at, count: point.count };
  });
};
const optionsOf = value => {
  const options = value ?? {};
  check(options !== null && typeof options === "object", "options must be an object");
  const window = options.window ?? 24;
  const sensitivity = options.sensitivity ?? 3;
  check(Number.isInteger(window) && window >= 2 && window <= 1000, "window must be an integer 2..1000");
  check(typeof sensitivity === "number" && sensitivity > 0 && sensitivity <= 10, "sensitivity must be 0..10");
  return { window, sensitivity };
};
const stats = values => {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return { mean, stddev: Math.sqrt(variance) };
};
// Detect anomalies. Each point from index `window` onward is scored against
// the `window` points before it. Returns { alerts, scored }.
export function detectAnomalies(series, options) {
  const points = seriesOf(series);
  const { window, sensitivity } = optionsOf(options);
  check(points.length > window, "series must be longer than the baseline window");
  const alerts = [], scored = [];
  for (let index = window; index < points.length; index++) {
    const baseline = points.slice(index - window, index).map(point => point.count);
    const { mean, stddev } = stats(baseline);
    const point = points[index];
    const zScore = stddev === 0 ? (point.count === mean ? 0 : (point.count > mean ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY)) : (point.count - mean) / stddev;
    const scoredPoint = Object.freeze({ at: point.at, count: point.count,
      baselineMean: mean, baselineStddev: stddev, zScore });
    scored.push(scoredPoint);
    if (Math.abs(zScore) >= sensitivity) {
      alerts.push(Object.freeze({ ...scoredPoint,
        kind: zScore > 0 ? "spike" : "drop",
        message: `${zScore > 0 ? "Spike" : "Drop"} at ${point.at}: ${point.count} vs baseline ${mean.toFixed(1)} (z=${Number.isFinite(zScore) ? zScore.toFixed(2) : (zScore > 0 ? "∞" : "-∞")})` }));
    }
  }
  return Object.freeze({ window, sensitivity, alerts: Object.freeze(alerts), scored: Object.freeze(scored) });
}
// Summarize: is the latest stretch healthy, spiking, or dropping?
export function volumeHealth(series, options) {
  const { alerts, scored } = detectAnomalies(series, options);
  const recent = alerts.slice(-3);
  const status = recent.some(alert => alert.kind === "spike") ? "spiking"
    : recent.some(alert => alert.kind === "drop") ? "dropping" : "healthy";
  return Object.freeze({ status, alertCount: alerts.length,
    latest: scored.length > 0 ? scored[scored.length - 1] : null,
    recentAlerts: Object.freeze(recent) });
}
export { AnomalyError };
