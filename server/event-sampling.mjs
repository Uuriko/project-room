// Event sampling (G019). A pure deterministic sampler for high-volume
// rooms: given a stream of events, keep a representative sample using
// deterministic hash-based sampling (no randomness, stable across runs).
// sampleRate is 0-1 (e.g. 0.1 keeps ~10%). The module is pure and
// dependency-free. Frozen outputs; malformed inputs throw SampleError.
// Pipeline integration is a later slice.
import { createHash } from "node:crypto";
class SampleError extends Error { constructor(code, message) { super(message); this.name = "SampleError"; this.code = code; } }
const fail = (code, message) => { throw new SampleError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_sample", message); };
// Deterministic hash of a string to [0, 1).
function hash01(input) {
  const digest = createHash("sha256").update(input, "utf8").digest();
  // Use first 6 bytes as a 48-bit integer.
  const int = digest.readUIntBE(0, 6);
  return int / 0x1000000000000;
}
// Decide whether an event is kept. eventId must be a stable unique id.
export function shouldKeep({ eventId, sampleRate }) {
  check(typeof eventId === "string" && eventId.length > 0, "eventId must be a non-empty string");
  check(typeof sampleRate === "number" && sampleRate >= 0 && sampleRate <= 1,
    "sampleRate must be 0-1");
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return hash01(eventId) < sampleRate;
}
// Sample an array of events (each must have eventId).
export function sampleEvents({ events, sampleRate }) {
  check(Array.isArray(events), "events must be an array");
  const kept = events.filter(event => {
    check(event !== null && typeof event === "object", "every event must be an object");
    return shouldKeep({ eventId: event.eventId, sampleRate });
  });
  return Object.freeze({ kept: Object.freeze(kept), keptCount: kept.length, totalCount: events.length,
    sampleRate });
}
export { SampleError };
