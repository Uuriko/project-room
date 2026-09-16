/**
 * mailbox-search-store.mjs — Pure in-memory full-text search index + message store.
 *
 * Indexes mailbox messages ({ id, from, to, subject, body, channel, ts }) in an
 * inverted index and serves ranked search. Nothing here touches the network, the
 * DOM, localStorage, or any secret — it is a pure in-memory structure whose only
 * persistence path is the injected `storage` dep (write-through on mutation).
 *
 * Index design:
 *   - Tokenizer: lowercase, split on non-alphanumeric runs, small built-in
 *     stopword removal. Injectable via `deps.tokenizer` for custom analyzers.
 *   - Per-term posting lists: term -> docId -> per-field term counts.
 *   - Field weights (subject x3, from x2, to x2, body x1, channel x1).
 *   - Score: sum over query terms of (term frequency x field weight); exact
 *     quoted phrases add a flat PHRASE_BONUS each. Ranking is score descending,
 *     then ts descending (newest first) as tie-break.
 *   - Query language: plain terms (AND semantics), quoted phrases for exact
 *     substring match, and field filters `channel:`, `from:`, `to:`,
 *     `subject:` (case-insensitive, prefix-matched on token).
 *
 * Dependency injection (all via the `deps` parameter of createMailboxSearchStore):
 *   - clock:        () => number  (ms epoch; default: Date.now)
 *   - id:           () => string  (auto document id generator; default: ms- counter)
 *   - storage:      { get(key), set(key, value) } (default: in-memory stub)
 *   - storageKey:   string        (default: 'mailbox-search:v1')
 *   - tokenizer:    (text: string) => string[] (default: built-in)
 *   - historyCap:   number        (recent-search cap; default: 20)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   MS_NOT_FOUND         — unknown document id (get/remove/update)
 *   MS_DUPLICATE_ID      — addDocument with an id that already exists
 *   MS_INVALID_DOCUMENT  — addDocument missing required string fields
 *   MS_INVALID_QUERY     — empty / non-string / whitespace-only query
 *   MS_INVALID_PAGINATION— limit/offset not non-negative integers
 *   MS_SAVED_EXISTS      — saveSearch with a name that already exists
 *   MS_SAVED_NOT_FOUND   — delete/get of an unknown saved-search name
 *   MS_CORRUPT_SNAPSHOT  — restore() / persisted snapshot fails validation
 *   MS_STORAGE_ERROR     — the injected storage threw (wrapped, never silent)
 * Failures are never silent.
 */

export const SCHEMA = 'mailbox-search-store';
export const SNAPSHOT_VERSION = 1;
export const DEFAULT_STORAGE_KEY = 'mailbox-search:v1';
export const DEFAULT_HISTORY_CAP = 20;
export const PHRASE_BONUS = 10;

/** Field weights applied to term frequencies when scoring. */
export const FIELD_WEIGHTS = Object.freeze({
  subject: 3,
  from: 2,
  to: 2,
  body: 1,
  channel: 1,
});

const SEARCHABLE_FIELDS = Object.keys(FIELD_WEIGHTS);

/** Small built-in stopword list for the default tokenizer. */
export const STOPWORDS = Object.freeze([
  'a', 'all', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'for', 'from', 'had', 'has',
  'have', 'he', 'her', 'him', 'his', 'how', 'i', 'if', 'in', 'is', 'it',
  'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she', 'so',
  'than', 'that', 'the', 'their', 'them', 'these', 'they', 'this', 'those',
  'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'would', 'you', 'your',
]);

const STOPWORD_SET = new Set(STOPWORDS);

/** Throw a coded search-store error (never silent failures). */
function searchError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default in-memory storage stub used when no storage dep is injected. */
function memoryStorage() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : undefined),
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

/**
 * Default tokenizer: lowercase, split on non-alphanumeric runs, drop stopwords.
 * @param {string} text
 * @returns {string[]}
 */
export function defaultTokenizer(text) {
  if (typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !STOPWORD_SET.has(token));
}

/**
 * Parse a search query into terms, phrases, and field filters.
 * @param {string} query
 * @param {(text: string) => string[]} tokenizer
 */
