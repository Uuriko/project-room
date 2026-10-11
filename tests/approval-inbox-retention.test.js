// Fail-first tests for the unified approval inbox retention policy.
// server/approval-inbox-retention.mjs
//
// Policy under test:
//  - resolved (approved/rejected/expired) cards strictly older than 90 days
//    move to "archived" (still queryable, excluded from default pending views)
//  - the decision journal (audit) is NEVER archived — audit is permanent
//  - archiveSweep(now) returns counts and is idempotent
//  - pure logic over a store seam (sibling slice 1 owns the real store);
//    these tests use an in-memory stub implementing the same seam.
import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveSweep,
  shouldArchive,
  isJournalEntry,
  RETENTION_DAYS,
  ARCHIVED,
} from "../server/approval-inbox-retention.mjs";

const DAY = 86_400_000;
const NOW = 1_790_000_000_000; // fixed "now" for deterministic tests

// In-memory stub of the store seam owned by sibling slice 1:
//   listApprovalCards() -> array of card objects
//   setApprovalCardStatus(id, status, meta) -> updates the card
function makeStubStore(cards) {
  const byId = new Map(cards.map((c) => [c.id, { ...c }]));
  return {
    listApprovalCards: () => [...byId.values()],
    setApprovalCardStatus: (id, status, meta = {}) => {
      const card = byId.get(id);
      if (!card) throw new Error("unknown card " + id);
      card.status = status;
      Object.assign(card, meta);
    },
    get: (id) => byId.get(id),
  };
}

const card = (over) => ({
  id: over.id,
  status: over.status ?? "pending",
  resolvedAt: over.resolvedAt,
  kind: over.kind,
  journal: over.journal,
});

test("retention window is 90 days", () => {
  assert.equal(RETENTION_DAYS, 90);
});

test("archival boundary: strictly older than 90 days archives", () => {
  const store = makeStubStore([
    card({ id: "old-91", status: "approved", resolvedAt: NOW - 91 * DAY }),
    card({ id: "young-89", status: "approved", resolvedAt: NOW - 89 * DAY }),
    card({ id: "edge-90", status: "approved", resolvedAt: NOW - 90 * DAY }),
  ]);
  const counts = archiveSweep(store, NOW);
  assert.equal(counts.archived, 1);
  assert.equal(store.get("old-91").status, ARCHIVED);
  assert.equal(store.get("young-89").status, "approved");
  assert.equal(store.get("edge-90").status, "approved"); // exactly 90d is NOT older
});

test("all resolved statuses archive; pending never does", () => {
  const store = makeStubStore([
    card({ id: "a", status: "approved", resolvedAt: NOW - 100 * DAY }),
    card({ id: "r", status: "rejected", resolvedAt: NOW - 100 * DAY }),
    card({ id: "e", status: "expired", resolvedAt: NOW - 100 * DAY }),
    card({ id: "p", status: "pending", resolvedAt: NOW - 200 * DAY }),
  ]);
  const counts = archiveSweep(store, NOW);
  assert.equal(counts.archived, 3);
  assert.equal(store.get("a").status, ARCHIVED);
  assert.equal(store.get("r").status, ARCHIVED);
  assert.equal(store.get("e").status, ARCHIVED);
  assert.equal(store.get("p").status, "pending"); // live surface keeps pending
});

test("decision journal is NEVER archived, even when old and resolved", () => {
  const store = makeStubStore([
    card({ id: "j1", status: "approved", resolvedAt: NOW - 400 * DAY, kind: "decision-journal" }),
    card({ id: "j2", status: "expired", resolvedAt: NOW - 400 * DAY, journal: true }),
  ]);
  const counts = archiveSweep(store, NOW);
  assert.equal(counts.archived, 0);
  assert.equal(counts.skippedJournal, 2);
  assert.equal(store.get("j1").status, "approved");
  assert.equal(store.get("j2").status, "expired");
});

test("cards without a valid resolvedAt are never archived", () => {
  const store = makeStubStore([
    card({ id: "no-ts", status: "approved" }),
    card({ id: "bad-ts", status: "rejected", resolvedAt: "long ago" }),
    card({ id: "future", status: "approved", resolvedAt: NOW + DAY }),
  ]);
  const counts = archiveSweep(store, NOW);
  assert.equal(counts.archived, 0);
  assert.equal(store.get("no-ts").status, "approved");
  assert.equal(store.get("bad-ts").status, "rejected");
  assert.equal(store.get("future").status, "approved");
});

test("archiveSweep is idempotent: re-run archives nothing new", () => {
  const store = makeStubStore([
    card({ id: "x", status: "approved", resolvedAt: NOW - 100 * DAY }),
    card({ id: "y", status: "pending", resolvedAt: NOW - 100 * DAY }),
  ]);
  const first = archiveSweep(store, NOW);
  assert.equal(first.archived, 1);
  assert.equal(store.get("x").status, ARCHIVED);

  const second = archiveSweep(store, NOW);
  assert.equal(second.archived, 0);
  assert.equal(second.alreadyArchived, 1);
  assert.equal(store.get("x").status, ARCHIVED); // unchanged
});

test("archiveSweep returns a counts object", () => {
  const store = makeStubStore([]);
  const counts = archiveSweep(store, NOW);
  assert.deepEqual(counts, {
    scanned: 0,
    archived: 0,
    skippedJournal: 0,
    alreadyArchived: 0,
    skipped: 0,
  });
});

test("shouldArchive / isJournalEntry unit behavior", () => {
  assert.equal(shouldArchive(null, NOW), false);
  assert.equal(
    shouldArchive(card({ id: "1", status: "approved", resolvedAt: NOW - 91 * DAY }), NOW),
    true
  );
  assert.equal(isJournalEntry({ kind: "decision-journal" }), true);
  assert.equal(isJournalEntry({ journal: true }), true);
  assert.equal(isJournalEntry({ kind: "approval" }), false);
});
