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

// H-14 regression (audit 2026-09-30): the manager must seed its id counter
// from a caller-owned pre-populated store.
// Contract: createSavedSearches({ store }) with existing searches must mint
// ids that cannot collide with the stored ones. Credible regression: pre-fix
// searchCounter starts at 0, so the next save() mints ss-1 again, producing
// duplicate searchIds. Existing coverage: no pre-populated-store test
// existed. No new production seams: public createSavedSearches/save/list API.
test("H-14: a manager built on a pre-populated store seeds its id counter — no duplicate ss-N ids", () => {
  const store = new Map();
  store.set("u1", [{ searchId: "ss-1", userId: "u1", name: "x", query: "y", roomId: null }]);
  const saved = createSavedSearches({ store });
  const s = saved.save("u1", { name: "z", query: "w" });
  assert.equal(s.searchId, "ss-2", "new search must not reuse the existing ss-1");
  assert.equal(saved.list("u1").filter((x) => x.searchId === "ss-1").length, 1, "no duplicate ids");
});
