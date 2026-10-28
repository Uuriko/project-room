import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { messageSearchRankedIds, messageSearchCoversRoom } from "../server/message-search.mjs";

// PERF-50 D2-a: FTS5 (unicode61, diacritic folding) candidate generation
// for store.search(). The pinned match sets below are the bound PR #5035
// corpus and needles verbatim (archived-search Unicode fold): the FTS
// path must serve exactly those sets, live and after archiving. PR #5040
// pins the same fold for public receipts agent search; that surface is
// untouched here (server/public-read-model.mjs is not in this diff).

function seed(t, tag, bodies) {
  const dir = mkdtempSync(join(tmpdir(), `project-room-fts-${tag}-`));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  let at = Date.now();
  store.now = () => at;
  const ids = bodies.map(body => {
    at += 2000; // pace past the flood guard, like the other search suites
    return store.command(ownerKey, "commons", {
      id: randomUUID(), type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body },
    }).event.data.messageId;
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, ownerKey, ids };
}

const searchBodies = (store, ownerKey, q) =>
  store.search(ownerKey, "commons", q, "messages", null, { limit: 200 }).messages.map(m => m.body).sort();

const FOLD_CORPUS = [
  "ÄPFEL Kuchen rezept", "İstanbul notu burada", "CAFÉ fermé demain", "ΣΊΣΥΦΟΣ μῦθος",
  "plain fox jumps", "STRASSE ß fest", "Œuvre complète ici", "naïve café résumé",
  "Zürich seeufer", "Ångström unit measure",
];
const FOLD_EXPECTED = {
  "äpfel": ["ÄPFEL Kuchen rezept"],
  "café": ["CAFÉ fermé demain", "naïve café résumé"],
  "σίσυφος": ["ΣΊΣΥΦΟΣ μῦθος"],
  "œuvre": ["Œuvre complète ici"],
  "fox": ["plain fox jumps"],
  "strasse": ["STRASSE ß fest"],
  "naïve": ["naïve café résumé"],
  "zürich": ["Zürich seeufer"],
  "ångström": ["Ångström unit measure"],
  "kuchen": ["ÄPFEL Kuchen rezept"],
  "unit": ["Ångström unit measure"],
};
// The #5035 needle for İstanbul is the JS fold of the capitalised word:
// "İstanbul".toLowerCase() is i + U+0307 (combining dot above) + "stanbul".
FOLD_EXPECTED["İstanbul".toLowerCase()] = ["İstanbul notu burada"];

test("FTS search serves the #5035 pinned non-ASCII match sets, live and archived", t => {
  const { store, ownerKey } = seed(t, "fold", FOLD_CORPUS);
  assert.equal(messageSearchCoversRoom(store.db, "commons", FOLD_CORPUS.length), true,
    "the FTS path, not the fallback scan, must be the one under test");
  for (const [needle, bodies] of Object.entries(FOLD_EXPECTED)) {
    assert.deepEqual(searchBodies(store, ownerKey, needle), [...bodies].sort(), `live: ${needle}`);
  }
  store.backfillMessages();
  store.checkMessagesParity();
  const arch = store.archiveMessages("commons", { keepNewest: 1, dryRun: false });
  assert.equal(arch.ok, true);
  assert.equal(arch.archived, FOLD_CORPUS.length - 1);
  for (const [needle, bodies] of Object.entries(FOLD_EXPECTED)) {
    assert.deepEqual(searchBodies(store, ownerKey, needle), [...bodies].sort(), `archived: ${needle}`);
  }
});

test("diacritic folding is a superset on the query side too: zurich and cafe find the accented bodies", t => {
  const { store, ownerKey } = seed(t, "foldq", FOLD_CORPUS);
  assert.deepEqual(searchBodies(store, ownerKey, "zurich"), ["Zürich seeufer"]);
  assert.deepEqual(searchBodies(store, ownerKey, "cafe"), ["CAFÉ fermé demain", "naïve café résumé"]);
});

