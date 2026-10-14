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
// This projection computes availability ONCE, over every work store, and
// emits one shape. Execution stays with the engines (board, work items,
// public-work facade) — each item carries a claimAction descriptor naming
// the route that acts on it, so reads unify while writes keep their
// semantics. Availability rule, aligned to the strictest proven definition
// (needs-me's openWorkOf, server/needs-me.mjs):
//   board claim  — not invalidated (no premiseFlag, not supersededBy),
//                  state "unclaimed", kind "work", every dependsOn done,
//                  and (when a viewer is named) the viewer may write claims.
//   work item    — state "accepted" (proposed items are not claimable yet)
//                  with no live claim holder.
//   public task  — the facade packet's claim.state is "unclaimed" (no
//                  submitted receipt, no live owner after lease release).
// Titles are member-authored: every item is marked untrusted.
import { WORK_STATES } from "../src/events.js";
import { mayWriteWorkClaims } from "./work-claim-routes.mjs";

export const AVAILABLE_WORK_SOURCES = ["board", "workItem", "publicTask"];

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

const workItemAvailable = (item, nowMs) => {
  if (!item || item.state !== WORK_STATES.ACCEPTED) return false;
  const claim = item.claim ?? null;
  if (!claim?.holderId) return true;
  const expiresMs = Date.parse(claim.expiresAt ?? "");
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
};

const workItemItem = (roomId, item) => ({
  id: item.id,
  title: item.title ?? item.id,
  source: "workItem",
  roomId,
  state: item.state,
  owner: null,
  leaseExpiresAt: null,
  untrusted: true,
  claimAction: {
    method: "POST",
    endpoint: `/api/rooms/${roomId}/commands`,
    params: { type: "claim.acquired", data: { workItemId: item.id, expectedRevision: item.revision ?? 0 } }
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

// Room-scoped AvailableWork: board claims + work items for one room.
// Returns { items, total } — an empty items list with total 0 is the
// explicit zero-inventory signal (the #2988 state, now expressible).
export function availableWorkInRoom(store, roomId, { viewerId = null, limit = 50, now = null } = {}) {
  const nowMs = now ?? store.now();
  const { state } = store.room(roomId);
  let board = [];
  try { board = store.workClaims?.list?.(roomId) ?? []; } catch { board = []; }
  const claims = availableClaimsFromBoard(board, roomId, { viewerId, state });
  // Decision #10 transition: a work item with a board card is offered
  // once, as the board claim (its claim action is the board door). The
  // workItem source below only covers items the migration has not
  // reached yet; PR-3 (board-only) removes it outright.
  const cardedWorkItemIds = new Set(board.map(item => item?.workItemId).filter(id => typeof id === "string"));
  const items = Object.values(state.workItems ?? {})
    .filter(item => workItemAvailable(item, nowMs) && !cardedWorkItemIds.has(item.id))
    .map(item => workItemItem(roomId, item));
  const all = [...claims, ...items];
  return { items: all.slice(0, limit), total: all.length };
}

// Decision #10 shadow read: the board-only form of availableWorkInRoom
// (no workItem source). The migration's equivalence harness compares
// this against the dual-source read; once a room's backfill has
// converged the two agree on the work inventory, and the consumer
// cutover flips availableWorkInRoom itself to the board-only definition.
export function availableWorkInRoomBoardOnly(store, roomId, { viewerId = null, limit = 50 } = {}) {
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
// availability classification stays the facade's (packet()).
export function availablePublicTasks(store, { limit = 50 } = {}) {
  const facade = store.publicWorkClaims;
  if (!facade?.list) return { items: [], total: 0 };
  const items = [];
  let after = "";
  while (items.length < limit) {
    const page = facade.list({ limit: 100, after });
    const tasks = page?.tasks ?? [];
    for (const packet of tasks) {
      if (packet?.claim?.state === "unclaimed") items.push(publicTaskItem(packet));
      if (items.length >= limit) break;
    }
    if (!page?.nextCursor || tasks.length === 0) break;
    after = page.nextCursor;
  }
  return { items, total: items.length };
}
