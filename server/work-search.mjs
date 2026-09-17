// Semantic work search (B023). A pure relevance ranker for agent work
// search: given a query and documents, score by weighted term overlap
// (title matches weigh more than body) with inverse document frequency.
// This is the ranking contract; real embedding-based semantic search is a
// later slice. The module is pure and dependency-free. Frozen outputs;
// malformed inputs throw SearchError.
class SearchError extends Error { constructor(code, message) { super(message); this.name = "SearchError"; this.code = code; } }
const fail = (code, message) => { throw new SearchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_search", message); };
// Tokenize: lowercase, split on non-alphanumeric, drop empties and stopwords.
const STOPWORDS = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for"]);
export function tokenize(text) {
  check(typeof text === "string", "text must be a string");
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 0 && !STOPWORDS.has(t));
}
// Compute IDF across documents (for term weighting).
export function computeIdf(documents) {
  check(Array.isArray(documents), "documents must be an array");
  const docCount = documents.length;
  const df = new Map();
  for (const doc of documents) {
    check(doc !== null && typeof doc === "object", "each document must be an object");
    const terms = new Set(tokenize(`${doc.title ?? ""} ${doc.body ?? ""}`));
    for (const term of terms) df.set(term, (df.get(term) ?? 0) + 1);
  }
  const idf = new Map();
  for (const [term, count] of df) {
    idf.set(term, Math.log(1 + docCount / count));
  }
  return idf;
}
// Rank documents for a query. Each doc: { docId, title, body }. Returns
// [{ docId, score }] sorted by score desc, docId asc for ties.
export function searchWork({ query, documents, idf }) {
  check(typeof query === "string" && query.trim().length > 0, "query must be a non-empty string");
  check(Array.isArray(documents) && documents.length > 0, "documents must be a non-empty array");
  const queryTerms = new Set(tokenize(query));
  check(queryTerms.size > 0, "query must contain searchable terms");
  const idfMap = idf ?? computeIdf(documents);
  const ranked = documents.map(doc => {
    check(typeof doc.docId === "string" && doc.docId.length > 0, "document must have docId");
    const titleTerms = tokenize(doc.title ?? "");
    const bodyTerms = tokenize(doc.body ?? "");
    let score = 0;
    for (const term of queryTerms) {
      const weight = idfMap.get(term) ?? 0;
      const titleCount = titleTerms.filter(t => t === term).length;
      const bodyCount = bodyTerms.filter(t => t === term).length;
      score += weight * (titleCount * 2 + bodyCount);
    }
    return Object.freeze({ docId: doc.docId, score: Math.round(score * 1000) / 1000 });
  });
  ranked.sort((a, b) => b.score - a.score || (a.docId < b.docId ? -1 : 1));
  return Object.freeze(ranked.filter(r => r.score > 0));
}
export { SearchError };
