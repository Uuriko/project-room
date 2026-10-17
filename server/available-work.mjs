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
// Work items are not a separate source: decision #10 migrated them onto
// the board (server/work-item-board.mjs), so an accepted work item IS a
// board claim here — one definition, no dual-source divergence.
// Titles are member-authored: every item is marked untrusted.
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";

export const AVAILABLE_WORK_SOURCES = ["board"];

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
