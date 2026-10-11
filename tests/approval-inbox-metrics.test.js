// WAVE-500 guild 10 slice 13/50 — fail-first tests for the approval-inbox
// health metrics (server/approval-inbox-metrics.mjs).
//
// Traceability contract under test: every metric returns { value, query }
// where query is a card-list filter reproducing the number — no dead numbers.
// The tests prove it by re-applying each query with filterCards() and
// recomputing the value from the source rows.
import test from "node:test";
import assert from "node:assert/strict";
import {
  filterCards,
  pendingByKind,
  pendingByAgeBucket,
  oldestPendingAge,
  decidedToday,
  medianTimeToDecision,
  approvalInboxMetrics,
  AGE_BUCKETS,
  DAY_MS,
} from "../server/approval-inbox-metrics.mjs";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0); // fixed fixture time
const DAY_START = Date.UTC(2026, 9, 10, 0, 0, 0);

let seq = 0;
const card = (overrides = {}) => ({
  id: `card-${++seq}`,
  kind: "tap",
  createdAt: NOW - HOUR_MS,
  decidedAt: null,
  ...overrides,
});

const groupByKind = cards => {
  const out = {};
  for (const c of cards) {
    if (typeof c.kind !== "string" || c.kind.length === 0) continue;
    out[c.kind] = (out[c.kind] ?? 0) + 1;
  }
  return out;
};