test("multi-term queries are AND of terms, not an exact phrase (D1 recall 0.67 -> 1.00)", t => {
  const bodies = [
    "deploy window opens and later the freeze closes the release", // both terms, no phrase
    "deploy window opens on Friday", // one term only
    "the freeze closes the release", // one term only
    "unrelated chatter about lunch",
  ];
  const { store, ownerKey } = seed(t, "and", bodies);
  assert.deepEqual(searchBodies(store, ownerKey, "deploy freeze"), [bodies[0]]);
  assert.deepEqual(searchBodies(store, ownerKey, "deploy window"), [bodies[0], bodies[1]]);
});

test("non-ASCII precision@10 is 1.00 under BM25 ranking (D2 spike target)", t => {
  const both = Array.from({ length: 12 }, (_, i) =>
    `${i % 2 ? "CAFÉ" : "Café"} notes from ${i % 3 ? "Zürich" : "Zurich"} session ${i} with detailed discussion and follow up`);
  const decoys = [
    ...Array.from({ length: 15 }, (_, i) => `café menu item ${i} for the office kitchen`),
    ...Array.from({ length: 15 }, (_, i) => `zürich travel plan ${i} for the offsite week`),
    ...Array.from({ length: 30 }, (_, i) => `filler message ${i} about ordinary scheduling`),
  ];
  const { store, ownerKey, ids } = seed(t, "p10", [...both, ...decoys]);
  const bothIds = new Set(ids.slice(0, both.length));
  const ranked = messageSearchRankedIds(store.db, "commons", "café zürich", 10);
  assert.equal(ranked.length, 10);
  assert.ok(ranked.every(id => bothIds.has(id)), "every ranked top-10 hit carries both terms");
  const served = store.search(ownerKey, "commons", "café zürich", "messages", null, { limit: 200 });
  assert.deepEqual(new Set(served.messages.map(m => m.id)), bothIds, "the served set is exactly the both-term messages");
  assert.equal(served.total, both.length);
});

test("edits and deletes leave the index with the row (trigger maintenance)", t => {
  const { store, ownerKey, ids } = seed(t, "edit", ["zephyr launch checklist", "zephyr landing notes"]);
  const send = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  assert.equal(searchBodies(store, ownerKey, "zephyr").length, 2);
  send(T.MESSAGE_EDITED, { messageId: ids[0], body: "harbor launch checklist", expectedMessageRevision: 0 });
  assert.deepEqual(searchBodies(store, ownerKey, "zephyr"), ["zephyr landing notes"]);
  assert.deepEqual(searchBodies(store, ownerKey, "harbor"), ["harbor launch checklist"]);
  send(T.MESSAGE_DELETED, { messageId: ids[1], expectedMessageRevision: 0, reason: "test" });
  assert.deepEqual(searchBodies(store, ownerKey, "zephyr"), []);
});

test("search falls back to the legacy scan when the messages table does not cover the room", t => {
  const { store, ownerKey, ids } = seed(t, "fallback", ["quixotic first message", "quixotic second message"]);
  assert.equal(messageSearchCoversRoom(store.db, "commons", 2), true);
  // A row the backfill has not written yet is exactly the uncovered state:
  // remove one table row and the projection message must still be found.
  store.db.prepare("DELETE FROM messages WHERE room_id = ? AND message_id = ?").run("commons", ids[0]);
  assert.equal(messageSearchCoversRoom(store.db, "commons", 2), false);
  assert.deepEqual(searchBodies(store, ownerKey, "quixotic"),
    ["quixotic first message", "quixotic second message"]);
});

test("search falls back to the legacy scan when the index itself is absent", t => {
  const { store, ownerKey } = seed(t, "nofts", ["lamp post in the square", "lamp shade indoors"]);
  // First search creates the index lazily; dropping it afterwards (the
  // no-FTS5-build shape, as far as the candidate query can tell) must
  // degrade to the scan, not fail.
  assert.equal(searchBodies(store, ownerKey, "lamp").length, 2);
  store.db.exec("DROP TABLE messages_fts");
  assert.deepEqual(searchBodies(store, ownerKey, "lamp"),
    ["lamp post in the square", "lamp shade indoors"]);
});
