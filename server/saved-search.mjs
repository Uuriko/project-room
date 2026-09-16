// Saved searches (K029). A pure saved-search manager: store named
// queries (smart folders) per user, with optional room scoping. All state
// is caller-owned (a Map); the module is pure and dependency-free. Frozen
// outputs; malformed inputs throw SavedError. UI wiring is a later slice.
class SavedError extends Error { constructor(code, message) { super(message); this.name = "SavedError"; this.code = code; } }
const fail = (code, message) => { throw new SavedError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_saved", message); };
// Create a saved-search manager. store is a caller-owned Map (userId -> searches[]).
export function createSavedSearches({ store } = {}) {
  check(store === undefined || store instanceof Map, "store must be a Map if given");
  const users = store ?? new Map();
  let searchCounter = 0;
  const searchesFor = userId => {
    check(typeof userId === "string" && userId.length > 0, "userId must be a non-empty string");
    if (!users.has(userId)) users.set(userId, []);
    return users.get(userId);
  };
  // Save a search.
  const save = (userId, { name, query, roomId }) => {
    const searches = searchesFor(userId);
    check(typeof name === "string" && name.trim().length > 0, "name must be a non-empty string");
    check(typeof query === "string" && query.trim().length > 0, "query must be a non-empty string");
    check(roomId === undefined || (typeof roomId === "string" && roomId.length > 0),
      "roomId must be non-empty if given");
    check(!searches.some(s => s.name.toLowerCase() === name.trim().toLowerCase()),
      `a saved search named "${name.trim()}" already exists`);
    const saved = Object.freeze({ searchId: `ss-${++searchCounter}`, userId,
      name: name.trim(), query: query.trim(), roomId: roomId || null });
    searches.push(saved);
    return saved;
  };
  // List saved searches for a user.
  const list = userId => Object.freeze([...searchesFor(userId)]);
  // Delete a saved search.
  const remove = (userId, { searchId }) => {
    const searches = searchesFor(userId);
    check(typeof searchId === "string" && searchId.length > 0, "searchId must be a non-empty string");
    const index = searches.findIndex(s => s.searchId === searchId);
    check(index !== -1, `unknown saved search "${searchId}"`);
    searches.splice(index, 1);
    return Object.freeze({ searchId, deleted: true });
  };
  return Object.freeze({ save, list, remove });
}
export { SavedError };
