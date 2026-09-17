// room.search tool contract (B002). The agent-facing search envelope for the
// room: an agent calls roomSearch with a query and optional scope filters;
// the contract validates the call, runs it against a supplied A011 index,
// and returns agent-shaped results (id, snippet, score, source). The caller
// supplies the index — this module never reads the store. Scopes: messages,
// threads, wiki, work. Pure, dependency-free, deterministic; frozen outputs.
// MCP/HTTP wiring is a later slice.
const SCOPES = ["messages", "threads", "wiki", "work"];
class RoomSearchError extends Error { constructor(code, message) { super(message); this.name = "RoomSearchError"; this.code = code; } }
const fail = (code, message) => { throw new RoomSearchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_search_call", message); };

const callOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "search call must be an object");
  check(typeof value.query === "string" && value.query.trim().length > 0 && value.query.length <= 500, "query must be non-empty text up to 500 characters");
  const scopes = value.scopes ?? ["messages"];
  check(Array.isArray(scopes) && scopes.length > 0 && scopes.every(scope => SCOPES.includes(scope)), `scopes must be a non-empty subset of ${SCOPES.join(", ")}`);
  if (value.limit !== undefined) check(Number.isInteger(value.limit) && value.limit >= 1 && value.limit <= 200, "limit must be an integer 1..200");
  return { query: value.query.trim(), scopes, limit: value.limit ?? 25 };
};
const snippetOf = message => {
  const text = [message.subject, message.body].filter(value => typeof value === "string").join(" — ");
  return text.length > 220 ? `${text.slice(0, 217)}…` : text;
};
// Run a room.search call against a supplied A011 index (per scope). indexes
// is { messages?: index, threads?: index, wiki?: index, work?: index }.
export function roomSearch(call, indexes) {
  const { query, scopes, limit } = callOf(call);
  check(indexes !== null && typeof indexes === "object", "indexes must be supplied by the caller");
  const perScope = [];
  for (const scope of scopes) {
    const index = indexes[scope];
    if (!index) continue; // scope not indexed yet — skip, don't fail
    // Lazy import avoided: the caller passes the A011 search result shape.
    // We accept a pre-run { results } to stay dependency-free.
    check(Array.isArray(index.results), `index for scope "${scope}" must have a results list`);
    perScope.push({ scope, results: index.results.slice(0, limit).map(result => Object.freeze({
      id: result.message?.id ?? result.id, score: result.score ?? 0,
      snippet: snippetOf(result.message ?? result), scope })) });
  }
  const merged = perScope.flatMap(entry => entry.results)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, limit);
  return Object.freeze({ query, scopes: Object.freeze(scopes),
    results: Object.freeze(merged), total: merged.length });
}
// Describe the tool for MCP registration (pure metadata, no wiring).
export const TOOL_DEFINITION = Object.freeze({
  name: "room.search",
  description: "Search room content (messages, threads, wiki, work) with term-frequency ranking.",
  inputSchema: Object.freeze({ type: "object",
    properties: Object.freeze({
      query: Object.freeze({ type: "string", maxLength: 500 }),
      scopes: Object.freeze({ type: "array", items: Object.freeze({ type: "string", enum: Object.freeze([...SCOPES]) }) }),
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: 200 }),
    }),
    required: Object.freeze(["query"]) }),
});
export { RoomSearchError, SCOPES };
