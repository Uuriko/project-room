// Summary-first boot contract (RR-D3, staged client side).
//
// THE CONTRACT (summaryVersion 1) — what a summary-serving server returns
// for a GET on the room path (/api/rooms/{roomId}) with query
// view=summary, and what deriveBootSummary() derives locally from the
// windowed snapshot until one does (RR-D2's scoped-projection endpoint
// pairs with this shape):
//
//   { summaryVersion: 1, roomId, sequence, cursor, catchUpCursor,
//     viewerId, viewerAccountId, viewerAuthEpoch, viewerSessionBinding,
//     viewerSessionRevision, charter, replyRequestContractVersion,
//     messagesWindow, messagesPage,
//     detailOwed: ["work"],
//     workSummary: { total, byState: { <work state>: count } },
//     state: { room, members, channels, messages: [recent window], pins,
//              eventLog: [capped audit tail], workItems: {} } }
//
// The first paint (room header, channels, roster names, the recent
// message window) renders from this alone. Detail loads per view: the
// "work" detail is the existing scoped ?view=work projection, merged by
// mergeWorkDetail(); the full Record tail already loads per view through
// RoomClient.setAuditView("full"). Nothing here changes refresh
// behaviour after boot: the first ordinary snapshot read supersedes the
// summary and clears the owed set.

export const BOOT_SUMMARY_VERSION = 1;

// Views whose detail a boot summary can owe. "work" is the only one: the
// board's work items are the windowed snapshot's unbounded collection.
export const SUMMARY_DETAIL_VIEWS = Object.freeze(["work"]);

export function isBootSummary(read) {
  return Boolean(read) && read.summaryVersion === BOOT_SUMMARY_VERSION
    && Boolean(read.state) && typeof read.state === "object"
    && Array.isArray(read.detailOwed);
}

// Counts for the board before its detail loads: how much work the room
// holds, grouped by the same field board-ui groups on (item.state).
export function workSummaryOf(workItems) {
  const byState = {};
  let total = 0;
  for (const item of Object.values(workItems ?? {})) {
    if (!item || typeof item !== "object") continue;
    total++;
    const key = typeof item.state === "string" && item.state ? item.state : "unknown";
    byState[key] = (byState[key] ?? 0) + 1;
  }
  return { total, byState };
}

// Staged derivation: slim a windowed snapshot (the shape the room read
// with query messages=recent already serves) into the summary
// contract without another read. Only state.workItems is replaced — it
// is the one unbounded collection in the windowed state; messages are
// already windowed and byte-capped by the server, and the event log is
// the capped audit tail. The input snapshot is not mutated.
export function deriveBootSummary(read) {
  if (!read || typeof read !== "object" || !read.state || typeof read.state !== "object") return read;
  if (isBootSummary(read)) return read;
  const workItems = read.state.workItems ?? {};
  return {
    ...read,
    summaryVersion: BOOT_SUMMARY_VERSION,
    summaryStaged: true,
    detailOwed: [...SUMMARY_DETAIL_VIEWS],
    workSummary: workSummaryOf(workItems),
    state: { ...read.state, workItems: {} }
  };
}

// Merge one view's scoped detail into a summary snapshot. The "work"
// detail is the ?view=work payload ({ state: { room, members,
// workItems }, ...viewer fields }): its work items complete the board,
// and its members merge over the summary roster (same read model,
// fresher or equal). Returns a new snapshot; the owed set shrinks.
export function mergeWorkDetail(snapshot, detail) {
  if (!isBootSummary(snapshot) || !detail?.state?.workItems) return snapshot;
  const detailOwed = snapshot.detailOwed.filter(view => view !== "work");
  return {
    ...snapshot,
    detailOwed,
    state: {
      ...snapshot.state,
      members: { ...(snapshot.state.members ?? {}), ...(detail.state.members ?? {}) },
      workItems: detail.state.workItems
    }
  };
}
