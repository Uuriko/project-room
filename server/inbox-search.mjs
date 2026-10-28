// Full-text search (A011), FTS5 consolidation leg for the inbox: the search
// engine is SQLite FTS5 with the same tokenizer as the room-message index
// (server/message-search.mjs, PERF-50 D2-a): `unicode61 remove_diacritics 2`,
// AND of terms, bm25 ranking. The index is derived and ephemeral: the caller
// (Inbox.search) already assembles the visible source texts per request, so
// indexMessages keeps those texts and search() builds a throwaway in-memory
// FTS5 index over exactly that set, queries it, and closes it — no persistent
// table, no backfill, and visibility/quarantine filtering stays where it has
// always lived, in the caller, before any text reaches this module.
//
// Why not the old tokenizer: the previous in-memory inverted index tokenized
// with `toLowerCase().split(/[^a-z0-9]+/)`, so every non-ASCII character was a
// separator. Greek/Arabic/Cyrillic/CJK queries tokenized to nothing and could
// never match, and accented Latin only matched by symmetric mangling — the
// ASCII-folded queries FTS5 exists to serve (`cafe` for `CAFÉ`, `zurich` for
// `Zürich`, `istanbul` for `İstanbul`) returned nothing. That is the
// #5035/#5040 defect family in stronger form. unicode61 folds case and strips
// diacritics on both sides, so the pinned #5035 needle sets (äpfel, café,
// σίσυφος, œuvre, the JS fold of İstanbul, plus the folded forms) all match
// exactly; tests/inbox-search-fts.test.js pins them on this surface.
//
// Fallback: on a SQLite build without FTS5 (or without node:sqlite), search
// falls back to the legacy inverted index below, verbatim — the same
// discipline as #5112's legacy scan fallback. Outputs stay frozen and
// deterministic on both paths.
import { DatabaseSync } from "node:sqlite";

class SearchError extends Error { constructor(code, message) { super(message); this.name = "SearchError"; this.code = code; } }
const fail = (code, message) => { throw new SearchError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_search_input", message); };

const textOf = (message, fields) => fields.map(field => message[field]).filter(value => typeof value === "string").join("\n");
const messageOf = value => {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "messages must be objects");
  check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 512, "message id must be 1..512 characters");
  return value;
};
// Query/index terms, extracted exactly as in server/message-search.mjs
// (#5112): the JS fold first, combining marks kept inside a term (the JS fold
// of `İ` is `i` + U+0307; splitting there would shard the term), then the FTS
// tokenizer folds each term again (case + diacritics). One legacy rule is
// preserved: a bare single-character ASCII term is dropped, as the old
// tokenizer dropped it on both sides, so no query that matched before loses
// or gains a term; a single non-ASCII character (ß, a CJK character, ...) is
// a real term and is kept.
const searchTerms = text => [...String(text ?? "").toLowerCase().matchAll(/[\p{L}\p{N}\p{M}]+/gu)]
  .map(m => m[0])
  .filter(term => [...term].length > 1 || /[^\x00-\x7F]/.test(term));
