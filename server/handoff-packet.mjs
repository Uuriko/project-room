// Optional get_room_context handoff view (ROOM_HANDOFF_PACKET, default off).
// Composes existing authorized reads only. Board data is caller-owned summaries,
// not all open claims or repository/lease detail. Normalized omissions and work
// windows remain explicit; no new read source, grant, storage or write.

export const DECISION_TYPES = Object.freeze(["decision.recorded", "owner.decision_recorded"]);
const MAX_DECISIONS = 20;
const MAX_CLAIMS = 50;
const DECISION_WINDOW_MS = 30 * 24 * 3600 * 1000;
const MAX_PAGES = 10;

export function handoffPacketEnabled(env = globalThis.process?.env ?? {}) {
  const value = String(env?.ROOM_HANDOFF_PACKET ?? "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "on";
}

const text = (value, max = 500) => (typeof value === "string" ? value.slice(0, max) : null);

export function decisionOf(event) {
  const data = event?.data ?? {};
  return Object.freeze({
    sequence: event?.sequence ?? null,
    at: event?.at ?? null,
    actorId: event?.actorId ?? null,
    type: event?.type ?? null,
    statement: text(data.statement) ?? text(data.decision) ?? text(data.outcome),
    note: text(data.note),
    workItemId: text(data.workItemId, 128),
    sourceMessageId: text(data.sourceMessageId, 128)
  });
}

function claimOf(item) {
  if (!item || typeof item !== "object") return null;
  return Object.freeze({
    id: item.id ?? item.workItemId ?? null,
    title: text(item.title, 200),
    state: item.state ?? null
  });
}

// Collect decision events newest-last from a bounded window. `readPage(after)`
// returns { events, next, hasMore } (store.eventsAfter with a type filter).
export function collectDecisions(readPage, { max = MAX_DECISIONS, maxPages = MAX_PAGES } = {}) {
  const found = [];
  let after = 0, pages = 0, truncated = false;
  for (;;) {
    const page = readPage(after);
    pages += 1;
    for (const row of page?.events ?? []) {
      // store.eventsAfter rows are { sequence, event }; accept bare events too.
      const event = row?.event ? { ...row.event, sequence: row.sequence ?? row.event.sequence } : row;
      if (DECISION_TYPES.includes(event?.type)) found.push(decisionOf(event));
    }
    if (!page?.hasMore || typeof page.next !== "number" || page.next <= after) break;
    if (pages >= maxPages) { truncated = true; break; }
    after = page.next;
  }
  return { decisions: found.slice(-max), total: found.length, truncated };
}

export function buildHandoffPacket({ context: raw, decisions, now = Date.now() }) {
  // get_room_context nests the caller-scoped orientation under `orient`.
  const context = { ...(raw?.orient ?? {}), viewerId: raw?.viewerId ?? raw?.orient?.member?.id, roomId: raw?.roomId, cursors: raw?.cursors ?? raw?.orient?.cursors };
  const viewerId = context?.viewerId ?? context?.member?.id ?? null;
  const claimsKnown = Array.isArray(context.claims) && !context.omitted?.includes("board_claims");
  const claims = claimsKnown ? context.claims.map(claimOf).filter(Boolean) : null;
  const workWindow = raw?.workWindow ?? context.workWindow ?? null;
  const workScope = raw?.workScope ?? context.workScope ?? "caller_work_summaries";
  const omitted = [...new Set([...(raw?.omitted ?? []), ...(context.omitted ?? [])])];
  const openWork = Array.isArray(context?.workItems) ? context.workItems : [];
  const roomId = context?.roomId ?? context?.room?.slug ?? null;
  return {
    contract: { name: "project-room/handoff-packet", version: 1 },
    roomId,
    viewerId,
    rules: {
      charter: context?.instructions?.charter ?? null,
      pinned: context?.instructions?.pinned ?? null
    },
    decisions: decisions?.decisions ?? [],
    decisionsTotal: decisions?.truncated ? null : decisions?.total ?? null,
    decisionsObserved: decisions?.total ?? 0,
    decisionsWindowDays: DECISION_WINDOW_MS / (24 * 3600 * 1000),
    decisionsTruncated: decisions?.truncated === true,
    claims: { scope: claimsKnown ? "caller_owned_summaries" : "omitted",
      yours: claimsKnown ? claims.slice(0, MAX_CLAIMS) : null,
      total: claimsKnown ? claims.length : null,
      truncated: claimsKnown ? claims.length > MAX_CLAIMS : null },
    workScope, workWindow, omitted,
    yourWork: openWork.slice(0, MAX_CLAIMS).map(item => ({ ...item,
      nextRead: { tool: "room_read_work", arguments: { roomId, workItemId: item.id } } })),
    cursors: context?.cursors ?? null,
    next: [
      ...(workWindow?.nextRead ? [{ ...workWindow.nextRead,
        arguments: { ...workWindow.nextRead.arguments, view: "handoff" } }] : [])
    ],
    generatedAt: new Date(now).toISOString()
  };
}

export function decisionWindowStart(now = Date.now()) {
  return new Date(now - DECISION_WINDOW_MS).toISOString();
}
