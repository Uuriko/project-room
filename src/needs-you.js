// One inbox page. count is the full list. The badge uses count.
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const KINDS = new Set(["ask", "approval", "mention", "task"]);

function compare(a, b) {
  return String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id));
}

export function needsYouLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_LIMIT) {
    const error = new Error("Invalid limit");
    error.code = "invalid_cursor";
    throw error;
  }
  return number;
}

export function assembleNeedsYou({ items = [], cursor = null, limit = DEFAULT_LIMIT, incomplete = [] } = {}) {
  const pageLimit = needsYouLimit(limit);
  const sorted = [...items].sort(compare);
  for (const item of sorted) {
    if (!item || typeof item.id !== "string" || !KINDS.has(item.kind)) {
      const error = new Error("Invalid item");
      error.code = "invalid_cursor";
      throw error;
    }
  }
  let start = 0;
  if (cursor !== null && cursor !== undefined && cursor !== "") {
    if (typeof cursor !== "string") {
      const error = new Error("Invalid cursor");
      error.code = "invalid_cursor";
      throw error;
    }
    const index = sorted.findIndex(item => item.id === cursor);
    if (index < 0) {
      const error = new Error("Invalid cursor");
      error.code = "invalid_cursor";
      throw error;
    }
    start = index + 1;
  }
  const page = sorted.slice(start, start + pageLimit);
  const more = start + pageLimit < sorted.length;
  return Object.freeze({
    count: sorted.length,
    items: Object.freeze(page.map(item => Object.freeze({ ...item }))),
    nextCursor: more && page.length ? page[page.length - 1].id : null,
    incomplete: Object.freeze([...incomplete]),
  });
}
