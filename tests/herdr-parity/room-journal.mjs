// Append-only room event journal fixture for the parity suite.
// Both drivers append to the same vocabulary; the suite compares the
// resulting event sequences exactly. Vocabulary is grounded in the room's
// own session event types (src/work-item-session.js SESSION_EVENT_TYPES)
// plus the claim-board events the room journals alongside them.
export const JOURNAL_TYPES = Object.freeze([
  "work.claimed",
  "work.state_changed",
  "work.done",
  "session.started",
  "session.status_changed",
  "session.heartbeat",
  "session.stopped",
  "heartbeat.recorded",
]);

export function createRoomJournal(clock) {
  const entries = [];
  return {
    append(type, actor, detail = null) {
      if (!JOURNAL_TYPES.includes(type)) throw new Error(`unknown journal type: ${type}`);
      entries.push(Object.freeze({ seq: entries.length + 1, type, actor, at: clock.iso(), detail }));
    },
    get entries() { return entries; },
    types() { return entries.map(e => e.type); },
    // Entries appended since `fromSeq` (exclusive) — the per-step delta.
    since(fromSeq) { return entries.filter(e => e.seq > fromSeq); },
  };
}
