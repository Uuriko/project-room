// G005: anomaly detection. Pure detector tests; no store, no delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, volumeHealth, AnomalyError } from "../server/growth-anomaly.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof AnomalyError && error.code === code);
const flat = (count, spikeAt = -1, spikeValue = 100) =>
  Array.from({ length: count }, (_, index) => ({ at: `t-${index}`, count: index === spikeAt ? spikeValue : 10 }));

test("a spike is detected against a flat baseline", () => {
  const { alerts, scored } = detectAnomalies(flat(30, 25), { window: 10, sensitivity: 3 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "spike");
  assert.equal(alerts[0].at, "t-25");
  assert.ok(alerts[0].message.includes("Spike"));
  assert.equal(scored.length, 20);
  assert.ok(Object.isFrozen(alerts) && Object.isFrozen(scored));
});
test("a drop is detected; flat series stay healthy", () => {
  const { alerts } = detectAnomalies(flat(30, 25, 0), { window: 10, sensitivity: 3 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "drop");
  const healthy = volumeHealth(flat(30), { window: 10 });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.alertCount, 0);
  const spiking = volumeHealth(flat(30, 28), { window: 10 });
  assert.equal(spiking.status, "spiking");
});
test("malformed inputs are refused", () => {
  throwsCode(() => detectAnomalies([], {}), "invalid_anomaly_input");
  throwsCode(() => detectAnomalies([{ at: "t", count: 1 }], {}), "invalid_anomaly_input");
  throwsCode(() => detectAnomalies([{ at: "t", count: -1 }, { at: "t2", count: 1 }, { at: "t3", count: 1 }], {}), "invalid_anomaly_input");
  throwsCode(() => detectAnomalies(flat(5), { window: 10 }), "invalid_anomaly_input");
  throwsCode(() => detectAnomalies(flat(10), { sensitivity: 0 }), "invalid_anomaly_input");
});
