// Executable access to the §2.3 legacy -> unified state mapping.
// The data lives in mapping.json (work-noun-mapping/1); this module is the
// applicator later U-lanes (U2 read projection first) consume. Pure data in,
// descriptor out — no product code is imported here on purpose: the mapping
// must stay checkable against the legacy enums even while they still exist.
import { readFileSync } from "node:fs";

export const MAPPING = JSON.parse(readFileSync(new URL("./mapping.json", import.meta.url), "utf8"));

export const UNIFIED_STATES = Object.freeze([...MAPPING.unified.states]);
export const UNIFIED_TERMINAL = Object.freeze([...MAPPING.unified.terminal]);
export const CLOSE_REASONS = Object.freeze([...MAPPING.unified.closeReasons]);
export const MACHINES = Object.freeze(Object.keys(MAPPING.machines));

export function mappingEntry(machine, legacyState) {
  const entry = MAPPING.machines[machine]?.states?.[legacyState];
  if (!entry) throw new Error(`work-noun mapping: no entry for ${machine}/${legacyState}`);
  return entry;
}

// The unified projection a legacy (machine, state) pair maps to, in the same
// shape the fixtures record as expectedUnified.
export function expectedUnified(machine, legacyState) {
  const entry = mappingEntry(machine, legacyState);
  if (entry.disposition === "carried") return { disposition: "carried", state: null, home: entry.home };
  if (entry.disposition === "dropped") return { disposition: "dropped", state: null, rationale: entry.rationale };
  return {
    disposition: "mapped",
    state: entry.unified,
    ...(entry.attributes ? { attributes: entry.attributes } : {}),
    ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
    ...(entry.settlement ? { settlement: entry.settlement } : {}),
    ...(entry.condition ? { condition: entry.condition } : {}),
  };
}
