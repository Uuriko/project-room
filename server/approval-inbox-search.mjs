// Approval-inbox search (WAVE-500 guild 10, slice 11): the query layer over
// the unified approval-inbox card store. Cards are pending HUMAN decisions
// surfaced as cards (replacing the scattered tap list):
//   { id, kind, title, what, context, options[], requestedBy, createdAt,
//     expiresAt, status }
// where kind is one of money|identity|deploy|permission|publish|other and
// options[] is [{ label, consequence }].
//
// Store seam: the real card store (sibling slice 1,
// server/approval-inbox-store.mjs) implements `listCards()` returning card
// snapshots. This module only ever calls that one method, so the real
// store plugs in without changes here. createInMemoryApprovalInboxStore is
// the reference implementation of the seam (also the test adapter).
//
// Query contract: filters combine with AND; full-text q matches title+what
// (all terms required, case-insensitive); cursor pagination with
// limit+afterId and no OFFSET (afterId must appear in the result set or the
// query is rejected); default sort is oldest-first (oldest decisions need
// attention first), or "urgency" (expired first, then soonest expiry).
// Result rows carry the card id, which resolves through the store's
// getCard(id) — the detail route uses the same id.
//
// Pure, dependency-free, deterministic; frozen outputs. The clock is
// injected so age buckets and expiry are testable.
export class ApprovalInboxSearchError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "ApprovalInboxSearchError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
const fail = (code, message, detail) => { throw new ApprovalInboxSearchError(code, message, detail); };
const check = (condition, code, message, detail) => { if (!condition) fail(code, message, detail); };

export const approvalCardKinds = Object.freeze(["money", "identity", "deploy", "permission", "publish", "other"]);

const DAY_MS = 86_400_000;
const tokenize = text => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 1);
const msOf = value => { const ms = Date.parse(value); return Number.isNaN(ms) ? null : ms; };

// The card shape the seam guarantees. Only the fields the query layer
// touches are checked here; richer validation belongs to the store owner.
const cardOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_store_card", "store cards must be objects");
  check(typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 512, "invalid_store_card", "card id must be 1..512 characters");
  check(approvalCardKinds.includes(value.kind), "invalid_store_card", `card kind must be one of ${approvalCardKinds.join("|")}`);
  check(msOf(value.createdAt) !== null, "invalid_store_card", "card createdAt must be a parseable timestamp");
  check(value.expiresAt === null || value.expiresAt === undefined || msOf(value.expiresAt) !== null,
    "invalid_store_card", "card expiresAt must be null or a parseable timestamp");
  check(typeof value.status === "string" && value.status.length >= 1, "invalid_store_card", "card status must be a non-empty string");
  return value;
};

// Reference implementation of the store seam. Cards are validated and
// frozen on write; listCards returns the frozen snapshots.
export function createInMemoryApprovalInboxStore() {
  const cards = new Map();
  return Object.freeze({
    addCard(value) {
      const card = cardOf(value);
      check(!cards.has(card.id), "invalid_store_card", `duplicate card id "${card.id}"`);
      cards.set(card.id, Object.freeze({ ...card }));
      return cards.get(card.id);
    },
    listCards() { return [...cards.values()]; },
    getCard(id) { return cards.get(id) ?? null; },
  });
}

const storeOf = value => {
  check(value !== null && typeof value === "object" && typeof value.listCards === "function",
    "invalid_search_input", "store must implement listCards()");
  return value;
};

