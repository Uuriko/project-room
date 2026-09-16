// Retrospective tracker (K024). A pure retrospective manager: create
// retros with the classic went-well / to-improve / action-items columns,
// add items, and promote items to tracked action items. All state is
// caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw RetroError. Room UI wiring is a later
// slice.
class RetroError extends Error { constructor(code, message) { super(message); this.name = "RetroError"; this.code = code; } }
const fail = (code, message) => { throw new RetroError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_retro", message); };
const COLUMNS = ["went-well", "to-improve", "action-items"];
// Create a retrospective manager. store is a caller-owned Map (retroId -> retro).
export function createRetros({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const retros = store ?? new Map();
  let retroCounter = 0;
  let itemCounter = 0;
  const getRetro = retroId => {
    check(typeof retroId === "string" && retroId.length > 0, "retroId must be a non-empty string");
    check(retros.has(retroId), `unknown retrospective "${retroId}"`);
    return retros.get(retroId);
  };
  // Create a retrospective.
  const create = ({ title, roomId, facilitatorId }) => {
    check(typeof title === "string" && title.trim().length > 0, "title must be a non-empty string");
    check(typeof roomId === "string" && roomId.length > 0, "roomId must be a non-empty string");
    check(typeof facilitatorId === "string" && facilitatorId.length > 0,
      "facilitatorId must be a non-empty string");
    const retroId = `retro-${++retroCounter}`;
    const retro = { retroId, title: title.trim(), roomId, facilitatorId, items: [] };
    retros.set(retroId, retro);
    return Object.freeze({ retroId, title: retro.title, roomId, facilitatorId, items: Object.freeze([]) });
  };
  // Add an item to a column.
  const addItem = (retroId, { column, text, authorId }) => {
    const retro = getRetro(retroId);
    check(COLUMNS.includes(column), `column must be one of ${COLUMNS.join(", ")}`);
    check(typeof text === "string" && text.trim().length > 0, "text must be a non-empty string");
    check(typeof authorId === "string" && authorId.length > 0, "authorId must be a non-empty string");
    const item = Object.freeze({ itemId: `ritem-${++itemCounter}`, retroId,
      column, text: text.trim(), authorId, votes: 0 });
    retro.items.push(item);
    return item;
  };
  // Vote for an item.
  const vote = (retroId, { itemId }) => {
    const retro = getRetro(retroId);
    check(typeof itemId === "string" && itemId.length > 0, "itemId must be a non-empty string");
    const index = retro.items.findIndex(i => i.itemId === itemId);
    check(index !== -1, `unknown item "${itemId}"`);
    const item = retro.items[index];
    const voted = Object.freeze({ ...item, votes: item.votes + 1 });
    retro.items[index] = voted;
    return voted;
  };
  // Get action items sorted by votes.
  const actionItems = retroId => {
    const retro = getRetro(retroId);
    return Object.freeze(retro.items
      .filter(i => i.column === "action-items")
      .sort((a, b) => b.votes - a.votes));
  };
  return Object.freeze({ create, addItem, vote, actionItems });
}
export { RetroError, COLUMNS };
