// Agent A (TESTSPLIT) — tests written from the claim alone.
//
// CLAIM under test (paraphrased only for structure, semantics verbatim):
//   Public receipts agent search must match the needle against
//   individual agent names only: a receipt is served for a needle only
//   if some single agent name on that receipt, case-folded with JS
//   toLowerCase(), contains the needle case-folded the same way.
//   Needles that occur only in the JSON serialization between or
//   around names — e.g. `","`, `[`, `"]`, or a string spanning two
//   different names — must serve nothing. Needles that genuinely match
//   within a single agent name, including non-ASCII case folds, must
//   still be served. The same discipline applies to cursor lookups: a
//   cursor anchored through such a serialization-only match must be
//   refused like a ghost id.
//
// Module under test: server/public-read-model.mjs queryPublicReceipts
// (repo at 579fc3f7d97a05ee61bf63fd3cbb4f1528efa109).
//
// Fixture shape is copied from the existing harness in
// tests/public-receipts-agent-unicode-fold.test.js (direct INSERT into
// public_receipts after store.initialize(initialRoom(...))), except the
// store is in-memory — RoomStore(":memory:") — because this sandbox
// blocks fsync and file-backed SQLite stores die with SQLITE_IOERR 778.

import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { queryPublicReceipts } from "../server/public-read-model.mjs";

// One target receipt. Its agents_json serialization is:
//   ["Äpfel","Xyz"]
// JS-folded serialization: ["äpfel","xyz"]
// Individual JS-folded names: "äpfel" and "xyz" — neither contains
// `","`, `[`, `"]`, `äpfel","xyz`, or `l","x`.
const TARGET_ID = `wcr_${"a".repeat(32)}`;
const GHOST_ID = `wcr_${"9".repeat(32)}`;
const TARGET_TITLE = "Target win";

