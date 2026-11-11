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
test("non-Latin scripts index and are searchable in their own script", () => {
  const index = indexMessages([
    { id: "ar", subject: "", body: "مرحبا بالعالم هذا اختبار" },
    { id: "ru", subject: "", body: "привет мир тест" },
    { id: "zh", subject: "", body: "你好 世界 测试" },
    { id: "fr", subject: "", body: "café au lait" },
  ]);
  assert.deepEqual(search(index, "مرحبا").results.map(r => r.message.id), ["ar"]);
  assert.deepEqual(search(index, "привет").results.map(r => r.message.id), ["ru"]);
  assert.deepEqual(search(index, "世界").results.map(r => r.message.id), ["zh"]);
  assert.deepEqual(search(index, "café").results.map(r => r.message.id), ["fr"]);
});
test("ASCII tokenisation is unchanged", () => {
  const index = indexMessages([
    { id: "m-1", subject: "Mac provider onboarding", body: "Welcome aboard! Your Mac is ready to compute." },
    { id: "m-2", subject: "Invoice 42", body: "Your Mac compute invoice for September. Order 123-456, don't split_a-part x" },
    { id: "m-3", subject: "Hello", body: "Just saying hello, no computers here. A I an it is on up" },
  ]);
  assert.deepEqual([...index.terms.keys()].sort(), ["123", "42", "456", "aboard", "an", "compute", "computers", "don", "for", "hello", "here", "invoice", "is", "it", "just", "mac", "no", "on", "onboarding", "order", "part", "provider", "ready", "saying", "september", "split", "to", "up", "welcome", "your"]);
  assert.deepEqual(search(index, "mac compute").results.map(r => [r.message.id, r.score]), [["m-1", 3], ["m-2", 2]]);
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
