// AvailableWork — the ONE read projection for "what work can I take?"
// (EXECUTION-BRIEF decision #5; simplification audits S2 §5, S8 §3).
//
// Before this module, every discovery surface answered that question by
// querying a different store with a different filter: the activation pack
// read only Work Items (#3020), orient read Work Items plus the viewer's
// own board claims, the public list read only public_work_tasks (#2988),
// and needs-me alone counted unclaimed board claims. A surface could not
// express "nothing is claimable anywhere" because no surface saw anywhere.
//
// This projection computes availability ONCE, over the work stores, and
// emits one shape. Execution stays with the engines — each item carries
// a claimAction descriptor naming the route that acts on it, so reads
// unify while writes keep their semantics. Availability rule, aligned
// to the strictest proven definition (needs-me's openWorkOf,
// server/needs-me.mjs):
//   board claim  — not invalidated (no premiseFlag, not supersededBy),
//                  state "unclaimed", kind "work", every dependsOn done,
//                  and (when a viewer is named) the viewer may write claims.
//   public task  — the facade packet's claim.state is "unclaimed" (no
//                  submitted receipt, no live owner after lease release).
// Work items are not a separate source: decision #10 migrated them onto
// the board (server/work-item-board.mjs), so an accepted work item IS a
// board claim here — one definition, no dual-source divergence.
// Titles are member-authored: every item is marked untrusted.
//
// NAMED EXCEPTIONS (redesign charter B-2): discovery surfaces whose
// semantics are NOT "what work can I take?" keep their own reads, by
// decision rather than by drift. Repointing either would change what
// the surface means, so both are recorded here and pinned by
// tests/available-work-exceptions.test.js; a future repoint must
// update this registry in the same change.
//   - The public opportunities feed (server/opportunities.mjs,
//     GET /api/opportunities.json) is an INVITATION surface: it lists
//     work items carrying an open helpWanted invitation in ANY
//     non-terminal state (including work already held and in progress)
//     and bounties in proposed/funded states. Acting on an opportunity
//     uses the invite/join flow — its items have no claimAction, and
//     "help wanted on held work" is exactly what this projection must
//     never call available.
//   - Room matchmaking (server/work-matchmaking.mjs, mounted by
//     server/matchmaking-routes.mjs) matches a declared seeker against
//     member-DECLARED openings (work-declarations terms rows). It reads
//     no work store at all: undeclared work is invisible to it by
//     design, and an opening's declared `open` flag — not store
//     availability — is its candidate rule.
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";

export const AVAILABLE_WORK_SOURCES = ["board", "publicTask"];

const usableClaim = item => Boolean(item) && !item.premiseFlag && !item.supersededBy;

// The board-availability predicate, exported so needs-me can consume the
// exact same test instead of its private copy (E1 PR-2). Returns the
// claim rows from `board` (a store.workClaims.list() result) that are
// claimable right now, in board order.
export function availableBoardRows(board) {
  const list = Array.isArray(board) ? board : [];
  const done = new Set(list.filter(item => usableClaim(item) && item.state === "done").map(item => item.id));
  return list.filter(item => usableClaim(item)
    && item.state === "unclaimed"
    && (item.kind ?? "work") === "work"
    && (item.dependsOn ?? []).every(dep => done.has(dep)));
}

const boardItem = (roomId, item) => ({
  id: item.id,
  title: item.title ?? item.id,
  source: "board",
  roomId,
  state: item.state,
  owner: null,
  leaseExpiresAt: null,
  untrusted: true,
  claimAction: {
    method: "POST",
    endpoint: `/api/rooms/${roomId}/work-claims/${item.id}/claim`,
    params: { requestId: "<uuid>" }
  }
});

const publicTaskItem = packet => ({
  id: packet.taskId,
  title: packet.title ?? packet.taskId,
  source: "publicTask",
  roomId: packet.namespaceId,
  state: "unclaimed",
  owner: null,
  leaseExpiresAt: packet.claim?.leaseExpiresAt ?? null,
  terms: { termsVersion: packet.termsVersion, generation: packet.claim?.generation },
  // Ranking-layer fields (redesign charter B-2): the packet facts a
  // consumer ranking over this projection needs — repository and paths
  // for overlap checks, acceptance criteria for preference scoring — so
  // no ranking consumer re-reads the facade to score what the
  // projection already classified.
  repositoryUrl: packet.repositoryUrl ?? null,
  repositoryRef: packet.repositoryRef ?? null,
  files: packet.files ?? [],
  acceptanceCriteria: packet.acceptanceCriteria ?? [],
  untrusted: true,
  claimAction: {
    method: "POST",
    endpoint: `/api/public-work/tasks/${packet.taskId}/claim`,
    params: { requestId: "<uuid>" }
  }
});

