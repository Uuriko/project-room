// Claim thread (#5378): one ordered record per Board claim, so the claim is
// the unit that explains why the code exists. No new room type and no new
// storage: the thread is a read over what the claim already writes.
//
//   - room events: every committed claim change appends one
//     work_claim.updated event whose data.workClaim is the claim id
//     (server/work-claim-events.mjs). These are uncapped and ordered by
//     sequence: claim, review, CI, merge/close, release, close.
//   - claim history: the system stamps a few steps (pr_autolinked,
//     deploy_linked) only on the item's history, not as room events.
//
// Visibility is the claim read's: the thread exists only where
// GET /work-claims/{claimId} succeeds for the caller, and every entry is
// either a room-wide board event or a line of that claim's own history.
// Nothing here reads chat messages, so DMs and private replies cannot leak.

const HISTORY_ONLY = new Set(["pr_autolinked", "deploy_linked"]);
export const CLAIM_THREAD_LIMIT = 500;

// One kind per entry so a reader can scan the PR -> CI -> review -> merge ->
// deploy arc without parsing actions.
export function claimThreadKind(action, data = {}) {
  if (action === "pr_autolinked") return "pr";
  if (action === "deploy_linked") return "deploy";
  if (action === "ci_changed") return "ci";
  if (action === "reviewed") return "review";
  if (action === "pr_merged") return "merge";
  if (action === "pr_closed") return "pr";
  if (action === "state_changed" && data.reason === "ci_changed") return "ci";
  if (action === "state_changed" && data.reason === "reviewed") return "review";
  return "claim";
}

function eventEntry(row) {
  let event;
  try { event = JSON.parse(row.body); } catch { return null; }
  const data = event?.data ?? {};
  if (typeof data.action !== "string") return null;
  return {
    source: "event",
    sequence: row.sequence,
    at: event.at ?? null,
    actorId: event.actorId ?? null,
    kind: claimThreadKind(data.action, data),
    action: data.action,
    claimState: data.claimState ?? null,
    ...(data.reason ? { reason: data.reason } : {}),
    ...(data.ciState ? { ciState: data.ciState } : {}),
    ...(data.verdict ? { verdict: data.verdict } : {}),
    ...(data.pullRequest ? { pullRequest: { url: data.pullRequest.url ?? null, outcome: data.pullRequest.outcome ?? null } } : {}),
  };
}

function historyEntry(entry) {
  return {
    source: "history",
    sequence: null,
    at: entry.at ?? null,
    actorId: entry.agentId ?? "system",
    kind: claimThreadKind(entry.action),
    action: entry.action,
    note: entry.note ?? null,
  };
}

// Stable merge: events keep sequence order; a history-only step goes after
// every event at or before its own time, so ties keep the event first.
export function mergeClaimThread(eventEntries, historyEntries) {
  const out = [...eventEntries];
  for (const entry of historyEntries) {
    let index = out.length;
    while (index > 0 && entry.at !== null && (out[index - 1].at ?? "") > entry.at) index -= 1;
    out.splice(index, 0, entry);
  }
  return out;
}

export function claimThread(store, roomId, item, { limit = CLAIM_THREAD_LIMIT } = {}) {
  let rows = [];
  if (store?.db && typeof store.db.prepare === "function") {
    rows = store.db.prepare(
      "SELECT sequence, body FROM events WHERE room_id=? AND json_extract(body,'$.type')='work_claim.updated' AND json_extract(body,'$.data.workClaim')=? ORDER BY sequence DESC LIMIT ?")
      .all(roomId, item.id, limit + 1);
  }
  const truncated = rows.length > limit;
  const events = rows.slice(0, limit).reverse().map(eventEntry).filter(Boolean);
  const history = (item.history ?? []).filter(entry => HISTORY_ONLY.has(entry?.action)).map(historyEntry);
  const pulls = (Array.isArray(item.pullRequests) && item.pullRequests.length ? item.pullRequests : item.pullRequest ? [item.pullRequest] : [])
    .map(pull => ({ url: pull.url ?? null, outcome: pull.outcome ?? null }));
  return {
    roomId,
    claimId: item.id,
    title: item.title ?? item.id,
    state: item.state,
    owner: item.owner ?? null,
    pullRequests: pulls,
    truncated,
    entries: mergeClaimThread(events, history),
  };
}
