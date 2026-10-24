// Optional board face. The claim records stay as they are. This only
// regroups the columns the board already computed and reads age off
// timestamps the claim already carries.
const KEY = "project-room-board-fix";
const MARK = "project-room-board-fix-query";
export const STALE_CLAIM_MS = 30 * 60 * 1000;

export function readBoardFixedFlag(search, storage) {
  const params = new URLSearchParams(typeof search === "string" ? search.replace(/^\?/, "") : "");
  const query = params.get("boardfix");
  if (storage && (query === "0" || query === "1") && storage.getItem(MARK) !== "1") {
    storage.setItem(KEY, query);
    storage.setItem(MARK, "1");
  }
  if (!storage) return query === "1";
  return storage.getItem(KEY) === "1";
}

export function writeBoardFixedFlag(storage, on) {
  if (!storage) return;
  storage.setItem(KEY, on ? "1" : "0");
  storage.setItem(MARK, "1");
}

export function claimStateId(item) {
  if (!item) return "";
  if (item.state === "done") return "done";
  if (item.state === "delivered") return "review";
  if (item.pullRequest?.url && !item.pullRequest.outcome) return "review";
  if (item.state === "claimed" || item.state === "in_progress") return "claimed";
  if (item.state === "blocked") return "needs";
  if (item.state === "unclaimed") return "ready";
  return "";
}

export function claimAge(item, now) {
  const at = Date.parse(item?.updatedAt || item?.claimedAt || "");
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "m", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return { unit: "h", count: hours };
  return { unit: "d", count: Math.floor(hours / 24) };
}

export function staleClaim(item, now, staleMs = STALE_CLAIM_MS) {
  if (!item || item.state === "done" || item.state === "unclaimed" || item.state === "closed") return false;
  const at = Date.parse(item.claimedAt || item.updatedAt || "");
  return Number.isFinite(at) && now - at >= staleMs;
}

// Needs you is the blocked column, pinned first. Dependency-waiting cards
// stay with Ready because the card already says which prerequisite is open.
// In review and Done keep the claims the current columns already placed there.
export function arrangeFixedColumns(columns) {
  const source = columns ?? {};
  const needs = [];
  const ready = [...(source.ready ?? [])];
  for (const item of source.blocked ?? []) {
    if (item?.state === "blocked") needs.push(item);
    else ready.push(item);
  }
  return [
    ["needs", needs],
    ["ready", ready],
    ["claimed", [...(source.claimed ?? [])]],
    ["review", [...(source.review ?? [])]],
    ["done", [...(source.landed ?? [])]],
  ];
}