// May this viewer take board work in the room? Mirrors needs-me's gate:
// no named viewer (public/internal reads) means no viewer narrowing.
function viewerMayClaim(state, viewerId) {
  if (!viewerId) return true;
  const member = state?.members?.[viewerId];
  if (!member) return false;
  return mayWriteWorkClaims({ member: { ...member, id: viewerId }, ownerId: state?.room?.ownerId ?? null });
}

// All available board items from a board the caller already listed —
// orientation builders list the board once for their own-claims sections,
// and a list() read is the expensive part (needs-me measured 80-175ms at
// 400 claims), so the projection never forces a second read.
export function availableClaimsFromBoard(board, roomId, { viewerId = null, state = null } = {}) {
  if (!viewerMayClaim(state, viewerId)) return [];
  return availableBoardRows(board).map(item => boardItem(roomId, item));
}

// Room-scoped AvailableWork: board claims for one room. Returns
// { items, total } — an empty items list with total 0 is the explicit
// zero-inventory signal (the #2988 state, now expressible).
//
// Decision #10, final consumer step: this read is BOARD-ONLY. It used
// to union a second source (projection work items read straight from
// state.workItems); the migration (backfill + write-path sync in
// server/work-item-board.mjs) puts every accepted-or-later work item on
// the board, so the board is the one availability definition (decision
// #5) with no second source to diverge or double-count. The `now`
// option is accepted for caller compatibility and no longer consulted:
// board availability is a property of the stored rows.
export function availableWorkInRoom(store, roomId, { viewerId = null, limit = 50 } = {}) {
  const { state } = store.room(roomId);
  let board = [];
  try { board = store.workClaims?.list?.(roomId) ?? []; } catch { board = []; }
  const claims = availableClaimsFromBoard(board, roomId, { viewerId, state });
  return { items: claims.slice(0, limit), total: claims.length };
}

// Just the board portion of a room's available work, in the compact shape
// orientation surfaces have carried since #3020 (plus source/claimAction).
// buildOrient and buildActivationPack both consume this — one definition,
// so the two surfaces cannot diverge again.
export function availableClaimsInRoom(store, roomId, { viewerId = null, limit = 50 } = {}) {
  let board = [];
  try { board = store.workClaims?.list?.(roomId) ?? []; } catch { return []; }
  let state = null;
  try { state = store.room(roomId)?.state ?? null; } catch { state = null; }
  return availableClaimsFromBoard(board, roomId, { viewerId, state }).slice(0, limit);
}

// Cross-room public pool: published public-work tasks whose packet claim
// state is "unclaimed". Scans the facade's own paginated list so the
// availability classification stays the facade's (packet()). This arm is
// LIVE (redesign charter B-2): it is the availability authority for the
// public board's claimable read (PublicWorkClaims.listClaimable) and for
// the public-work matcher's candidate window (PublicWorkClaims.match).
//
// Two read modes over the one classification:
//  - full (default): enumerate every facade page; `total` is the exact
//    unclaimed count and `items` its first `limit` entries, in the
//    facade's own claimable-first order.
//  - window ({ window: true, after }): exactly one facade page in
//    offer_id order (claimableFirst: false) — the bounded window the
//    matcher ranks over. Returns that page's unclaimed items plus the
//    window facts the ranking layer needs (inspected, hasMore,
//    nextCursor); scoring and ordering stay with the caller.
export function availablePublicTasks(store, { limit = 50, after = "", window = false } = {}) {
  const facade = store.publicWorkClaims;
  if (!facade?.list) {
    return window ? { items: [], total: 0, inspected: 0, hasMore: false, nextCursor: null } : { items: [], total: 0 };
  }
  if (window) {
    const page = facade.list({ limit: 100, after, claimableFirst: false });
    const tasks = page?.tasks ?? [];
    const items = tasks.filter(packet => packet?.claim?.state === "unclaimed").map(publicTaskItem);
    return { items, total: items.length, inspected: tasks.length,
      hasMore: page?.nextCursor != null, nextCursor: page?.nextCursor ?? null };
  }
  const all = [];
  let cursor = after;
  for (;;) {
    const page = facade.list({ limit: 100, after: cursor });
    const tasks = page?.tasks ?? [];
    for (const packet of tasks) {
      if (packet?.claim?.state === "unclaimed") all.push(publicTaskItem(packet));
    }
    // The facade cursor is the last taskId of each page and strictly
    // advances over a finite set, so the scan terminates.
    if (!page?.nextCursor || tasks.length === 0) break;
    cursor = page.nextCursor;
  }
  return { items: all.slice(0, limit), total: all.length };
}
