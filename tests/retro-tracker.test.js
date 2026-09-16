// K024: retrospective tracker. Pure retro tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createRetros, RetroError, COLUMNS } from "../server/retros.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof RetroError && error.code === code);

test("create/addItem/vote/actionItems lifecycle", () => {
  const retros = createRetros();
  const retro = retros.create({ title: "Sprint 5", roomId: "room1", facilitatorId: "ada" });
  assert.ok(retro.retroId.startsWith("retro-"));
  assert.ok(Object.isFrozen(retro));
  const item1 = retros.addItem(retro.retroId, { column: "went-well", text: "Shipped on time", authorId: "ada" });
  const item2 = retros.addItem(retro.retroId, { column: "action-items", text: "Fix flaky test", authorId: "bob" });
  retros.vote(retro.retroId, { itemId: item2.itemId });
  retros.vote(retro.retroId, { itemId: item2.itemId });
  const actions = retros.actionItems(retro.retroId);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].votes, 2);
  assert.deepEqual(COLUMNS, ["went-well", "to-improve", "action-items"]);
  assert.ok(item1.itemId !== item2.itemId);
});
test("malformed inputs are refused", () => {
  const retros = createRetros();
  const retro = retros.create({ title: "R", roomId: "room1", facilitatorId: "a" });
  throwsCode(() => retros.addItem(retro.retroId, { column: "nope", text: "x", authorId: "a" }), "invalid_retro");
  throwsCode(() => retros.vote(retro.retroId, { itemId: "ghost" }), "invalid_retro");
});
