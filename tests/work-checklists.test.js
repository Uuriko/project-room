// K004: work checklists. Pure module tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createChecklists, ChecklistError } from "../server/work-checklists.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ChecklistError && error.code === code);

test("create, check off in any order, progress", () => {
  const checklists = createChecklists();
  const created = checklists.create("deploy", ["build", "test", "ship"]);
  assert.equal(created.progress, 0);
  assert.equal(created.total, 3);
  const afterOne = checklists.checkOff("deploy", 2, { note: "done early" });
  assert.equal(afterOne.done, 1);
  assert.equal(afterOne.progress, 0.33);
  assert.equal(afterOne.steps[2].note, "done early");
  const afterTwo = checklists.checkOff("deploy", 0);
  assert.equal(afterTwo.progress, 0.67);
  assert.ok(Object.isFrozen(created) && Object.isFrozen(afterOne.steps));
});
test("uncheck resets a step", () => {
  const checklists = createChecklists();
  checklists.create("x", ["a", "b"]);
  checklists.checkOff("x", 0);
  const snap = checklists.uncheck("x", 0);
  assert.equal(snap.done, 0);
  assert.equal(snap.steps[0].done, false);
});
test("malformed inputs are refused", () => {
  const checklists = createChecklists();
  throwsCode(() => checklists.create("x", []), "invalid_checklist");
  checklists.create("x", ["a"]);
  throwsCode(() => checklists.create("x", ["b"]), "invalid_checklist"); // duplicate
  checklists.create("y", ["a"]);
  throwsCode(() => checklists.checkOff("y", 5), "invalid_checklist");
  throwsCode(() => checklists.uncheck("y", 0), "invalid_checklist"); // not checked
});
