// W3 claim-history spill (data preservation): the SEC-2 cap
// (MAX_CLAIM_HISTORY) trims a claim's in-row history on every write, and
// before this fix the dropped stamps were destroyed — only their count
// survived in historyOmitted. The registry now preserves the dropped
// prefix in work_claim_history (keyed by lifetime seq) at set() time and
// reunites it on get(), so the single-claim read returns the claim's full
// lifetime history in order while the stored row keeps its bounded
// window + counter.
//
// Invariants pinned here:
//  1. The stored row is unchanged in shape: newest MAX_CLAIM_HISTORY
//     stamps + historyOmitted counting the spilled prefix.
//  2. get() returns every stamp ever appended, in order, with
//     historyOmitted folded away; claimHistoryLength agrees either way.
//  3. Stamps appended across several in-memory transitions between two
//     set() calls (chained trims) are preserved too.
//  4. The spill survives closing and reopening the database file.
//  5. Claim deletion removes the spill: a reused id starts clean.
//  6. A spill with a hole (out-of-band loss) degrades to the stored
//     shape — the read never fabricates stamps.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, stampClaimHistory, claimHistoryLength, MAX_CLAIM_HISTORY } from "../server/work-claims.mjs";
import { createDurableWorkClaimRegistry, workClaimSchema } from "../server/work-claim-sqlite.mjs";

const ROOM = "room-spill";
const BASE = Date.UTC(2026, 9, 18, 12, 0, 0);

function setup(db) {
  db.exec(workClaimSchema);
  const registry = createDurableWorkClaimRegistry(db, { transaction: fn => fn() });
  assert.equal(registry.verifySchema(), true, "schema verifies with the spill table");
  return registry;
}

function memoryRegistry() {
  return setup(new DatabaseSync(":memory:"));
}

// Append `count` note stamps (note-<from> .. note-<from+count-1>) with
// strictly increasing timestamps. With setEach the item is persisted
// after every stamp (the ordinary writer pattern); without it the
// transitions chain in memory and persist once (the stampClaimHistory
// chain pattern, e.g. required-reading acks after another transition).
function appendNotes(registry, item, count, { from = 0, setEach = true } = {}) {
  let current = item;
  for (let i = 0; i < count; i += 1) {
    current = stampClaimHistory(current, "agent-spill", { action: "note", note: `note-${from + i}`, now: BASE + (from + i + 1) * 1000 });
    if (setEach) registry.set(ROOM, current);
  }
  if (!setEach) registry.set(ROOM, current);
  return current;
}

function createClaim(registry, id) {
  const item = createWork({ id, title: `Claim ${id}` }, { now: BASE, agentId: "agent-spill" });
  registry.set(ROOM, item);
  return item;
}

const rawRow = (db, id) => {
  const row = db.prepare("SELECT item_json FROM work_claims WHERE room_id=? AND claim_id=?").get(ROOM, id);
  return row ? JSON.parse(row.item_json).data : null;
};
const spillRows = (db, id) =>
  db.prepare("SELECT seq, stamp_json FROM work_claim_history WHERE room_id=? AND claim_id=? ORDER BY seq ASC").all(ROOM, id);

test("history past the cap is spilled at write time and reunited on read", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-cap");
  appendNotes(registry, created, MAX_CLAIM_HISTORY + 49); // 1 created + 249 notes = 250 stamps

  const stored = rawRow(db, "claim-cap");
  assert.equal(stored.history.length, MAX_CLAIM_HISTORY, "stored row keeps the bounded window");
  assert.equal(stored.historyOmitted, 50, "stored counter counts the spilled prefix");
  assert.equal(stored.history[0].note, "note-49", "stored window starts where the spill ends");

  const spilled = spillRows(db, "claim-cap");
  assert.equal(spilled.length, 50);
  assert.deepEqual(spilled.map(row => row.seq), Array.from({ length: 50 }, (_, i) => i));
  assert.equal(JSON.parse(spilled[0].stamp_json).action, "created");
  assert.equal(JSON.parse(spilled[49].stamp_json).note, "note-48");

  const read = registry.get(ROOM, "claim-cap");
  assert.equal(read.history.length, 250, "read reunites spilled + stored history");
  assert.equal(read.historyOmitted, undefined, "reunited read folds the counter away");
  assert.equal(read.history[0].action, "created");
  assert.equal(read.history[1].note, "note-0");
  assert.equal(read.history[249].note, "note-248");
  assert.equal(claimHistoryLength(read), 250);
  const ats = read.history.map(stamp => stamp.at);
  assert.deepEqual(ats, [...ats].sort(), "reunited history is in append order");
});

