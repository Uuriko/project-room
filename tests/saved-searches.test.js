// K029: saved searches. Pure manager tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createSavedSearches, SavedError } from "../server/saved-search.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof SavedError && error.code === code);

test("save/list/remove lifecycle", () => {
  const saved = createSavedSearches();
  const s1 = saved.save("ada", { name: "Deploys", query: "deploy", roomId: "r1" });
  assert.ok(s1.searchId.startsWith("ss-"));
  assert.ok(Object.isFrozen(s1));
  saved.save("ada", { name: "Bugs", query: "bug" });
  const list = saved.list("ada");
  assert.equal(list.length, 2);
  saved.remove("ada", { searchId: s1.searchId });
  assert.equal(saved.list("ada").length, 1);
});
test("duplicate names are refused", () => {
  const saved = createSavedSearches();
  saved.save("ada", { name: "Deploys", query: "deploy" });
  throwsCode(() => saved.save("ada", { name: "deploys", query: "ship" }), "invalid_saved");
});
test("malformed inputs are refused", () => {
  const saved = createSavedSearches();
  throwsCode(() => saved.save("ada", { name: "", query: "x" }), "invalid_saved");
  throwsCode(() => saved.remove("ada", { searchId: "ghost" }), "invalid_saved");
});
