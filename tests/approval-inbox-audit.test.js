// WAVE-500 guild 10, slice 25/50: unified approval inbox audit journal.
// Fail-first tests for server/approval-inbox-audit.mjs — an append-only
// decision journal with a tamper-evident hash chain.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDecisionJournal,
  createMemoryJournalStore,
  journalDecisions,
  JournalError,
} from "../server/approval-inbox-audit.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof JournalError && error.code === code);

const CLOCK = () => Date.parse("2026-10-10T19:30:00.000Z");
const ids = () => { let n = 0; return () => `j-${++n}`; };
const entry = (over = {}) => ({
  cardId: "card-1",
  decision: "approved",
  decidedBy: "john",
  decidedAt: "2026-10-10T19:30:00.000Z",
  note: "ship it",
  receiptId: "r-1",
  ...over,
});

test("journal appends a frozen record with seq 1, genesis prevHash, sha256 hash", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  const rec = j.journal(entry());
  assert.equal(rec.seq, 1);
  assert.equal(rec.id, "j-1");
  assert.equal(rec.prevHash, "GENESIS");
  assert.match(rec.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual([rec.cardId, rec.decision, rec.decidedBy, rec.note, rec.receiptId],
    ["card-1", "approved", "john", "ship it", "r-1"]);
  assert.ok(Object.isFrozen(rec));
});

test("journal entries chain: entry N+1 prevHash equals entry N hash; list is chronological", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  const a = j.journal(entry());
  const b = j.journal(entry({ cardId: "card-2", decision: "rejected", decidedBy: "jane" }));
  const c = j.journal(entry({ decision: "escalated" }));
  assert.equal(b.prevHash, a.hash);
  assert.equal(c.prevHash, b.hash);
  assert.deepEqual(j.list().map(r => r.seq), [1, 2, 3]);
  assert.deepEqual([a.hash, b.hash, c.hash].length, new Set([a.hash, b.hash, c.hash]).size);
});

test("list(cardId) returns only that card's entries, chronological", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  j.journal(entry({ cardId: "a" }));
  j.journal(entry({ cardId: "b" }));
  j.journal(entry({ cardId: "a", decision: "rejected" }));
  assert.deepEqual(j.list("a").map(r => [r.seq, r.decision]), [[1, "approved"], [3, "rejected"]]);
  assert.equal(j.list("missing").length, 0);
});

test("verify() passes on a clean chain", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  j.journal(entry());
  j.journal(entry({ decision: "changes_requested" }));
  const v = j.verify();
  assert.deepEqual(v, { ok: true, checked: 2 });
});

test("verify() detects tampering: mutated note breaks the hash, brokenAt points at the seq", () => {
  const rows = [];
  const store = {
    append: row => rows.push({ ...row }), // persisted snapshot, like a DB row
    readAll: () => rows.map(r => ({ ...r })), // mutable copies, as a real DB would return
  };
  const j = createDecisionJournal({ store, clock: CLOCK, id: ids() });
  j.journal(entry());
  j.journal(entry({ decision: "rejected" }));
  rows[0].note = "forged"; // tamper with the persisted record
  const v = j.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
  assert.match(v.reason, /hash/i);
});

test("verify() detects a reordered chain (swapped entries fail)", () => {
  const rows = [];
  const store = { append: row => rows.push(row), readAll: () => rows };
  const j = createDecisionJournal({ store, clock: CLOCK, id: ids() });
  j.journal(entry());
  j.journal(entry({ decision: "rejected" }));
  rows.reverse();
  const v = j.verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 1);
});

test("invalid entries are refused with journal_invalid", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  throwsCode(() => j.journal(entry({ decision: "maybe" })), "journal_invalid");
  throwsCode(() => j.journal(entry({ cardId: "" })), "journal_invalid");
  throwsCode(() => j.journal(entry({ decidedBy: "" })), "journal_invalid");
  throwsCode(() => j.journal(entry({ decidedAt: "not-a-date" })), "journal_invalid");
  throwsCode(() => j.journal(entry({ note: "x".repeat(2001) })), "journal_invalid");
  throwsCode(() => j.journal(null), "journal_invalid");
  assert.equal(j.list().length, 0); // refused writes never land
});

test("journalDecisions lists the accepted decision vocabulary", () => {
  assert.deepEqual(journalDecisions, ["approved", "rejected", "changes_requested", "escalated"]);
});

test("decidedAt defaults to the injected clock when omitted", () => {
  const j = createDecisionJournal({ clock: CLOCK, id: ids() });
  const rec = j.journal(entry({ decidedAt: undefined }));
  assert.equal(rec.decidedAt, "2026-10-10T19:30:00.000Z");
});

test("injected store is shared: two journals on one store see one chain", () => {
  const store = createMemoryJournalStore();
  const a = createDecisionJournal({ store, clock: CLOCK, id: ids() });
  const b = createDecisionJournal({ store, clock: CLOCK, id: ids() });
  a.journal(entry());
  b.journal(entry({ decision: "rejected" }));
  assert.equal(b.list().length, 2);
  assert.equal(a.verify().ok, true);
  assert.equal(b.verify().ok, true);
});
