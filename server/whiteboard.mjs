// Shared whiteboard (K017). A pure whiteboard state manager: shapes
// (rect, ellipse, line, text) on a canvas, with add/move/delete and
// z-order. Shape rendering is the canvas UI's job; this module owns the
// data model. All state is caller-owned (a Map); the module is pure and
// dependency-free. Frozen outputs; malformed inputs throw BoardError.
// Canvas UI wiring is a later slice.
class BoardError extends Error { constructor(code, message) { super(message); this.name = "BoardError"; this.code = code; } }
const fail = (code, message) => { throw new BoardError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_board", message); };
const SHAPE_TYPES = ["rect", "ellipse", "line", "text"];
// Create a whiteboard manager. store is a caller-owned Map (boardId -> { shapes }).
export function createBoards({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const boards = store ?? new Map();
  let shapeCounter = 0;
  const getBoard = boardId => {
    check(typeof boardId === "string" && boardId.length > 0, "boardId must be a non-empty string");
    if (!boards.has(boardId)) boards.set(boardId, { shapes: [] });
    return boards.get(boardId);
  };
  const checkShape = shape => {
    check(SHAPE_TYPES.includes(shape.type), `type must be one of ${SHAPE_TYPES.join(", ")}`);
    check(typeof shape.x === "number" && typeof shape.y === "number",
      "x and y must be numbers");
    if (shape.type === "text") {
      check(typeof shape.text === "string" && shape.text.length > 0, "text shapes need text");
    } else {
      check(typeof shape.width === "number" && shape.width > 0, "width must be positive");
      check(typeof shape.height === "number" && shape.height > 0, "height must be positive");
    }
  };
  // Add a shape.
  const addShape = (boardId, shape) => {
    const board = getBoard(boardId);
    check(shape !== null && typeof shape === "object", "shape must be an object");
    checkShape(shape);
    const added = Object.freeze({ shapeId: `shape-${++shapeCounter}`, boardId, ...shape });
    board.shapes.push(added);
    return added;
  };
  // Move a shape.
  const moveShape = (boardId, { shapeId, x, y }) => {
    const board = getBoard(boardId);
    check(typeof shapeId === "string" && shapeId.length > 0, "shapeId must be a non-empty string");
    check(typeof x === "number" && typeof y === "number", "x and y must be numbers");
    const index = board.shapes.findIndex(s => s.shapeId === shapeId);
    check(index !== -1, `unknown shape "${shapeId}"`);
    const moved = Object.freeze({ ...board.shapes[index], x, y });
    board.shapes[index] = moved;
    return moved;
  };
  // Delete a shape.
  const deleteShape = (boardId, { shapeId }) => {
    const board = getBoard(boardId);
    check(typeof shapeId === "string" && shapeId.length > 0, "shapeId must be a non-empty string");
    const index = board.shapes.findIndex(s => s.shapeId === shapeId);
    check(index !== -1, `unknown shape "${shapeId}"`);
    board.shapes.splice(index, 1);
    return Object.freeze({ shapeId, deleted: true });
  };
  // List shapes in z-order.
  const list = boardId => Object.freeze([...getBoard(boardId).shapes]);
  return Object.freeze({ addShape, moveShape, deleteShape, list });
}
export { BoardError, SHAPE_TYPES };