function parseQuery(query, tokenizer) {
  const terms = [];
  const phrases = [];
  const filters = []; // { field, value } — value is a single normalized token
  const fieldFilterRe = /^(channel|from|to|subject):(.+)$/i;

  // Extract quoted phrases first so their contents never become terms.
  const remaining = query.replace(/"([^"]+)"/g, (_match, inner) => {
    const normalized = inner.toLowerCase().replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) phrases.push(normalized);
    return ' ';
  });

  for (const raw of remaining.split(/\s+/)) {
    if (raw.length === 0) continue;
    const filterMatch = raw.match(fieldFilterRe);
    if (filterMatch) {
      const tokens = tokenizer(filterMatch[2]);
      if (tokens.length > 0) {
        filters.push({ field: filterMatch[1].toLowerCase(), value: tokens[0] });
      }
      continue;
    }
    for (const token of tokenizer(raw)) terms.push(token);
  }

  if (terms.length === 0 && phrases.length === 0 && filters.length === 0) {
    throw searchError(
      'MS_INVALID_QUERY',
      'Query produced no searchable terms, phrases, or field filters',
      { query },
    );
  }
  return { terms, phrases, filters };
}

/**
 * Create a new mailbox full-text search store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ get(string): any, set(string, any): void }} [deps.storage]
 * @param {string} [deps.storageKey]
 * @param {(text: string) => string[]} [deps.tokenizer]
 * @param {number} [deps.historyCap]
 */
