// Board triage queue (Linear parity: Triage). Off unless ROOM_BOARD_TRIAGE=1.
//
// `queue=triage` on the Board claim list returns open tasks nobody has acted
// on since they were opened: unclaimed, unheld, and whose history is still
// only the "created" stamp. Oldest first, so the longest-waiting task is
// triaged first. Each item carries a derived `triage` note: how long it has
// waited and what it is missing (acceptance criteria, tags, an opener).
//
// Derived and read-only: there is no triage state to store or sync. Any
// existing action on the task (claim, update, reassign, close or cancel)
// adds a history stamp and so takes it out of the queue.
export const boardTriageEnabled = (env = process.env) => env?.ROOM_BOARD_TRIAGE === "1";

function untouched(item) {
  if (!item || item.state !== "unclaimed" || item.owner) return false;
  if (item.historyOmitted) return false;
  const history = Array.isArray(item.history) ? item.history : [];
  return history.length <= 1 && (history.length === 0 || history[0]?.action === "created");
}

function openedAt(item) {
  const t = Date.parse(item?.history?.[0]?.at ?? item?.createdAt ?? item?.updatedAt);
  return Number.isFinite(t) ? t : null;
}

export function triageNote(item, nowMs) {
  const opened = openedAt(item);
  const missing = [];
  if (!Array.isArray(item.acceptanceCriteria) || item.acceptanceCriteria.length === 0) missing.push("acceptance_criteria");
  if (!Array.isArray(item.tags) || item.tags.length === 0) missing.push("tags");
  const opener = item?.history?.[0]?.agentId;
  if (typeof opener !== "string" || opener === "system") missing.push("opener");
  return Object.freeze({ openedAt: opened === null ? null : new Date(opened).toISOString(),
    waitingMs: opened === null ? null : Math.max(0, nowMs - opened), missing: Object.freeze(missing) });
}

export function triageClaims(items, nowMs) {
  return (items ?? []).filter(untouched)
    .map(item => ({ item, at: openedAt(item) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
    .map(({ item }) => ({ ...item, triage: triageNote(item, nowMs) }));
}