const knownIndexes = new WeakSet();
// Build the index: the visible messages and their searchable texts. Frozen.
export function indexMessages(messages, { fields } = {}) {
  check(Array.isArray(messages) && messages.length <= 50000, "messages must be a list of at most 50000");
  const useFields = fields ?? ["subject", "body"];
  check(Array.isArray(useFields) && useFields.length > 0, "fields must be a non-empty list");
  const docs = new Map(), texts = [];
  for (const message of messages.map(messageOf)) {
    if (docs.has(message.id)) fail("invalid_search_input", `duplicate message id "${message.id}"`);
    const text = textOf(message, useFields);
    docs.set(message.id, Object.freeze({ id: message.id, length: new Set(searchTerms(text)).size, message }));
    texts.push(Object.freeze({ id: message.id, text }));
  }
  const index = Object.freeze({ documentCount: docs.size,
    docs: Object.freeze(docs), texts: Object.freeze(texts) });
  knownIndexes.add(index);
  return index;
}
const indexOf = value => {
  check(value !== null && typeof value === "object" && knownIndexes.has(value), "index must come from indexMessages");
  return value;
};
const limitOf = value => {
  if (value === undefined || value === null) return 25;
  check(Number.isInteger(value) && value >= 1 && value <= 200, "limit must be an integer 1..200");
  return value;
};
const ftsMatch = terms => terms.map(term => `"${term.replaceAll('"', '""')}"`).join(" AND ");
// The FTS5 path. Returns null when this SQLite build cannot create or query
// an FTS5 table, so the caller falls back to the legacy index.
function searchFts(index, terms, take) {
  let db;
  try {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE inbox_docs_fts USING fts5(text, tokenize='unicode61 remove_diacritics 2')");
    // Chunked multi-row inserts: one statement per chunk is its own
    // transaction, so the build stays fast without opening a transaction
    // by hand (room/no-raw-transaction) on this throwaway database.
    const CHUNK = 128;
    for (let at = 0; at < index.texts.length; at += CHUNK) {
      const chunk = index.texts.slice(at, at + CHUNK);
      const insert = db.prepare(
        `INSERT INTO inbox_docs_fts(rowid, text) VALUES ${chunk.map(() => "(?, ?)").join(", ")}`);
      insert.run(...chunk.flatMap(({ text }, i) => [at + i + 1, text]));
    }
    const rows = db.prepare(
      "SELECT rowid, bm25(inbox_docs_fts) AS rank FROM inbox_docs_fts WHERE inbox_docs_fts MATCH ?"
    ).all(ftsMatch(terms));
    // bm25() ranks best-first (most negative first); ties break by message
    // id, the legacy deterministic order. The exposed score is the negated
    // rank, so a better hit carries the larger score, as term frequency did.
    const scored = rows
      .map(row => ({ id: index.texts[row.rowid - 1].id, score: -row.rank }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return Object.freeze({ total: scored.length,
      results: Object.freeze(scored.slice(0, take)
        .map(({ id, score }) => Object.freeze({ message: index.docs.get(id).message, score }))) });
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
// The legacy inverted-index path (pre-FTS5 engine, kept verbatim as the
// no-FTS5 fallback, with its own original tokenizer applied to both the
// documents and the query): term -> Map(messageId -> frequency), AND of
// terms, ranked by total term frequency, ties by message id.
function searchLegacy(index, query, take) {
  const terms = [...new Set(String(query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 1))];
  if (terms.length === 0) return { results: [], total: 0 };
  const postingsByTerm = new Map();
  for (const { id, text } of index.texts) {
    const counts = new Map();
    for (const term of String(text ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(term => term.length > 1))
      counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, n] of counts) {
      if (!postingsByTerm.has(term)) postingsByTerm.set(term, new Map());
      postingsByTerm.get(term).set(id, n);
    }
  }
  const postings = terms.map(term => postingsByTerm.get(term));
  if (postings.some(posting => !posting)) return { results: [], total: 0 };
  const scores = new Map();
  for (const [messageId] of postings[0]) {
    if (!postings.every(posting => posting.has(messageId))) continue;
    scores.set(messageId, postings.reduce((sum, posting) => sum + posting.get(messageId), 0));
  }
  const results = [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, take)
    .map(([messageId, score]) => Object.freeze({ message: index.docs.get(messageId).message, score }));
  return { results, total: scores.size };
}
// Search. All query terms must appear (AND); results rank best first
// (bm25 on the FTS5 path), ties break by message id for determinism.
export function search(index, query, { limit, fields } = {}) {
  const built = indexOf(index), take = limitOf(limit);
  check(typeof query === "string" && query.trim().length > 0 && query.length <= 500, "query must be non-empty text up to 500 characters");
  const queryTerms = [...new Set(searchTerms(query))];
  if (queryTerms.length === 0) return Object.freeze({ query, results: Object.freeze([]), total: 0 });
  const fts = searchFts(built, queryTerms, take);
  if (fts) return Object.freeze({ query, results: fts.results, total: fts.total });
  const legacy = searchLegacy(built, query, take);
  return Object.freeze({ query, results: Object.freeze(legacy.results), total: legacy.total });
}
export { SearchError };
