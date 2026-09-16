// B002: room.search tool contract. Pure envelope tests; no store.
import test from "node:test";
import assert from "node:assert/strict";
import { roomSearch, TOOL_DEFINITION, RoomSearchError, SCOPES } from "../server/room-search.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RoomSearchError && error.code === code);
const indexes = () => ({
  messages: { results: [
    { message: { id: "m-1", subject: "Mac compute", body: "Your Mac is ready" }, score: 5 },
    { message: { id: "m-2", subject: "Invoice", body: "Mac invoice" }, score: 2 },
  ] },
  wiki: { results: [{ message: { id: "w-1", subject: "Onboarding", body: "Mac setup guide" }, score: 9 }] },
});

test("roomSearch merges scopes ranked by score", () => {
  const result = roomSearch({ query: "mac", scopes: ["messages", "wiki"] }, indexes());
  assert.deepEqual(result.results.map(r => r.id), ["w-1", "m-1", "m-2"]);
  assert.equal(result.results[0].scope, "wiki");
  assert.ok(result.results[0].snippet.includes("Mac setup"));
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.results));
});
test("missing scopes are skipped, not fatal", () => {
  const result = roomSearch({ query: "mac" }, indexes());
  assert.deepEqual(result.results.map(r => r.id), ["m-1", "m-2"]);
  const none = roomSearch({ query: "mac", scopes: ["work"] }, indexes());
  assert.deepEqual(none.results, []);
});
test("malformed calls are refused", () => {
  throwsCode(() => roomSearch({ query: "" }, indexes()), "invalid_search_call");
  throwsCode(() => roomSearch({ query: "x".repeat(501) }, indexes()), "invalid_search_call");
  throwsCode(() => roomSearch({ query: "mac", scopes: ["nope"] }, indexes()), "invalid_search_call");
  throwsCode(() => roomSearch({ query: "mac", limit: 0 }, indexes()), "invalid_search_call");
  throwsCode(() => roomSearch({ query: "mac" }, null), "invalid_search_call");
  assert.equal(TOOL_DEFINITION.name, "room.search");
  assert.deepEqual([...SCOPES], ["messages", "threads", "wiki", "work"]);
});