export function createMailboxSearchStore(deps = {}) {
  const clock = deps.clock ?? Date.now;
  const storage = deps.storage ?? memoryStorage();
  const storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;
  const tokenize = deps.tokenizer ?? defaultTokenizer;
  const historyCap = deps.historyCap ?? DEFAULT_HISTORY_CAP;
  let counter = 0;
  const generateId = deps.id ?? (() => `ms-${clock()}-${(counter += 1)}`);

  // documents: id -> message record
  // postings: term -> Map(id -> { subject, from, to, body, channel })
  // savedSearches: name -> { name, query, savedAt }
  // recentSearches: newest-first array of { query, searchedAt }
  let documents = new Map();
  let postings = new Map();
  let savedSearches = new Map();
  let recentSearches = [];

  function writeThrough() {
    try {
      storage.set(storageKey, snapshot());
    } catch (err) {
      throw searchError(
        'MS_STORAGE_ERROR',
        `Storage write failed for key ${storageKey}: ${err.message}`,
        { storageKey },
      );
    }
  }

  /** Index every searchable field of a document. */
  function indexDocument(doc) {
    for (const field of SEARCHABLE_FIELDS) {
      const value = doc[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      for (const term of tokenize(value)) {
        let posting = postings.get(term);
        if (!posting) {
          posting = new Map();
          postings.set(term, posting);
        }
        let counts = posting.get(doc.id);
        if (!counts) {
          counts = { subject: 0, from: 0, to: 0, body: 0, channel: 0 };
          posting.set(doc.id, counts);
        }
        counts[field] += 1;
      }
    }
  }

  /** Drop every posting belonging to a document. */
  function deindexDocument(id) {
    for (const [term, posting] of postings) {
      posting.delete(id);
      if (posting.size === 0) postings.delete(term);
    }
  }

  function validateDocumentInput(doc) {
    if (doc === null || typeof doc !== 'object') {
      throw searchError('MS_INVALID_DOCUMENT', 'Document must be an object', { doc });
    }
    for (const field of ['from', 'to', 'subject', 'body', 'channel']) {
      if (typeof doc[field] !== 'string' || doc[field].length === 0) {
        throw searchError(
          'MS_INVALID_DOCUMENT',
          `Document field "${field}" must be a non-empty string`,
          { field },
        );
      }
    }
    if (doc.id !== undefined && (typeof doc.id !== 'string' || doc.id.length === 0)) {
      throw searchError('MS_INVALID_DOCUMENT', 'Document id must be a non-empty string', {
        id: doc.id,
      });
    }
    if (doc.ts !== undefined && typeof doc.ts !== 'number') {
      throw searchError('MS_INVALID_DOCUMENT', 'Document ts must be a number', { ts: doc.ts });
    }
  }

  function requireDocument(id) {
    const doc = documents.get(id);
    if (!doc) {
      throw searchError('MS_NOT_FOUND', `No document with id "${id}"`, { id });
    }
    return doc;
  }

  function addDocument(doc) {
    validateDocumentInput(doc);
    const id = doc.id ?? generateId();
    if (documents.has(id)) {
      throw searchError('MS_DUPLICATE_ID', `Document id "${id}" already indexed`, { id });
    }
    const record = {
      id,
      from: doc.from,
      to: doc.to,
      subject: doc.subject,
      body: doc.body,
      channel: doc.channel,
      ts: doc.ts ?? clock(),
      indexedAt: clock(),
    };
    documents.set(id, record);
    indexDocument(record);
    writeThrough();
    return { ...record };
  }

  function removeDocument(id) {
    const record = requireDocument(id);
    deindexDocument(id);
    documents.delete(id);
    writeThrough();
    return { ...record };
  }

  function updateDocument(id, patch) {
    const current = requireDocument(id);
    if (patch === null || typeof patch !== 'object') {
      throw searchError('MS_INVALID_DOCUMENT', 'Update patch must be an object', { patch });
    }
    const merged = { ...current, ...patch, id: current.id };
    validateDocumentInput(merged);
    deindexDocument(id);
    const record = { ...merged, ts: merged.ts ?? clock(), indexedAt: clock() };
    documents.set(id, record);
    indexDocument(record);
    writeThrough();
    return { ...record };
  }

  function getDocument(id) {
    return { ...requireDocument(id) };
  }

  function documentCount() {
    return documents.size;
  }

  /** Lowercased single-space haystack used for exact phrase matching. */
  function phraseHaystack(doc) {
    return SEARCHABLE_FIELDS.map((field) => doc[field] ?? '')
      .join(' ')
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /**
   * Search the index.
   * @param {string} query
   * @param {{ limit?: number, offset?: number }} [pagination]
   * @returns {{ total: number, limit: number, offset: number, query: string, results: Array<{ id: string, score: number, doc: object }> }}
   */
  function search(query, pagination = {}) {
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw searchError('MS_INVALID_QUERY', 'Query must be a non-empty string', { query });
    }
    const limit = pagination.limit ?? 20;
    const offset = pagination.offset ?? 0;
    if (
      !Number.isInteger(limit)
      || !Number.isInteger(offset)
      || limit < 0
      || offset < 0
    ) {
      throw searchError('MS_INVALID_PAGINATION', 'limit and offset must be non-negative integers', {
        limit: pagination.limit,
        offset: pagination.offset,
      });
    }

    const { terms, phrases, filters } = parseQuery(query, tokenize);

    // Candidate set: intersection of posting lists for AND term semantics.
    let candidates = null;
    for (const term of terms) {
      const posting = postings.get(term);
      if (!posting) {
        candidates = new Set();
        break;
      }
      const ids = new Set(posting.keys());
      candidates = candidates === null ? ids : new Set([...candidates].filter((id) => ids.has(id)));
      if (candidates.size === 0) break;
    }
    if (candidates === null) {
      // No terms: phrase/filter-only query scans all documents.
      candidates = new Set(documents.keys());
    }

    const results = [];
    for (const id of candidates) {
      const doc = documents.get(id);
      if (!doc) continue;

      let score = 0;
      for (const term of terms) {
        const counts = postings.get(term)?.get(id);
        if (!counts) continue; // cannot happen under AND semantics; defensive
        for (const field of SEARCHABLE_FIELDS) {
          score += counts[field] * FIELD_WEIGHTS[field];
        }
      }

      const haystack = phrases.length > 0 ? phraseHaystack(doc) : '';
      let phraseMiss = false;
      for (const phrase of phrases) {
        if (!haystack.includes(phrase)) {
          phraseMiss = true;
          break;
        }
        score += PHRASE_BONUS;
      }
      if (phraseMiss) continue;

      let filterMiss = false;
      for (const { field, value } of filters) {
        const fieldText = doc[field];
        if (typeof fieldText !== 'string' || !tokenize(fieldText).includes(value)) {
          filterMiss = true;
          break;
        }
      }
      if (filterMiss) continue;

      results.push({ id, score, doc: { ...doc } });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.doc.ts - a.doc.ts; // ts tie-break: newest first
    });

    const total = results.length;
    const page = results.slice(offset, offset + limit);

    recordRecentSearch(query.trim());

    return { total, limit, offset, query: query.trim(), results: page };
  }

  function recordRecentSearch(query) {
    recentSearches = [
      { query, searchedAt: clock() },
      ...recentSearches.filter((entry) => entry.query !== query),
    ].slice(0, Math.max(1, historyCap));
    writeThrough();
  }

  function getRecentSearches() {
    return recentSearches.map((entry) => ({ ...entry }));
  }

  function clearRecentSearches() {
    recentSearches = [];
    writeThrough();
  }

  function saveSearch(name, query) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw searchError('MS_INVALID_QUERY', 'Saved-search name must be a non-empty string', {
        name,
      });
    }
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw searchError('MS_INVALID_QUERY', 'Saved-search query must be a non-empty string', {
        query,
      });
    }
    if (savedSearches.has(name)) {
      throw searchError('MS_SAVED_EXISTS', `Saved search "${name}" already exists`, { name });
    }
    const entry = { name, query: query.trim(), savedAt: clock() };
    savedSearches.set(name, entry);
    writeThrough();
    return { ...entry };
  }

  function listSavedSearches() {
    return [...savedSearches.values()].map((entry) => ({ ...entry }));
  }

  function deleteSavedSearch(name) {
    const entry = savedSearches.get(name);
    if (!entry) {
      throw searchError('MS_SAVED_NOT_FOUND', `No saved search named "${name}"`, { name });
    }
    savedSearches.delete(name);
    writeThrough();
    return { ...entry };
  }

  /** Serialize the full store state as a JSON-safe snapshot. */
  function snapshot() {
    const index = {};
    for (const [term, posting] of postings) {
      const entry = {};
      for (const [id, counts] of posting) entry[id] = { ...counts };
      index[term] = entry;
    }
    return {
      schema: SCHEMA,
      version: SNAPSHOT_VERSION,
      savedAt: clock(),
      data: {
        documents: Object.fromEntries([...documents].map(([id, doc]) => [id, { ...doc }])),
        index,
        savedSearches: Object.fromEntries(
          [...savedSearches].map(([name, entry]) => [name, { ...entry }]),
        ),
        recentSearches: recentSearches.map((entry) => ({ ...entry })),
      },
    };
  }

  /** Validate a snapshot payload; throws MS_CORRUPT_SNAPSHOT on any mismatch. */
  function assertValidSnapshot(payload) {
    const fail = (reason) => {
      throw searchError('MS_CORRUPT_SNAPSHOT', `Snapshot rejected: ${reason}`, { reason });
    };
    if (payload === null || typeof payload !== 'object') fail('not an object');
    if (payload.schema !== SCHEMA) fail(`schema must be "${SCHEMA}"`);
    if (payload.version !== SNAPSHOT_VERSION) fail(`version must be ${SNAPSHOT_VERSION}`);
    const data = payload.data;
    if (data === null || typeof data !== 'object') fail('missing data block');
    if (data.documents === null || typeof data.documents !== 'object') fail('bad documents block');
    if (data.index === null || typeof data.index !== 'object') fail('bad index block');
    if (data.savedSearches === null || typeof data.savedSearches !== 'object') {
      fail('bad savedSearches block');
    }
    if (!Array.isArray(data.recentSearches)) fail('bad recentSearches block');
    for (const [term, posting] of Object.entries(data.index)) {
      if (posting === null || typeof posting !== 'object') fail(`bad posting for term "${term}"`);
      for (const [id, counts] of Object.entries(posting)) {
        if (counts === null || typeof counts !== 'object') fail(`bad counts for term "${term}" doc "${id}"`);
        for (const field of SEARCHABLE_FIELDS) {
          if (typeof counts[field] !== 'number') {
            fail(`bad count field "${field}" for term "${term}" doc "${id}"`);
          }
        }
      }
    }
  }

  /** Replace store state from a snapshot (validated; corrupts throw). */
  function restore(payload) {
    assertValidSnapshot(payload);
    const { data } = payload;
    const nextDocuments = new Map();
    for (const [id, doc] of Object.entries(data.documents)) {
      if (typeof id !== 'string' || id.length === 0) {
        throw searchError('MS_CORRUPT_SNAPSHOT', 'Snapshot rejected: document with bad id');
      }
      nextDocuments.set(id, { ...doc, id });
    }
    const nextPostings = new Map();
    for (const [term, posting] of Object.entries(data.index)) {
      const nextPosting = new Map();
      for (const [id, counts] of Object.entries(posting)) nextPosting.set(id, { ...counts });
      nextPostings.set(term, nextPosting);
    }
    const nextSaved = new Map();
    for (const [name, entry] of Object.entries(data.savedSearches)) {
      nextSaved.set(name, { ...entry });
    }
    documents = nextDocuments;
    postings = nextPostings;
    savedSearches = nextSaved;
    recentSearches = data.recentSearches.map((entry) => ({ ...entry }));
    writeThrough();
  }

  const store = {
    addDocument,
    removeDocument,
    updateDocument,
    getDocument,
    documentCount,
    search,
    saveSearch,
    listSavedSearches,
    deleteSavedSearch,
    getRecentSearches,
    clearRecentSearches,
    snapshot,
    restore,
    get storageKey() {
      return storageKey;
    },
  };

  // Hydrate from injected storage when a snapshot is already persisted.
  let hydrated;
  try {
    hydrated = storage.get(storageKey);
  } catch (err) {
    throw searchError(
      'MS_STORAGE_ERROR',
      `Storage read failed for key ${storageKey}: ${err.message}`,
      { storageKey },
    );
  }
  if (hydrated !== undefined && hydrated !== null) {
    restore(hydrated);
  }

  return store;
}