function serve(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("alpha"));
  t.after(() => { store.close(); });
  store.db.prepare(`INSERT INTO public_receipts
    (id, title, source, origin_room_id, room_id, room_title, agents_json, humans_json,
     pull_request, merged_at, verification_state, hashes_json, at, start_href, agent_ids_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(TARGET_ID, TARGET_TITLE, "work-claim", "alpha", "alpha", "Alpha",
      JSON.stringify(["Äpfel", "Xyz"]), "[]",
      null, null, null, "[]", "2026-10-05T00:00:00.000Z",
      "https://room.trydemigod.com/?start=room", "[]");
  return { store };
}

const titles = (page) => (page.receipts ?? []).map((r) => r.title);

// ------------------------------------------------------------------
// Leg 1 — serialization-only needles serve nothing.
// Each of these needles occurs in the JSON serialization
// ["Äpfel","Xyz"] (after JS folding where relevant) but in NO single
// agent name. Expected per claim: zero receipts, no error.
// (Expected to FAIL at the artefact commit — that is the defect.)
// ------------------------------------------------------------------

const SERIALIZATION_ONLY_NEEDLES = [
  `","`,           // separator between the two names in the JSON array
  `[`,             // opening bracket of the JSON array, around the names
  `"]`,            // closing quote+bracket of the JSON array
  `äpfel","xyz`,   // spans both names plus the separator between them
  `l","x`,         // shorter cross-name span: end of name 1 + start of name 2
];

for (const needle of SERIALIZATION_ONLY_NEEDLES) {
  test(`leg1: serialization-only needle ${JSON.stringify(needle)} serves nothing`, (t) => {
    const { store } = serve(t);
    const page = queryPublicReceipts(store, { agent: needle, limit: 20 });
    assert.equal(page.error, undefined, `needle ${JSON.stringify(needle)} should not error`);
    assert.deepEqual(titles(page), [],
      `needle ${JSON.stringify(needle)} occurs only in/between the JSON serialization, in no single agent name`);
    assert.equal(page.nextCursor, null);
  });
}

// ------------------------------------------------------------------
// Leg 2 — true single-name matches still served.
// (Expected to PASS at the artefact commit and after any correct fix.)
// ------------------------------------------------------------------

test(`leg2: needle inside the first name only ("pfe") is served`, (t) => {
  const { store } = serve(t);
  const page = queryPublicReceipts(store, { agent: "pfe", limit: 20 });
  assert.equal(page.error, undefined);
  assert.deepEqual(titles(page), [TARGET_TITLE]);
});

test(`leg2: needle inside the second name only ("xyz", and folded "XYZ") is served`, (t) => {
  const { store } = serve(t);
  for (const needle of ["xyz", "XYZ"]) {
    const page = queryPublicReceipts(store, { agent: needle, limit: 20 });
    assert.equal(page.error, undefined, needle);
    assert.deepEqual(titles(page), [TARGET_TITLE], needle);
  }
});

test(`leg2: non-ASCII folded needle matching a single name is served`, (t) => {
  const { store } = serve(t);
  // "ÄPFEL".toLowerCase() === "äpfel", contained in the single name
  // "Äpfel".toLowerCase() === "äpfel". Both spellings must serve it.
  for (const needle of ["äpfel", "ÄPFEL", "Äpf"]) {
    const page = queryPublicReceipts(store, { agent: needle, limit: 20 });
    assert.equal(page.error, undefined, needle);
    assert.deepEqual(titles(page), [TARGET_TITLE], needle);
  }
});

// ------------------------------------------------------------------
// Leg 3 — non-match discipline unchanged.
// (Expected to PASS at the artefact commit and after any correct fix.)
// ------------------------------------------------------------------

test(`leg3: needle matching no name ("quux") serves nothing`, (t) => {
  const { store } = serve(t);
  const page = queryPublicReceipts(store, { agent: "quux", limit: 20 });
  assert.equal(page.error, undefined);
  assert.deepEqual(titles(page), []);
  assert.equal(page.nextCursor, null);
});

test(`leg3: needle matching no single name despite sharing letters ("äpfelxyz") serves nothing`, (t) => {
  const { store } = serve(t);
  // Concatenation of the two folded names with the serialization
  // removed: present in neither single name, nor in the serialization.
  const page = queryPublicReceipts(store, { agent: "äpfelxyz", limit: 20 });
  assert.equal(page.error, undefined);
  assert.deepEqual(titles(page), []);
});

// ------------------------------------------------------------------
// Leg 4 — cursor leg: a cursor anchored through a serialization-only
// match must be refused like a ghost id.
// The target receipt's own id is offered as cursor under a
// serialization-only needle. Per claim that receipt is not in that
// filtered list at all, so the answer must be exactly the ghost-id
// answer: 422 invalid_receipt_query, "cursor is not a receipt from
// this list". (Expected to FAIL at the artefact commit.)
// ------------------------------------------------------------------

for (const needle of [`","`, `[`, `äpfel","xyz`]) {
  test(`leg4: cursor anchored via serialization-only needle ${JSON.stringify(needle)} is refused like a ghost id`, (t) => {
    const { store } = serve(t);
    const viaSerialization = queryPublicReceipts(store, { agent: needle, cursor: TARGET_ID, limit: 10 });
    assert.equal(viaSerialization.error?.status, 422,
      `cursor under needle ${JSON.stringify(needle)} must be refused`);
    assert.equal(viaSerialization.error?.code, "invalid_receipt_query");
    const viaGhost = queryPublicReceipts(store, { agent: needle, cursor: GHOST_ID, limit: 10 });
    assert.equal(viaGhost.error?.status, 422);
    assert.deepEqual(viaSerialization, viaGhost,
      "serialization-anchored and never-existent cursors answer identically");
  });
}

test(`leg4 control: cursor anchored via a true single-name match still anchors`, (t) => {
  const { store } = serve(t);
  // The target is the only receipt, so a page anchored on it under a
  // genuinely matching needle is empty but NOT an error.
  const page = queryPublicReceipts(store, { agent: "äpfel", cursor: TARGET_ID, limit: 10 });
  assert.equal(page.error, undefined);
  assert.deepEqual(titles(page), []);
  assert.equal(page.nextCursor, null);
});