const kindOf = value => {
  if (value === undefined || value === null) return null;
  check(approvalCardKinds.includes(value), "invalid_search_input", `kind must be one of ${approvalCardKinds.join("|")}`);
  return value;
};
const textFilterOf = (value, field) => {
  if (value === undefined || value === null) return null;
  check(typeof value === "string" && value.length >= 1, "invalid_search_input", `${field} must be a non-empty string`);
  return value;
};
const ageOf = value => {
  if (value === undefined || value === null) return null;
  check(["new", "aging", "stale"].includes(value), "invalid_search_input", "age must be one of new|aging|stale");
  return value;
};
const queryOf = value => {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string" && value.length <= 500, "invalid_search_input", "q must be text up to 500 characters");
  return value;
};
const sortOf = value => {
  if (value === undefined || value === null) return "oldest";
  check(value === "oldest" || value === "urgency", "invalid_search_input", "sort must be oldest|urgency");
  return value;
};
const limitOf = value => {
  if (value === undefined || value === null) return 25;
  check(Number.isInteger(value) && value >= 1 && value <= 200, "invalid_search_input", "limit must be an integer 1..200");
  return value;
};
const afterIdOf = value => {
  if (value === undefined || value === null) return null;
  check(typeof value === "string" && value.length >= 1, "invalid_search_input", "afterId must be a non-empty string");
  return value;
};

const matchesQuery = (card, query) => {
  const haystack = `${card.title ?? ""}\n${card.what ?? ""}`.toLowerCase();
  return [...new Set(tokenize(query))].every(term => haystack.includes(term));
};
const matchesAge = (createdMs, nowMs, age) => {
  const ageMs = nowMs - createdMs;
  if (age === "new") return ageMs < DAY_MS;
  if (age === "aging") return ageMs >= DAY_MS && ageMs < 7 * DAY_MS;
  return ageMs >= 7 * DAY_MS;
};

// Total order: primary key, then id. The cursor is only stable when the
// order is total, so every comparator ends on id.
const byOldest = (a, b) => msOf(a.createdAt) - msOf(b.createdAt) || (a.id < b.id ? -1 : 1);
const byUrgency = nowMs => (a, b) => {
  const ea = a.expiresAt === null || a.expiresAt === undefined ? null : msOf(a.expiresAt);
  const eb = b.expiresAt === null || b.expiresAt === undefined ? null : msOf(b.expiresAt);
  const bucket = e => (e === null ? 2 : e <= nowMs ? 0 : 1); // expired, then expiring, then open
  return bucket(ea) - bucket(eb)
    || (ea === null || eb === null ? msOf(a.createdAt) - msOf(b.createdAt) : ea - eb)
    || (a.id < b.id ? -1 : 1);
};

export function createApprovalInboxSearch({ store, clock = () => Date.now() } = {}) {
  const cardsOf = storeOf(store);
  const query = (filters = {}) => {
    check(filters !== null && typeof filters === "object" && !Array.isArray(filters),
      "invalid_search_input", "filters must be an object");
    const kind = kindOf(filters.kind), status = textFilterOf(filters.status, "status"),
      requestedBy = textFilterOf(filters.requestedBy, "requestedBy"),
      age = ageOf(filters.age), q = queryOf(filters.q),
      sort = sortOf(filters.sort), limit = limitOf(filters.limit), afterId = afterIdOf(filters.afterId);
    const nowMs = clock();

    const matched = cardsOf.listCards().map(cardOf).filter(card =>
      (kind === null || card.kind === kind) &&
      (status === null || card.status === status) &&
      (requestedBy === null || card.requestedBy === requestedBy) &&
      (age === null || matchesAge(msOf(card.createdAt), nowMs, age)) &&
      (q === null || matchesQuery(card, q)));
    matched.sort(sort === "urgency" ? byUrgency(nowMs) : byOldest);

    let start = 0;
    if (afterId !== null) {
      const at = matched.findIndex(card => card.id === afterId);
      check(at !== -1, "invalid_search_input", `afterId "${afterId}" is not in the result set`);
      start = at + 1;
    }
    const page = matched.slice(start, start + limit);
    const hasMore = start + limit < matched.length;
    return Object.freeze({
      cards: Object.freeze(page),
      total: matched.length,
      hasMore,
      nextAfterId: hasMore ? page[page.length - 1].id : null,
    });
  };
  return Object.freeze({ query });
}
