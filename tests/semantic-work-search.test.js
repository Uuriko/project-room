// B023: semantic work search. Pure ranker tests.
import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, searchWork, SearchError } from "../server/work-search.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SearchError && error.code === code);

const documents = [
  { docId: "d1", title: "Fix login bug", body: "The login page crashes on Safari" },
  { docId: "d2", title: "Add dark mode", body: "Implement dark mode for settings" },
  { docId: "d3", title: "Login page redesign", body: "New login flow with OAuth" },
];

test("tokenize normalizes and drops stopwords", () => {
  assert.deepEqual(tokenize("The Quick, Brown Fox!"), ["quick", "brown", "fox"]);
});
test("searchWork ranks by weighted relevance", () => {
  const ranked = searchWork({ query: "login", documents });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].docId, "d1"); // title + body match
  assert.equal(ranked[1].docId, "d3"); // title match only
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.ok(Object.isFrozen(ranked));
});
test("searchWork returns empty for no matches", () => {
  assert.deepEqual(searchWork({ query: "quantum", documents }), []);
});
test("malformed inputs are refused", () => {
  throwsCode(() => searchWork({ query: "", documents }), "invalid_search");
  throwsCode(() => searchWork({ query: "x", documents: [] }), "invalid_search");
});
