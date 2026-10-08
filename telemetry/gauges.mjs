// telemetry/gauges.mjs — WAVE-300 trip-wire gauge registry CONTRACT.
//
// Canonical kebab-case gauge names + { value, threshold, status } shape
// pinned by telemetry/tripwire-contract.test.mjs (status enum ok|warn|trip).
//
// The live registry is the in-process trip-wire registry from
// server/tripwires.mjs (zero room events, zero read-path writes); this module
// owns the single shared singleton and exposes the contract-shaped view over
// it. server/http.mjs imports the same `tripwires` singleton so its hook
// points (write-limiter refusals, /commands outcomes, the slow store tick)
// feed the exact registry this view reads. `gauges` is a live view: each
// access recomputes { value, threshold, status } from the registry.
//
// Contract name -> internal gauge name. `threshold` is the trip threshold
// (internal criticalAt): the value at which status flips to "trip".

import { createTripwires } from "../server/tripwires.mjs";
import { PILOT_LIMITS } from "../server/store.mjs";

export const tripwires = createTripwires({ limits: PILOT_LIMITS });

const CONTRACT_VIEW = [
  ["event-budget-low", "event_budget_remaining_ratio"],
  ["write-limiter-penalty-box", "write_limiter_penalty_entries"],
  ["sse-event-loop-saturation", "event_loop_delay_ms_p99"],
  ["projection-size-growth", "projection_bytes_ratio"],
  ["commands-silent-timeout-rate", "commands_silent_timeout_ratio"],
];

function toContractStatus(status) {
  if (status === "critical") return "trip";
  if (status === "warn") return "warn";
  return "ok"; // "ok", and "unknown" (no data yet reads as nominal)
}

export const gauges = {};
for (const [contractName, internalName] of CONTRACT_VIEW) {
  Object.defineProperty(gauges, contractName, {
    enumerable: true,
    configurable: false,
    get() {
      const g = tripwires.gauge(internalName);
      return { value: g.value, threshold: g.criticalAt, status: toContractStatus(g.status) };
    },
  });
}
export default gauges;