const medianOf = sorted => {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

test("every metric returns { value, query } with a live query object", () => {
  const cards = [
    card({ kind: "tap" }),
    card({ kind: "approval", decidedAt: NOW - HOUR_MS, createdAt: NOW - 2 * HOUR_MS }),
  ];
  const results = approvalInboxMetrics(cards, { now: NOW });
  for (const [name, result] of Object.entries(results)) {
    assert.ok(result && typeof result === "object", `${name} returns an object`);
    assert.ok("value" in result, `${name} has value`);
    assert.ok(result.query !== null && typeof result.query === "object", `${name} has a query object`);
  }
});

test("pendingByKind groups pending cards by kind; decided and kindless rows dropped", () => {
  const cards = [
    card({ kind: "tap" }),
    card({ kind: "tap" }),
    card({ kind: "approval" }),
    card({ kind: "review", decidedAt: NOW - HOUR_MS, createdAt: NOW - 2 * HOUR_MS }),
    card({ kind: "" }), // untraceable for by-kind: dropped
  ];
  const { value, query } = pendingByKind(cards, { now: NOW });
  assert.deepEqual(value, { tap: 2, approval: 1 });
  // query reproduces the number from the source rows
  const reproduced = groupByKind(filterCards(cards, query, { now: NOW }));
  assert.deepEqual(reproduced, value);
});

test("pendingByAgeBucket buckets <1d / 1-3d / 3-7d / >7d with boundary cards landing up", () => {
  const cards = [
    card({ createdAt: NOW - 12 * HOUR_MS }), // <1d
    card({ createdAt: NOW - DAY_MS }), // exactly 1d -> 1-3d
    card({ createdAt: NOW - 2 * DAY_MS }), // 1-3d
    card({ createdAt: NOW - 3 * DAY_MS }), // exactly 3d -> 3-7d
    card({ createdAt: NOW - 6 * DAY_MS }), // 3-7d
    card({ createdAt: NOW - 7 * DAY_MS }), // exactly 7d -> >7d
    card({ createdAt: NOW - 30 * DAY_MS }), // >7d
    card({ createdAt: NOW - 2 * DAY_MS, decidedAt: NOW - DAY_MS }), // decided: excluded
    card({ createdAt: null }), // untraceable: dropped
  ];
  const { value, query } = pendingByAgeBucket(cards, { now: NOW });
  assert.deepEqual(Object.keys(value), [...AGE_BUCKETS]);
  assert.deepEqual(value, { "<1d": 1, "1-3d": 2, "3-7d": 2, ">7d": 2 });
  // query reproduces the bucket counts
  const rows = filterCards(cards, query, { now: NOW });
  const counts = { "<1d": 0, "1-3d": 0, "3-7d": 0, ">7d": 0 };
  for (const c of rows) {
    const age = NOW - c.createdAt;
    const bucket = age < DAY_MS ? "<1d" : age < 3 * DAY_MS ? "1-3d" : age < 7 * DAY_MS ? "3-7d" : ">7d";
    counts[bucket] += 1;
  }
  assert.deepEqual(counts, value);
});

test("oldestPendingAge returns max pending age in ms; null when nothing pending", () => {
  const cards = [
    card({ createdAt: NOW - 5 * DAY_MS }),
    card({ createdAt: NOW - 2 * DAY_MS }),
    card({ createdAt: NOW - DAY_MS, decidedAt: NOW - HOUR_MS }), // decided: excluded
  ];
  const { value, query } = oldestPendingAge(cards, { now: NOW });
  assert.equal(value, 5 * DAY_MS);
  // query names the single oldest pending card; its age reproduces the value
  const [oldest] = filterCards(cards, query, { now: NOW });
  assert.ok(oldest);
  assert.equal(NOW - oldest.createdAt, value);

  const empty = oldestPendingAge([], { now: NOW });
  assert.equal(empty.value, null);
  assert.deepEqual(filterCards([], empty.query, { now: NOW }), []);
});

test("decidedToday counts decisions since UTC midnight; excludes yesterday, future, pending", () => {
  const cards = [
    card({ decidedAt: DAY_START + HOUR_MS, createdAt: DAY_START }),
    card({ decidedAt: DAY_START + 2 * HOUR_MS, createdAt: DAY_START - DAY_MS }),
    card({ decidedAt: DAY_START - HOUR_MS, createdAt: DAY_START - 2 * DAY_MS }), // yesterday
    card({ decidedAt: NOW + HOUR_MS, createdAt: NOW }), // future-dated: excluded
    card({ decidedAt: null }), // pending
  ];
  const { value, query } = decidedToday(cards, { now: NOW });
  assert.equal(value, 2);
  assert.equal(filterCards(cards, query, { now: NOW }).length, value);
});

test("medianTimeToDecision: odd count takes the middle", () => {
  const cards = [1, 2, 3].map(h => card({ createdAt: NOW - (h + 1) * HOUR_MS, decidedAt: NOW - HOUR_MS }));
  const { value, query } = medianTimeToDecision(cards, { now: NOW });
  assert.equal(value, 2 * HOUR_MS);
  const durations = filterCards(cards, query, { now: NOW })
    .map(c => c.decidedAt - c.createdAt).sort((a, b) => a - b);
  assert.equal(medianOf(durations), value);
});

test("medianTimeToDecision: even count averages the two middles", () => {
  const cards = [1, 2, 3, 4].map(h => card({ createdAt: NOW - (h + 1) * HOUR_MS, decidedAt: NOW - HOUR_MS }));
  const { value, query } = medianTimeToDecision(cards, { now: NOW });
  assert.equal(value, 2.5 * HOUR_MS);
  const durations = filterCards(cards, query, { now: NOW })
    .map(c => c.decidedAt - c.createdAt).sort((a, b) => a - b);
  assert.equal(medianOf(durations), value);
});

test("medianTimeToDecision: no decided cards -> null; anomalous durations dropped", () => {
  const none = medianTimeToDecision([card(), card()], { now: NOW });
  assert.equal(none.value, null);

  const cards = [
    card({ createdAt: NOW - 3 * HOUR_MS, decidedAt: NOW - HOUR_MS }), // 2h
    card({ createdAt: NOW - HOUR_MS, decidedAt: NOW - 3 * HOUR_MS }), // decided before created: dropped
  ];
  const { value, query } = medianTimeToDecision(cards, { now: NOW });
  assert.equal(value, 2 * HOUR_MS);
  assert.equal(filterCards(cards, query, { now: NOW }).length, 1);
});

test("metrics are pure: inputs are not mutated", () => {
  const cards = [
    card({ kind: "tap", createdAt: NOW - 2 * DAY_MS }),
    card({ kind: "approval", createdAt: NOW - DAY_MS, decidedAt: NOW - HOUR_MS }),
  ];
  for (const c of cards) Object.freeze(c);
  const before = JSON.stringify(cards);
  approvalInboxMetrics(cards, { now: NOW });
  assert.equal(JSON.stringify(cards), before);
});

test("filterCards ignores non-card rows and honors kind/id filters", () => {
  const cards = [null, "nope", 42, card({ kind: "tap" }), { id: "", kind: "tap" }, card({ kind: "review" })];
  assert.equal(filterCards(cards, { pending: true }, { now: NOW }).length, 2);
  assert.equal(filterCards(cards, { kind: "review" }, { now: NOW }).length, 1);
  assert.equal(filterCards("not-an-array", {}, { now: NOW }).length, 0);
});
