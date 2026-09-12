import { WORK_STATES as S } from "./events.js";
import { nextWorkStep, terminalWork } from "./workflow.js";

// Derived read model over the committed projection: every work item lands in
// exactly one column. A card is a description, never a grant or a dispatch.
export const BOARD_COLUMNS = Object.freeze(["handoff", "proposed", "accepted", "working", "blocked", "review", "done", "superseded"]);

export function projectBoard(state, now = Date.now()) {
  const columns = Object.fromEntries(BOARD_COLUMNS.map(name => [name, []]));
  for (const item of Object.values(state.workItems || {})) {
    const column = item.state === S.SUPERSEDED || item.supersededBy ? "superseded"
      : item.handoff?.open ? "handoff"
      : terminalWork(item) ? "done"
      : item.state === S.COMPLETED ? "review"
      : BOARD_COLUMNS.includes(item.state) ? item.state
      : "review";
    const next = nextWorkStep(item, now);
    columns[column].push({
      id: item.id, title: item.title, state: item.state, mode: item.mode,
      accountableMemberId: item.accountableMemberId, revision: item.revision,
      next: { action: next.action, label: next.label, memberId: next.memberId, role: next.role },
      ...(item.handoff?.open ? { handoff: {
        eventId: item.handoff.eventId, at: item.handoff.at, actorId: item.handoff.actorId,
        doneSummary: item.handoff.doneSummary,
        evidenceUrl: item.handoff.evidenceUrl ?? null, evidenceVersion: item.handoff.evidenceVersion ?? null,
        nextAction: item.handoff.nextAction, limitReason: item.handoff.limitReason,
        haltAll: item.handoff.haltAll === true } } : {})
    });
  }
  for (const list of Object.values(columns)) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts = Object.fromEntries(Object.entries(columns).map(([name, list]) => [name, list.length]));
  counts.total = Object.values(columns).reduce((sum, list) => sum + list.length, 0);
  const halts = Object.entries(state.agentHalts || {})
    .map(([memberId, halt]) => ({ memberId, eventId: halt.eventId, at: halt.at, reason: halt.reason, workItemId: halt.workItemId }))
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  return { contractVersion: 1, columns, counts, halts };
}