test("chained trims between two set() calls lose nothing", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-chain");
  const settled = appendNotes(registry, created, 150); // 151 stamps, persisted per stamp
  appendNotes(registry, settled, 120, { from: 150, setEach: false }); // 271 total, one set()

  const read = registry.get(ROOM, "claim-chain");
  assert.equal(read.history.length, 271);
  assert.equal(read.history[151].note, "note-150", "first chained stamp follows the persisted prefix");
  assert.equal(read.history[270].note, "note-269");
  assert.equal(rawRow(db, "claim-chain").historyOmitted, 71);
  assert.equal(spillRows(db, "claim-chain").length, 71);
});

test("the spill survives closing and reopening the database", t => {
  const dir = mkdtempSync(join(tmpdir(), "claim-spill-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "claims.sqlite");
  const db = new DatabaseSync(file);
  const registry = setup(db);
  const created = createClaim(registry, "claim-reopen");
  appendNotes(registry, created, MAX_CLAIM_HISTORY + 29); // 230 stamps
  db.close();

  const reopened = setup(new DatabaseSync(file));
  const read = reopened.get(ROOM, "claim-reopen");
  assert.equal(read.history.length, 230);
  assert.equal(read.history[0].action, "created");
  assert.equal(read.history[229].note, "note-228");
});

test("claim deletion removes the spill; a reused id starts clean", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-reuse");
  appendNotes(registry, created, MAX_CLAIM_HISTORY + 9); // 210 stamps, 10 spilled
  assert.equal(spillRows(db, "claim-reuse").length, 10);

  registry.delete(ROOM, "claim-reuse");
  assert.equal(spillRows(db, "claim-reuse").length, 0, "spill dies with the claim");

  const fresh = createClaim(registry, "claim-reuse");
  appendNotes(registry, fresh, 3);
  const read = registry.get(ROOM, "claim-reuse");
  assert.equal(read.history.length, 4, "no predecessor stamps leak into the new claim");
  assert.equal(read.history[0].action, "created");
});

test("a gapped spill degrades to the stored shape without fabricating stamps", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-gap");
  appendNotes(registry, created, MAX_CLAIM_HISTORY + 49); // 250 stamps, 50 spilled
  db.prepare("DELETE FROM work_claim_history WHERE room_id=? AND claim_id=? AND seq=?").run(ROOM, "claim-gap", 7);

  const read = registry.get(ROOM, "claim-gap");
  assert.equal(read.history.length, MAX_CLAIM_HISTORY, "stored window is the honest read");
  assert.equal(read.historyOmitted, 50, "the counter still reports the missing prefix");
});

test("a reunited item round-tripped through set() keeps the row capped and loses nothing", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-roundtrip");
  appendNotes(registry, created, MAX_CLAIM_HISTORY + 49); // 250 stamps, 50 spilled

  // A field-only update round-trips the reunited item (full history, no
  // counter) through set() without appending a stamp: the registry must
  // re-cap the row itself instead of persisting the long history.
  const read = registry.get(ROOM, "claim-roundtrip");
  assert.equal(read.history.length, 250);
  registry.set(ROOM, { ...read, title: "Renamed in place" });
  const stored = rawRow(db, "claim-roundtrip");
  assert.equal(stored.history.length, MAX_CLAIM_HISTORY, "row stays capped after a reunited round-trip");
  assert.equal(stored.historyOmitted, 50, "counter restored on the row");
  assert.equal(stored.title, "Renamed in place");
  assert.equal(spillRows(db, "claim-roundtrip").length, 50, "no duplicate spill rows");

  // The next stamp appends to the reunited history and trims correctly.
  const appended = stampClaimHistory(registry.get(ROOM, "claim-roundtrip"), "agent-spill",
    { action: "note", note: "note-249", now: BASE + 251 * 1000 });
  registry.set(ROOM, appended);
  const reread = registry.get(ROOM, "claim-roundtrip");
  assert.equal(reread.history.length, 251);
  assert.equal(reread.history[250].note, "note-249");
  assert.equal(reread.history[0].action, "created");
  assert.equal(rawRow(db, "claim-roundtrip").historyOmitted, 51);
});

test("claims under the cap write no spill rows", () => {
  const db = new DatabaseSync(":memory:");
  const registry = setup(db);
  const created = createClaim(registry, "claim-small");
  appendNotes(registry, created, 9);
  assert.equal(spillRows(db, "claim-small").length, 0);
  const read = registry.get(ROOM, "claim-small");
  assert.equal(read.history.length, 10);
  assert.equal(read.historyOmitted, undefined);
});
