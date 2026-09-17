// Full-text search (A011). A pure in-memory inverted index over message
// envelopes: indexMessages builds the index, search runs a query against it
// with term-frequency ranking. Pure, dependency-free, deterministic; frozen
// outputs. The caller decides which text fields to index (subject + body by
// default). Store integration is a later slice.
class SearchError extends Error { constructor(code, message) { super(message); this.name = "SearchError"; this.code = code; } }
const fail = (code, message) => { throw new SearchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_search_input", message); };

const tokenize = text => String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 1);
const textOf = (message, fields) => fields.map(field => message[field]).filter(value => typeof value === "string").join("\n");
const messageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "messages must be objects");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  return value;
};
// Build the index. terms: term -> Map(messageId -> frequency). Frozen.
export function indexMessages(messages, { fields } = {}) {
  check(Array.isArray(messages) && messages.length <= 50000, "messages must be a list of at most 50000");
  const useFields = fields ?? ["subject", "body"];
  check(Array.isArray(useFields) && useFields.length > 0, "fields must be a non-empty list");
  const terms = new Map(), docs = new Map();
  for (const message of messages.map(messageOf)) {
    if (docs.has(message.id)) fail("invalid_search_input", `duplicate message id "${message.id}"`);
    const counts = new Map();
    for (const term of tokenize(textOf(message, useFields))) {
      counts.set(term, (counts.get(term) ?? 0) + 1);
      if (!terms.has(term)) terms.set(term, new Map());
      terms.get(term).set(message.id, (terms.get(term).get(message.id) ?? 0) + 1);
    }
    docs.set(message.id, Object.freeze({ id: message.id, length: counts.size, message }));
  }
  return Object.freeze({ documentCount: docs.size,
    terms: Object.freeze(terms), docs: Object.freeze(docs) });
}
const indexOf = value => {
  check(value !== null && typeof value === "object", "index must be an index");
  check(value.terms instanceof Map && value.docs instanceof Map, "index must come from indexMessages");
  return value;
};
const limitOf = value => {
  if (value === undefined || value === null) return 25;
  check(Number.isInteger(value) && value >= 1 && value <= 200, "limit must be an integer 1..200");
  return value;
};
// Search. All query terms must appear (AND); results rank by total term
// frequency, ties break by message id for determinism.
export function search(index, query, { limit, fields } = {}) {
  const built = indexOf(index), take = limitOf(limit);
  check(typeof query === "string" && query.trim().length > 0 && query.length <= 500, "query must be non-empty text up to 500 characters");
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return Object.freeze({ query, results: Object.freeze([]), total: 0 });
  const postings = queryTerms.map(term => built.terms.get(term));
  if (postings.some(posting => !posting)) return Object.freeze({ query, results: Object.freeze([]), total: 0 });
  const scores = new Map();
  for (const [messageId] of postings[0]) {
    if (!postings.every(posting => posting.has(messageId))) continue;
    scores.set(messageId, postings.reduce((sum, posting) => sum + posting.get(messageId), 0));
  }
  const results = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, take)
    .map(([messageId, score]) => Object.freeze({ message: built.docs.get(messageId).message, score }));
  return Object.freeze({ query, results: Object.freeze(results), total: scores.size });
}
export { SearchError };
