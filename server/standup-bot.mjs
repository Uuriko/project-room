// Async standup collector (K023). A pure standup bot: collect daily
// updates (yesterday/today/blockers) per participant, track who has
// submitted, and compile a digest. All state is caller-owned (a Map); the
// module is pure and dependency-free. Frozen outputs; malformed inputs
// throw StandupError. Scheduling/notification wiring is a later slice.
class StandupError extends Error { constructor(code, message) { super(message); this.name = "StandupError"; this.code = code; } }
const fail = (code, message) => { throw new StandupError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_standup", message); };
// Create a standup collector. store is a caller-owned Map (date -> { participants, updates }).
export function createStandup({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const days = store ?? new Map();
  const getDay = date => {
    check(typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date), "date must be YYYY-MM-DD");
    if (!days.has(date)) {
      days.set(date, { date, participants: [], updates: new Map() });
    }
    return days.get(date);
  };
  // Set the expected participants for a date.
  const setParticipants = (date, { participantIds }) => {
    const day = getDay(date);
    check(Array.isArray(participantIds) && participantIds.length > 0,
      "participantIds must be a non-empty array");
    check(participantIds.every(id => typeof id === "string" && id.length > 0),
      "every participantId must be a non-empty string");
    day.participants = [...new Set(participantIds)];
    return Object.freeze({ date, participants: Object.freeze(day.participants) });
  };
  // Submit a standup update.
  const submit = (date, { participantId, yesterday, today, blockers }) => {
    const day = getDay(date);
    check(typeof participantId === "string" && participantId.length > 0,
      "participantId must be a non-empty string");
    check(typeof yesterday === "string" && typeof today === "string",
      "yesterday and today must be strings");
    check(blockers === undefined || typeof blockers === "string",
      "blockers must be a string if given");
    check(!day.updates.has(participantId), `participant "${participantId}" already submitted for ${date}`);
    const update = Object.freeze({ participantId, yesterday: yesterday.trim(),
      today: today.trim(), blockers: (blockers ?? "").trim() });
    day.updates.set(participantId, update);
    return update;
  };
  // List participants who have not submitted.
  const missing = date => {
    const day = getDay(date);
    const submitted = new Set(day.updates.keys());
    return Object.freeze(day.participants.filter(id => !submitted.has(id)));
  };
  // Compile a digest of all updates.
  const digest = date => {
    const day = getDay(date);
    const updates = [...day.updates.values()];
    const withBlockers = updates.filter(u => u.blockers.length > 0);
    return Object.freeze({ date, submittedCount: updates.length,
      participantCount: day.participants.length,
      updates: Object.freeze(updates),
      blockers: Object.freeze(withBlockers.map(u =>
        Object.freeze({ participantId: u.participantId, blockers: u.blockers }))) });
  };
  return Object.freeze({ setParticipants, submit, missing, digest });
}
export { StandupError };
