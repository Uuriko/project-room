// Extended coalescing for high-frequency claim chatter (wave500
// event-survival W10 prototype). The DEFAULT claim path emits one room event
// per write, and work-claim-events.mjs already suppresses repeated note-only
// writes within 60 s; the ?fast=1 lane skips events entirely. This module is
// the middle ground: pure functions that merge rapid-fire same-claim update
// log entries into fewer room events without losing information. No store
// coupling — the caller keeps the log and asks what to emit.

const isFiniteNumber = value => Number.isFinite(value);

// coalesceUpdateLog merges consecutive same-claim update entries whose `at`
// timestamps fall within `windowMs` of the FIRST entry of the group. The
// merged entry carries the claim id and action, every note concatenated in
// order, the first/last timestamps, and the update count. A different claim
// id or action breaks the merge even inside the window; an entry arriving
// after the window starts a fresh group. Entries with no note contribute an
// empty string so the update count still matches the number of merged
// writes. Does not mutate the input.
export function coalesceUpdateLog(entries, { windowMs } = {}) {
  if (!Array.isArray(entries)) throw new Error("coalesceUpdateLog: entries must be a list");
  const window = isFiniteNumber(windowMs) && windowMs >= 0 ? windowMs : 60_000;
  const result = [];
  for (const entry of entries) {
    const claimId = entry?.claimId;
    const action = entry?.action;
    const at = isFiniteNumber(entry?.at) ? entry.at : 0;
    const note = typeof entry?.note === "string" ? entry.note : "";
    const current = result[result.length - 1];
    if (
      current &&
      current.claimId === claimId &&
      current.action === action &&
      at - current.firstAt >= 0 &&
      at - current.firstAt <= window
    ) {
      current.notes.push(note);
      current.lastAt = at;
      current.updateCount += 1;
      continue;
    }
    result.push({ claimId, action, notes: [note], firstAt: at, lastAt: at, updateCount: 1 });
  }
  return result;
}

// shouldEmitHeartbeat decides whether a stale-claim keepalive event should
// be emitted: suppress it while the last emission is fresher than the
// interval, emit it once the interval has elapsed (or when there was no
// previous emission). Pure: the caller records the emission time.
export function shouldEmitHeartbeat(lastEmitAt, nowMs, { intervalMs } = {}) {
  const interval = isFiniteNumber(intervalMs) && intervalMs >= 0 ? intervalMs : 60_000;
  if (!isFiniteNumber(lastEmitAt)) return true;
  if (!isFiniteNumber(nowMs)) return true;
  return nowMs - lastEmitAt >= interval;
}
