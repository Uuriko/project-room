// telemetry/tripwire-contract.test.mjs — fail-first contract for WAVE-300 Worker B.
//
// Pins the trip-wire gauge REGISTRY CONTRACT before the gauges are built:
// the registry must exist at telemetry/gauges.mjs and expose the 5 trip-wire
// gauges by name, each with a {value, threshold, status} shape.
//
// This test is RED until Worker B lands the gauge registry. That failure is
// expected and documented — do not fake it green by creating a stub module
// that satisfies the assertions without real gauge logic.
//
// Run: node --test telemetry/tripwire-contract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// Canonical trip-wire gauge names pinned by WAVE-300 (telemetry productionization).
const EXPECTED_GAUGES = [
  "event-budget-low",            // remaining event budget for the round
  "write-limiter-penalty-box",   // limiter penalty-box occupancy
  "sse-event-loop-saturation",   // SSE dispatch event-loop saturation
  "projection-size-growth",      // projection document size growth
  "commands-silent-timeout-rate" // /commands silent-timeout rate
];

const VALID_STATUSES = ["ok", "warn", "trip"];

async function loadRegistry() {
  try {
    const mod = await import("./gauges.mjs");
    return mod.gauges ?? mod.default ?? null;
  } catch {
    return null;
  }
}

test("trip-wire gauge registry exists at telemetry/gauges.mjs", async () => {
  const gauges = await loadRegistry();
  assert.ok(
    gauges,
    "RED: telemetry/gauges.mjs does not exist yet — Worker B: implement the trip-wire gauge registry"
  );
});

test("registry exposes all 5 trip-wire gauges by name", async () => {
  const gauges = await loadRegistry();
  assert.ok(gauges, "registry missing (see registry-exists test)");
  for (const name of EXPECTED_GAUGES) {
    assert.ok(
      gauges[name] !== undefined && gauges[name] !== null,
      `registry missing trip-wire gauge "${name}"`
    );
  }
});

test("each gauge exposes the {value, threshold, status} shape", async () => {
  const gauges = await loadRegistry();
  assert.ok(gauges, "registry missing (see registry-exists test)");
  for (const name of EXPECTED_GAUGES) {
    const g = gauges[name];
    assert.ok(g, `gauge "${name}" missing`);
    assert.equal(typeof g.value, "number", `"${name}".value must be a number`);
    assert.equal(typeof g.threshold, "number", `"${name}".threshold must be a number`);
    assert.ok(
      VALID_STATUSES.includes(g.status),
      `"${name}".status must be one of ${VALID_STATUSES.join(", ")} (got ${JSON.stringify(g.status)})`
    );
  }
});
