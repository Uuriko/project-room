import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// B2-4-P4 regression: search must be archive-invariant under Unicode case
// folding. The live-projection scan folds with JS `toLowerCase()` (full
// Unicode); the archived-partition scan must not decide matches with
// SQLite `lower()` (ASCII only) or messages whose match depends on
// non-ASCII folding become unfindable once archived. Differ shape:
// Unicode corpus -> search -> archive -> search, compared against an
// unarchived twin seeded identically.
const CORPUS = [
  "ÄPFEL Kuchen rezept", "İstanbul notu burada", "CAFÉ fermé demain", "ΣΊΣΥΦΟΣ μῦθος",
  "plain fox jumps", "STRASSE ß fest", "Œuvre complète ici", "naïve café résumé",
  "Zürich seeufer", "Ångström unit measure",
];
// The five executed B2-4-P4 needles plus the ASCII control, with the hits
// the live scan returns for each.
const EXPECTED = {
  "äpfel": ["ÄPFEL Kuchen rezept"],
  "i̇stanbul": ["İstanbul notu burada"],
  "café": ["CAFÉ fermé demain", "naïve café résumé"],
  "σίσυφος": ["ΣΊΣΥΦΟΣ μῦθος"],
  "œuvre": ["Œuvre complète ici"],
  "fox": ["plain fox jumps"],
};
const NEEDLES = [...Object.keys(EXPECTED), "strasse", "naïve", "zürich", "ångström", "kuchen", "unit"];

function seed(t, tag) {
  const dir = mkdtempSync(join(tmpdir(), `project-room-search-fold-${tag}-`));
  const store = new RoomStore(join(dir, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  CORPUS.forEach((body, i) => {
    store.command(ownerKey, "commons", {
      id: `fold-${tag}-${i}`, type: T.MESSAGE_POSTED,
      data: { messageId: randomUUID(), body },
    });
  });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, ownerKey };
}

function searchAll(store, ownerKey) {
  const res = {};
  for (const q of NEEDLES) {
    const r = store.search(ownerKey, "commons", q, "messages", null, { limit: 200 });
    res[q] = { bodies: r.messages.map(m => m.body).sort(), total: r.total };
  }
  return res;
}

test("archived search keeps non-ASCII case-folded matches (B2-4-P4)", t => {
  const a = seed(t, "a");
  const twin = seed(t, "twin");

  const before = searchAll(a.store, a.ownerKey);
  for (const [needle, bodies] of Object.entries(EXPECTED)) {
    assert.deepEqual(before[needle].bodies, [...bodies].sort(), `live scan finds ${needle}`);
    assert.equal(before[needle].total, bodies.length);
  }

  a.store.backfillMessages();
  a.store.checkMessagesParity(); // the archive refuses as messages_table_not_certified without this
  const arch = a.store.archiveMessages("commons", { keepNewest: 1, dryRun: false });
  assert.equal(arch.ok, true);
  assert.equal(arch.archived, 9);

  const after = searchAll(a.store, a.ownerKey);
  const twinRes = searchAll(twin.store, twin.ownerKey);
  for (const q of NEEDLES) {
    assert.deepEqual(after[q], before[q], `archive-invariant: ${q}`);
    assert.deepEqual(after[q], twinRes[q], `matches unarchived twin: ${q}`);
  }
});
