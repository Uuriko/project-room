// FTS5 inbox search (CONSULT-BUILD lane INBOX): server/inbox-search.mjs runs
// on SQLite FTS5 (unicode61 remove_diacritics 2), the tokenizer of the
// room-message index in server/message-search.mjs (#5112). The pinned match
// sets below are the bound PR #5035 corpus and needles (archived-search
// Unicode fold), carried onto the inbox surface, plus their ASCII-folded
// query forms: the pre-FTS5 inbox tokenizer (split on [^a-z0-9]) returned []
// for every folded form and for every non-Latin script — executed at base
// d5512d86: 10/16 of these needles passed, the 6 failures were σίσυφος,
// cafe, zurich, istanbul, angstrom and the Arabic needle. PR #5040 pins the
// same fold family for public receipts; that surface is untouched here.
import test from "node:test";
import assert from "node:assert/strict";
import { indexMessages, search } from "../server/inbox-search.mjs";

const CORPUS = [
  "ÄPFEL Kuchen rezept", "İstanbul notu burada", "CAFÉ fermé demain", "ΣΊΣΥΦΟΣ μῦθος",
  "plain fox jumps", "STRASSE ß fest", "Œuvre complète ici", "naïve café résumé",
  "Zürich seeufer", "Ångström unit measure", "مرحبا بالعالم اليوم",
  "deploy window opens and later the freeze closes the release",
  "deploy window opens on Friday",
];
const messages = CORPUS.map((body, i) => ({ id: `m${i}`, subject: "", body }));
const EXPECTED = {
  "äpfel": ["m0"], "café": ["m2", "m7"], "σίσυφος": ["m3"], "œuvre": ["m6"], "fox": ["m4"],
  "cafe": ["m2", "m7"], "zurich": ["m8"], "istanbul": ["m1"],
  "ångström": ["m9"], "angstrom": ["m9"], "naïve": ["m7"], "strasse": ["m5"],
  "مرحبا": ["m10"], "deploy freeze": ["m11"], "deploy window": ["m11", "m12"],
};
// The #5035 needle for İstanbul is the JS fold of the capitalised word:
// "İstanbul".toLowerCase() is i + U+0307 (combining dot above) + "stanbul".
EXPECTED["İstanbul".toLowerCase()] = ["m1"];

const bodies = (index, q) => search(index, q, { limit: 200 }).results.map(r => r.message.id).sort();

test("FTS inbox search serves the #5035 pinned non-ASCII match sets, incl. folded queries", () => {
  const index = indexMessages(messages);
  for (const [needle, want] of Object.entries(EXPECTED)) {
    assert.deepEqual(bodies(index, needle), [...want].sort(), `needle: ${needle}`);
  }
});

test("ranking carries the inbox route pin shape: best first, positive scores", () => {
  // The messages Inbox.search builds for synthetic sources (subject plus
  // searchText, which itself leads with the subject), as pinned by
  // tests/inbox-search-routes.test.js "finds sources by subject and body
  // text, best first".
  const msg = (id, subject, paragraph) => ({ id, subject, body: [subject, paragraph].join("\n") });
  const index = indexMessages([
    msg("s-1", "Harbor plans harbor", "harbor logistics and harbor fees"),
    msg("s-2", "Dawn notes", "the harbor at dawn"),
    msg("s-3", "Unrelated", "nothing to see here"),
  ]);
  const result = search(index, "harbor");
  assert.equal(result.total, 2);
  assert.deepEqual(result.results.map(r => r.message.id), ["s-1", "s-2"]);
  assert.ok(result.results[0].score > result.results[1].score);
  assert.ok(result.results.every(r => r.score > 0));
});

test("precision: a two-term query serves exactly the both-term sources", () => {
  const both = Array.from({ length: 12 }, (_, i) =>
    `${i % 2 ? "CAFÉ" : "Café"} notes from ${i % 3 ? "Zürich" : "Zurich"} session ${i} with detailed discussion and follow up`);
  const decoys = [
    ...Array.from({ length: 15 }, (_, i) => `café menu item ${i} for the office kitchen`),
    ...Array.from({ length: 15 }, (_, i) => `zürich travel plan ${i} for the offsite week`),
    ...Array.from({ length: 30 }, (_, i) => `filler message ${i} about ordinary scheduling`),
  ];
  const msgs = [...both, ...decoys].map((body, i) => ({ id: `p${i}`, subject: "", body }));
  const index = indexMessages(msgs);
  const result = search(index, "café zürich", { limit: 200 });
  assert.equal(result.total, both.length);
  assert.deepEqual(new Set(result.results.map(r => r.message.id)), new Set(msgs.slice(0, both.length).map(m => m.id)));
});

test("empty stays empty, and whole-token discipline holds (no substring matches)", () => {
  const index = indexMessages([
    { id: "d-1", subject: "", body: "deployment checklist for the release" },
    { id: "d-2", subject: "", body: "plain notes" },
  ]);
  assert.deepEqual(search(index, "nonexistentterm").results, []);
  assert.equal(search(index, "nonexistentterm").total, 0);
  assert.deepEqual(search(index, "!!!").results, []);
  // `deploy` is only a substring of the token `deployment`: no match, on
  // the FTS5 path exactly as on the legacy token index (the trigram parity
  // leg is parked with #5112's D2-b, not built here).
  assert.deepEqual(search(index, "deploy").results, []);
  assert.deepEqual(bodies(index, "deployment"), ["d-1"]);
});
