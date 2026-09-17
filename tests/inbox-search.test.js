// A011: full-text search. Pure index/search tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { indexMessages, search, SearchError } from "../server/inbox-search.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SearchError && error.code === code);
const messages = () => [
  { id: "m-1", subject: "Mac provider onboarding", body: "Welcome aboard! Your Mac is ready to compute." },
  { id: "m-2", subject: "Invoice", body: "Your Mac compute invoice for September." },
  { id: "m-3", subject: "Hello", body: "Just saying hello, no computers here." },
];

test("search ranks by term frequency, AND semantics", () => {
  const index = indexMessages(messages());
  const result = search(index, "mac compute");
  assert.deepEqual(result.results.map(r => r.message.id), ["m-1", "m-2"]);
  assert.ok(result.results[0].score >= result.results[1].score);
  assert.equal(result.total, 2);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.results));
});
test("a missing term yields no results", () => {
  const index = indexMessages(messages());
  assert.deepEqual(search(index, "mac zebra").results, []);
  assert.deepEqual(search(index, "!!!").results, []);
});
test("search is case-insensitive and finds substrings as terms", () => {
  const index = indexMessages(messages());
  assert.deepEqual(search(index, "MAC").results.map(r => r.message.id), ["m-1", "m-2"]);
});
test("limit caps the result list", () => {
  const index = indexMessages(messages());
  const result = search(index, "mac", { limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.total, 2);
});
test("malformed inputs are refused", () => {
  throwsCode(() => indexMessages(null), "invalid_search_input");
  throwsCode(() => indexMessages([{ id: "m-1" }, { id: "m-1" }]), "invalid_search_input");
  throwsCode(() => indexMessages([{ id: 7 }]), "invalid_search_input");
  const index = indexMessages(messages());
  throwsCode(() => search(index, ""), "invalid_search_input");
  throwsCode(() => search(index, "mac", { limit: 0 }), "invalid_search_input");
  throwsCode(() => search({}, "mac"), "invalid_search_input");
});
