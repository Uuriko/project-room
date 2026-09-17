// Historical event import/backfill (G018). A pure backfill tool: validate
// and normalize historical events for import into the analytics engine.
// Handles deduplication, timestamp normalization, and schema validation.
// The module is pure and dependency-free. Frozen outputs; malformed
// inputs throw BackfillError. Actual import wiring is a later slice.
class BackfillError extends Error { constructor(code, message) { super(message); this.name = "BackfillError"; this.code = code; } }
const fail = (code, message) => { throw new BackfillError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_backfill", message); };
// Validate and normalize events for backfill.
// events: [{ type, roomId, timestamp, userId?, metadata? }]
// Returns { valid, invalid, duplicates }
export function prepareBackfill({ events }) {
  check(Array.isArray(events), "events must be an array");
  const seen = new Set();
  const valid = [];
  const invalid = [];
  const duplicates = [];
  for (const e of events) {
    // Validate schema
    if (!e || typeof e !== "object" || typeof e.type !== "string" ||
        typeof e.roomId !== "string" || typeof e.timestamp !== "string" ||
        Number.isNaN(Date.parse(e.timestamp))) {
      invalid.push(e);
      continue;
    }
    // Deduplicate by type+roomId+timestamp+userId
    const key = `${e.type}|${e.roomId}|${e.timestamp}|${e.userId || ""}`;
    if (seen.has(key)) {
      duplicates.push(e);
      continue;
    }
    seen.add(key);
    // Normalize timestamp to ISO
    valid.push(Object.freeze({ type: e.type, roomId: e.roomId,
      timestamp: new Date(e.timestamp).toISOString(),
      userId: e.userId || null, metadata: e.metadata || null }));
  }
  return Object.freeze({ valid: Object.freeze(valid), invalid: Object.freeze(invalid),
    duplicates: Object.freeze(duplicates), validCount: valid.length,
    invalidCount: invalid.length, duplicateCount: duplicates.length });
}
export { BackfillError };
