// Cross-room global search (K028). A pure search engine: index messages
// across rooms and run ranked queries. Uses the same TF-IDF/term-overlap
// approach as the work search (B023) but scoped to messages. The module
// is pure and dependency-free. Frozen outputs; malformed inputs throw
// SearchError. Index persistence/UI wiring is a later slice.
class SearchError extends Error { constructor(code, message) { super(message); this.name = "SearchError"; this.code = code; } }
const fail = (code, message) => { throw new SearchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_search", message); };
function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1);
}
// Build a search index from messages.
// messages: [{ messageId, roomId, text }]
export function buildIndex({ messages }) {
  check(Array.isArray(messages), "messages must be an array");
  const docs = [];
  const docFreq = new Map();
  for (const m of messages) {
    check(typeof m.messageId === "string" && m.messageId.length > 0, "messageId must be non-empty");
    check(typeof m.text === "string", "text must be a string");
    const terms = tokenize(m.text);
    const termFreq = new Map();
    for (const t of terms) termFreq.set(t, (termFreq.get(t) || 0) + 1);
    for (const t of termFreq.keys()) docFreq.set(t, (docFreq.get(t) || 0) + 1);
    docs.push({ messageId: m.messageId, roomId: m.roomId || null, text: m.text, termFreq });
  }
  return { docs, docFreq, docCount: docs.length };
}
// Search the index. Returns ranked [{ messageId, roomId, score }].
export function search({ index, query, roomId, limit }) {
  check(index !== null && typeof index === "object", "index must be an object");
  check(typeof query === "string" && query.trim().length > 0, "query must be non-empty");
  check(roomId === undefined || (typeof roomId === "string" && roomId.length > 0),
    "roomId must be non-empty if given");
  check(limit === undefined || (Number.isInteger(limit) && limit > 0), "limit must be positive if given");
  const queryTerms = tokenize(query);
  check(queryTerms.length > 0, "query has no searchable terms");
  const results = [];
  for (const doc of index.docs) {
    if (roomId && doc.roomId !== roomId) continue;
    let score = 0;
    for (const qt of queryTerms) {
      const tf = doc.termFreq.get(qt) || 0;
      if (tf === 0) continue;
      const df = index.docFreq.get(qt) || 1;
      const idf = Math.log(1 + index.docCount / df);
      score += tf * idf;
    }
    if (score > 0) results.push({ messageId: doc.messageId, roomId: doc.roomId, score });
  }
  results.sort((a, b) => b.score - a.score);
  const limited = limit ? results.slice(0, limit) : results;
  return Object.freeze(limited.map(r => Object.freeze(r)));
}
export { SearchError };
