// K028: cross-room global search. Pure search tests.
import test from "node:test";
import assert from "node:assert/strict";
import { buildIndex, search, SearchError } from "../server/global-search.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SearchError && error.code === code);

test("indexes and ranks across rooms", () => {
  const index = buildIndex({ messages: [
    { messageId: "m1", roomId: "r1", text: "deploy the new feature today" },
    { messageId: "m2", roomId: "r2", text: "lunch plans for tomorrow" },
    { messageId: "m3", roomId: "r1", text: "deploy failed, rollback needed" },
  ]});
  const results = search({ index, query: "deploy" });
  assert.equal(results.length, 2);
  assert.ok(results[0].score >= results[1].score);
  assert.ok(Object.isFrozen(results));
  const filtered = search({ index, query: "deploy", roomId: "r2" });
  assert.equal(filtered.length, 0);
  const limited = search({ index, query: "deploy", limit: 1 });
  assert.equal(limited.length, 1);
});
test("malformed inputs are refused", () => {
  const index = buildIndex({ messages: [] });
  throwsCode(() => search({ index, query: "" }), "invalid_search");
  throwsCode(() => buildIndex({ messages: "nope" }), "invalid_search");
});
