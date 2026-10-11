// WAVE-500 guild 10 (approval inbox), slice 11: search/query layer over the
// approval-inbox card store. Query contract: filters combine with AND,
// cursor pagination (limit + afterId, no OFFSET) is stable across pages,
// oldest-first is the default sort, and every result row carries the card
// id that resolves through the detail route.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalInboxSearchError,
  approvalCardKinds,
  createApprovalInboxSearch,
  createInMemoryApprovalInboxStore,
} from "../server/approval-inbox-search.mjs";

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.ok(error instanceof ApprovalInboxSearchError); assert.equal(error.code, code); return; }
  assert.fail(`expected ${code} but nothing threw`);
};

let now = 1_700_000_000_000;
const clock = () => now;
const iso = ms => new Date(ms).toISOString();
const DAY = 86_400_000;
let n = 0;
const card = (overrides = {}) => ({
  id: `card-${++n}`,
  kind: "money",
  title: "title",
  what: "what happened",
  context: "context",
  options: [{ label: "Approve", consequence: "it happens" }],
  requestedBy: "grok",
  createdAt: iso(now),
  expiresAt: null,
  status: "pending",
  ...overrides,
});
const setup = (cards = []) => {
  const store = createInMemoryApprovalInboxStore({ clock });
  for (const c of cards) store.addCard(c);
  return createApprovalInboxSearch({ store, clock });
};

test("empty store returns an empty page with the full page shape", () => {
  const page = setup().query();
  assert.deepEqual(page, { cards: [], total: 0, hasMore: false, nextAfterId: null });
});

test("filters combine with AND across kind, status, and requestedBy", () => {
  const a = card({ kind: "money", status: "pending", requestedBy: "grok" });
  const b = card({ kind: "money", status: "approved", requestedBy: "grok" });
  const c = card({ kind: "deploy", status: "pending", requestedBy: "grok" });
  const d = card({ kind: "money", status: "pending", requestedBy: "codex" });
  const search = setup([a, b, c, d]);
  const page = search.query({ kind: "money", status: "pending", requestedBy: "grok" });
  assert.deepEqual(page.cards.map(row => row.id), [a.id]);
  assert.equal(page.total, 1);
});

test("unknown kind, status type, and requestedBy type are rejected", () => {
  const search = setup([card()]);
  expectCode(() => search.query({ kind: "bribe" }), "invalid_search_input");
  expectCode(() => search.query({ status: 42 }), "invalid_search_input");
  expectCode(() => search.query({ requestedBy: "" }), "invalid_search_input");
});

test("full-text q matches title+what: all terms required, case-insensitive", () => {
  const a = card({ title: "Release escrow tokens", what: "pay the bounty hunter" });
  const b = card({ title: "Deploy landing page", what: "release the new copy" });
  const search = setup([a, b]);
  assert.deepEqual(search.query({ q: "release tokens" }).cards.map(r => r.id), [a.id]);
  assert.deepEqual(search.query({ q: "RELEASE" }).cards.map(r => r.id), [a.id, b.id]);
  assert.deepEqual(search.query({ q: "zebra" }).cards, []);
});

test("empty q is no filter; overlong q is rejected", () => {
  const search = setup([card()]);
  assert.equal(search.query({ q: "" }).total, 1);
  expectCode(() => search.query({ q: "x".repeat(501) }), "invalid_search_input");
});

test("oldest-first is the default sort", () => {
  const older = card({ createdAt: iso(now - 2 * DAY) });
  const newer = card({ createdAt: iso(now - DAY) });
  const search = setup([newer, older]);
  const page = search.query();
  assert.deepEqual(page.cards.map(r => r.id), [older.id, newer.id]);
});

test("cursor pages tile the result set with no overlap or gaps", () => {
  const cards = Array.from({ length: 7 }, (_, i) => card({ createdAt: iso(now - (6 - i) * 1000) }));
  const search = setup(cards);
  const p1 = search.query({ limit: 3 });
  const p2 = search.query({ limit: 3, afterId: p1.nextAfterId });
  const p3 = search.query({ limit: 3, afterId: p2.nextAfterId });
  assert.deepEqual([p1.hasMore, p2.hasMore, p3.hasMore], [true, true, false]);
  assert.equal(p3.nextAfterId, null);
  const seen = [...p1.cards, ...p2.cards, ...p3.cards].map(r => r.id);
  assert.deepEqual(seen, cards.map(c => c.id)); // oldest-first order preserved
  assert.equal(new Set(seen).size, 7); // no duplicates
  assert.deepEqual([p1.total, p2.total, p3.total], [7, 7, 7]); // total is filter-wide
});

test("unknown afterId is rejected instead of silently restarting", () => {
  const search = setup([card()]);
  expectCode(() => search.query({ afterId: "nope" }), "invalid_search_input");
});

test("limit is bounded; defaults to 25", () => {
  const search = setup([card()]);
  expectCode(() => search.query({ limit: 0 }), "invalid_search_input");
  expectCode(() => search.query({ limit: 201 }), "invalid_search_input");
  expectCode(() => search.query({ limit: 2.5 }), "invalid_search_input");
  assert.equal(search.query().cards.length, 1); // default path still works
});

test("age buckets filter by card age: new, aging, stale", () => {
  const fresh = card({ createdAt: iso(now - 3_600_000) });        // 1h
  const aging = card({ createdAt: iso(now - 3 * DAY) });           // 3d
  const stale = card({ createdAt: iso(now - 10 * DAY) });         // 10d
  const search = setup([fresh, aging, stale]);
  assert.deepEqual(search.query({ age: "new" }).cards.map(r => r.id), [fresh.id]);
  assert.deepEqual(search.query({ age: "aging" }).cards.map(r => r.id), [aging.id]);
  assert.deepEqual(search.query({ age: "stale" }).cards.map(r => r.id), [stale.id]);
  expectCode(() => search.query({ age: "ancient" }), "invalid_search_input");
});

test("urgency sort: expired first, then soonest expiry, then no expiry oldest-first", () => {
  const expired = card({ createdAt: iso(now - DAY), expiresAt: iso(now - 1_000) });
  const soon = card({ createdAt: iso(now - 2 * DAY), expiresAt: iso(now + 3_600_000) });
  const later = card({ createdAt: iso(now - 3 * DAY), expiresAt: iso(now + DAY) });
  const open = card({ createdAt: iso(now - 4 * DAY), expiresAt: null });
  const search = setup([open, later, soon, expired]);
  const ids = search.query({ sort: "urgency" }).cards.map(r => r.id);
  assert.deepEqual(ids, [expired.id, soon.id, later.id, open.id]);
  expectCode(() => search.query({ sort: "random" }), "invalid_search_input");
});

test("every result row carries an id that resolves through the store", () => {
  const store = createInMemoryApprovalInboxStore({ clock });
  const a = card({ title: "Money move" });
  store.addCard(a);
  const search = createApprovalInboxSearch({ store, clock });
  for (const row of search.query().cards) {
    assert.equal(typeof row.id, "string");
    assert.deepEqual(store.getCard(row.id).id, a.id); // detail-route resolution
  }
});

test("approvalCardKinds lists the six card kinds", () => {
  assert.deepEqual([...approvalCardKinds].sort(),
    ["deploy", "identity", "money", "other", "permission", "publish"]);
});
