// K017: shared whiteboard. Pure board tests.
import test from "node:test";
import assert from "node:assert/strict";
import { createBoards, BoardError, SHAPE_TYPES } from "../server/whiteboard.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof BoardError && error.code === code);

test("add/move/delete/list lifecycle", () => {
  const boards = createBoards();
  const rect = boards.addShape("b1", { type: "rect", x: 10, y: 20, width: 100, height: 50 });
  assert.ok(rect.shapeId.startsWith("shape-"));
  assert.ok(Object.isFrozen(rect));
  const text = boards.addShape("b1", { type: "text", x: 5, y: 5, text: "Hello" });
  assert.equal(boards.list("b1").length, 2);
  const moved = boards.moveShape("b1", { shapeId: rect.shapeId, x: 30, y: 40 });
  assert.equal(moved.x, 30);
  boards.deleteShape("b1", { shapeId: text.shapeId });
  assert.equal(boards.list("b1").length, 1);
  assert.deepEqual(SHAPE_TYPES, ["rect", "ellipse", "line", "text"]);
});
test("malformed shapes are refused", () => {
  const boards = createBoards();
  throwsCode(() => boards.addShape("b1", { type: "circle", x: 0, y: 0, width: 1, height: 1 }),
    "invalid_board");
  throwsCode(() => boards.addShape("b1", { type: "text", x: 0, y: 0, text: "" }),
    "invalid_board");
});
