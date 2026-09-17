/**
 * mailbox-search-store.test.js — tests for the mailbox full-text search store.
 *
 * Covers: term ranking with field weights, phrase search, field filters,
 * pagination, add/remove/update re-indexing, saved-search CRUD, recent-history
 * cap, snapshot/restore, corrupt snapshot rejection, empty query rejection,
 * and the coded-error contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMailboxSearchStore,
  SCHEMA,
  SNAPSHOT_VERSION,
  DEFAULT_HISTORY_CAP,
  FIELD_WEIGHTS,
  PHRASE_BONUS,
} from '../src/mailbox-search-store.mjs';

/** In-memory storage fake matching the { get, set } dep interface. */
function fakeStorage() {
  const map = new Map();
  return {
    get: (key) => (map.has(key) ? map.get(key) : undefined),
    set: (key, value) => {
      map.set(key, value);
    },
    raw: map,
  };
}

/** Controllable clock. */
function fakeClock(start = 1_000_000) {
  const box = { now: start };
  return {
    clock: () => box.now,
    advance: (ms) => {
      box.now += ms;
    },
  };
}

function makeStore(overrides = {}) {
  const storage = fakeStorage();
  const clock = fakeClock();
  let seq = 0;
  const store = createMailboxSearchStore({
    storage,
    clock: clock.clock,
    id: () => `doc-${(seq += 1)}`,
    ...overrides,
  });
  return { store, storage, clock };
}

function message(partial = {}) {
  return {
    from: 'john@trydemigod.com',
    to: 'chris@alphacompute.ai',
    subject: 'Alpha Compute intro',
    body: 'Hi Chris, sharing a quick update on the hiring search.',
    channel: 'gmail',
    ts: 1_000_000,
    ...partial,
  };
}

function expectSearchError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, 'expected an Error');
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    return true;
  });
}

describe('mailbox-search-store', () => {
  describe('indexing basics', () => {
    it('adds a document, assigns an id when omitted, and counts it', () => {
      const { store } = makeStore();
      const added = store.addDocument(message());
      assert.equal(added.id, 'doc-1');
      assert.equal(store.documentCount(), 1);
      assert.equal(store.getDocument('doc-1').subject, 'Alpha Compute intro');
    });

    it('uses explicit ids and rejects duplicates with MS_DUPLICATE_ID', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'm1' }));
      expectSearchError(() => store.addDocument(message({ id: 'm1' })), 'MS_DUPLICATE_ID');
      assert.equal(store.documentCount(), 1);
    });

    it('rejects invalid documents with MS_INVALID_DOCUMENT', () => {
      const { store } = makeStore();
      expectSearchError(() => store.addDocument(message({ subject: '' })), 'MS_INVALID_DOCUMENT');
      expectSearchError(() => store.addDocument(message({ from: 42 })), 'MS_INVALID_DOCUMENT');
      expectSearchError(() => store.addDocument(null), 'MS_INVALID_DOCUMENT');
    });

    it('throws MS_NOT_FOUND for unknown ids', () => {
      const { store } = makeStore();
      expectSearchError(() => store.getDocument('nope'), 'MS_NOT_FOUND');
      expectSearchError(() => store.removeDocument('nope'), 'MS_NOT_FOUND');
      expectSearchError(() => store.updateDocument('nope', { subject: 'x' }), 'MS_NOT_FOUND');
    });
  });

  describe('term search ranking', () => {
    it('subject weight beats body weight', () => {
      const { store } = makeStore();
      store.addDocument(
        message({ id: 'body-only', subject: 'Unrelated hello', body: 'budget alpha budget alpha' }),
      );
      store.addDocument(
        message({ id: 'subject-hit', subject: 'Q4 budget review', body: 'unrelated words here' }),
      );
      const { results } = store.search('budget');
      assert.equal(results.length, 2);
      assert.equal(results[0].id, 'subject-hit');
      assert.ok(results[0].score > results[1].score);
      // 1 subject hit x3 = 3 vs 2 body hits x1 = 2
      assert.equal(results[0].score, FIELD_WEIGHTS.subject * 1);
      assert.equal(results[1].score, FIELD_WEIGHTS.body * 2);
    });

    it('is case-insensitive, drops stopwords, and ANDs terms', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'a', subject: 'Budget review', body: 'alpha gamma' }));
      store.addDocument(message({ id: 'b', subject: 'Budget review', body: 'alpha only' }));
      const one = store.search('BUDGET');
      assert.equal(one.total, 2);
      const and = store.search('budget gamma');
      assert.equal(and.total, 1);
      assert.equal(and.results[0].id, 'a');
      const stop = store.search('the budget');
      assert.equal(stop.total, 2);
    });

    it('breaks score ties with ts, newest first', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'old', subject: 'budget', ts: 100 }));
      store.addDocument(message({ id: 'new', subject: 'budget', ts: 200 }));
      const { results } = store.search('budget');
      assert.equal(results[0].id, 'new');
      assert.equal(results[1].id, 'old');
    });

    it('returns empty results for unknown terms', () => {
      const { store } = makeStore();
      store.addDocument(message());
      const { total, results } = store.search('zxyqwv');
      assert.equal(total, 0);
      assert.deepEqual(results, []);
    });
  });

  describe('phrase search', () => {
    it('matches exact substrings only', () => {
      const { store } = makeStore();
      store.addDocument(
        message({ id: 'p1', subject: 'hello', body: 'the quick brown fox jumps' }),
      );
      store.addDocument(
        message({ id: 'p2', subject: 'hello', body: 'quick red fox naps' }),
      );
      const { results } = store.search('"quick brown fox"');
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'p1');
    });

    it('adds PHRASE_BONUS to the score', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'p', subject: 'budget review meeting', body: 'x' }));
      const { results } = store.search('"budget review"');
      assert.ok(results[0].score >= PHRASE_BONUS);
    });

    it('combines phrases with terms', () => {
      const { store } = makeStore();
      store.addDocument(
        message({ id: 'p1', subject: 'budget', body: 'the quick brown fox' }),
      );
      store.addDocument(
        message({ id: 'p2', subject: 'nomatch', body: 'the quick brown fox' }),
      );
      const { results } = store.search('budget "quick brown fox"');
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'p1');
    });
  });

  describe('field filters', () => {
    it('filters by channel: and from:', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'g', subject: 'budget', channel: 'gmail', from: 'john@trydemigod.com' }));
      store.addDocument(message({ id: 't', subject: 'budget', channel: 'telegram', from: 'sam@example.com' }));
      const byChannel = store.search('budget channel:telegram');
      assert.equal(byChannel.total, 1);
      assert.equal(byChannel.results[0].id, 't');
      const byFrom = store.search('budget from:sam');
      assert.equal(byFrom.total, 1);
      assert.equal(byFrom.results[0].id, 't');
    });

    it('filter-only queries work without terms', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'g', channel: 'gmail' }));
      store.addDocument(message({ id: 't', channel: 'telegram' }));
      const { results } = store.search('channel:gmail');
      assert.equal(results.length, 1);
      assert.equal(results[0].id, 'g');
    });

    it('filters are ANDed and can exclude everything', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'g', channel: 'gmail' }));
      const { total } = store.search('channel:slack');
      assert.equal(total, 0);
    });
  });

  describe('pagination', () => {
    it('honors limit and offset', () => {
      const { store } = makeStore();
      for (let i = 0; i < 5; i += 1) {
        store.addDocument(message({ subject: 'budget notes', ts: 100 + i }));
      }
      const page1 = store.search('budget', { limit: 2, offset: 0 });
      assert.equal(page1.total, 5);
      assert.equal(page1.results.length, 2);
      const page2 = store.search('budget', { limit: 2, offset: 2 });
      assert.equal(page2.results.length, 2);
      assert.notDeepEqual(
        page1.results.map((r) => r.id),
        page2.results.map((r) => r.id),
      );
      const tail = store.search('budget', { limit: 2, offset: 4 });
      assert.equal(tail.results.length, 1);
    });

    it('rejects invalid pagination with MS_INVALID_PAGINATION', () => {
      const { store } = makeStore();
      store.addDocument(message());
      expectSearchError(() => store.search('budget', { limit: -1 }), 'MS_INVALID_PAGINATION');
      expectSearchError(() => store.search('budget', { offset: 1.5 }), 'MS_INVALID_PAGINATION');
    });

    it('rejects empty queries with MS_INVALID_QUERY', () => {
      const { store } = makeStore();
      expectSearchError(() => store.search(''), 'MS_INVALID_QUERY');
      expectSearchError(() => store.search('   '), 'MS_INVALID_QUERY');
      expectSearchError(() => store.search('"   "'), 'MS_INVALID_QUERY');
      expectSearchError(() => store.search('the and'), 'MS_INVALID_QUERY');
      expectSearchError(() => store.search(42), 'MS_INVALID_QUERY');
    });
  });

  describe('index maintenance', () => {
    it('removeDocument drops the document from results', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'm1', subject: 'budget alpha' }));
      store.addDocument(message({ id: 'm2', subject: 'budget beta' }));
      store.removeDocument('m1');
      const { results } = store.search('budget');
      assert.deepEqual(results.map((r) => r.id), ['m2']);
      assert.equal(store.documentCount(), 1);
    });

    it('updateDocument re-indexes (old terms gone, new terms live)', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'm1', subject: 'budget alpha' }));
      store.updateDocument('m1', { subject: 'payroll gamma' });
      assert.equal(store.search('budget').total, 0);
      const after = store.search('payroll');
      assert.equal(after.total, 1);
      assert.equal(after.results[0].id, 'm1');
      assert.equal(store.getDocument('m1').subject, 'payroll gamma');
    });

    it('updateDocument validates the merged record', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'm1' }));
      expectSearchError(() => store.updateDocument('m1', { subject: '' }), 'MS_INVALID_DOCUMENT');
      expectSearchError(() => store.updateDocument('m1', null), 'MS_INVALID_DOCUMENT');
    });
  });

  describe('saved searches', () => {
    it('saves, lists, and deletes named queries', () => {
      const { store } = makeStore();
      const saved = store.saveSearch('weekly budget', 'budget channel:gmail');
      assert.equal(saved.name, 'weekly budget');
      assert.equal(saved.query, 'budget channel:gmail');
      const list = store.listSavedSearches();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'weekly budget');
      const deleted = store.deleteSavedSearch('weekly budget');
      assert.equal(deleted.name, 'weekly budget');
      assert.equal(store.listSavedSearches().length, 0);
    });

    it('rejects duplicate names and unknown deletes', () => {
      const { store } = makeStore();
      store.saveSearch('q', 'budget');
      expectSearchError(() => store.saveSearch('q', 'budget'), 'MS_SAVED_EXISTS');
      expectSearchError(() => store.deleteSavedSearch('nope'), 'MS_SAVED_NOT_FOUND');
      expectSearchError(() => store.saveSearch('', 'budget'), 'MS_INVALID_QUERY');
      expectSearchError(() => store.saveSearch('q2', '  '), 'MS_INVALID_QUERY');
    });
  });

  describe('recent search history', () => {
    it('records searches newest-first, deduped, capped at historyCap', () => {
      const { store } = makeStore();
      store.addDocument(message({ subject: 'budget alpha beta gamma' }));
      store.search('alpha');
      store.search('beta');
      store.search('alpha'); // duplicate moves to front
      const recent = store.getRecentSearches();
      assert.equal(recent.length, 2);
      assert.equal(recent[0].query, 'alpha');
      assert.equal(recent[1].query, 'beta');
    });

    it('caps history at the injected historyCap', () => {
      const store = createMailboxSearchStore({ storage: fakeStorage(), historyCap: 3 });
      store.addDocument(message({ subject: 'alpha beta gamma delta' }));
      for (const q of ['alpha', 'beta', 'gamma', 'delta']) store.search(q);
      const recent = store.getRecentSearches();
      assert.equal(recent.length, 3);
      assert.deepEqual(recent.map((r) => r.query), ['delta', 'gamma', 'beta']);
    });

    it('defaults to a cap of DEFAULT_HISTORY_CAP', () => {
      const store = createMailboxSearchStore({ storage: fakeStorage() });
      store.addDocument(message({ subject: 'zebra' }));
      for (let i = 0; i < DEFAULT_HISTORY_CAP + 5; i += 1) {
        store.search(`zebra query${i}`);
      }
      assert.equal(store.getRecentSearches().length, DEFAULT_HISTORY_CAP);
    });

    it('clearRecentSearches empties the history', () => {
      const { store } = makeStore();
      store.addDocument(message());
      store.search('budget');
      store.clearRecentSearches();
      assert.deepEqual(store.getRecentSearches(), []);
    });
  });

  describe('snapshot / restore', () => {
    it('round-trips full state through snapshot and restore', () => {
      const { store } = makeStore();
      store.addDocument(message({ id: 'm1', subject: 'budget alpha' }));
      store.saveSearch('q', 'budget');
      store.search('budget');
      const snap = store.snapshot();
      assert.equal(snap.schema, SCHEMA);
      assert.equal(snap.version, SNAPSHOT_VERSION);

      const other = makeStore().store;
      other.restore(snap);
      assert.equal(other.documentCount(), 1);
      assert.equal(other.search('budget').total, 1);
      assert.equal(other.listSavedSearches().length, 1);
      assert.equal(other.getRecentSearches().length, 1);
      assert.equal(other.getDocument('m1').subject, 'budget alpha');
    });

    it('rejects corrupt snapshots with MS_CORRUPT_SNAPSHOT', () => {
      const { store } = makeStore();
      expectSearchError(() => store.restore(null), 'MS_CORRUPT_SNAPSHOT');
      expectSearchError(() => store.restore({}), 'MS_CORRUPT_SNAPSHOT');
      expectSearchError(
        () => store.restore({ schema: 'other', version: 1, data: {} }),
        'MS_CORRUPT_SNAPSHOT',
      );
      expectSearchError(
        () => store.restore({ schema: SCHEMA, version: 999, data: {} }),
        'MS_CORRUPT_SNAPSHOT',
      );
      const snap = store.snapshot();
      const bad = structuredClone(snap);
      delete bad.data.index;
      expectSearchError(() => store.restore(bad), 'MS_CORRUPT_SNAPSHOT');
    });

    it('hydrates from injected storage on creation and rejects corruption', () => {
      const storage = fakeStorage();
      const first = createMailboxSearchStore({ storage });
      first.addDocument(message({ id: 'm1', subject: 'budget alpha' }));
      const second = createMailboxSearchStore({ storage });
      assert.equal(second.documentCount(), 1);
      assert.equal(second.search('budget').total, 1);

      storage.set('mailbox-search:v1', { schema: 'junk', version: 1, data: {} });
      expectSearchError(
        () => createMailboxSearchStore({ storage }),
        'MS_CORRUPT_SNAPSHOT',
      );
    });

    it('writes through to storage on mutation', () => {
      const { storage, store } = makeStore();
      assert.equal(storage.raw.has('mailbox-search:v1'), false);
      store.addDocument(message({ id: 'm1' }));
      assert.equal(storage.raw.has('mailbox-search:v1'), true);
    });
  });

  describe('coded-error contract', () => {
    it('every failure carries a code property', () => {
      const { store } = makeStore();
      const cases = [
        () => store.getDocument('x'),
        () => store.addDocument(message({ subject: '' })),
        () => store.search(''),
        () => store.search('budget', { limit: -1 }),
        () => store.deleteSavedSearch('x'),
        () => store.restore({}),
      ];
      for (const fn of cases) {
        assert.throws(fn, (err) => {
          assert.ok(typeof err.code === 'string' && err.code.length > 0);
          assert.ok(err.code.startsWith('MS_'), `code ${err.code} must be MS_-prefixed`);
          return true;
        });
      }
    });

    it('wraps storage failures as MS_STORAGE_ERROR', () => {
      const broken = {
        get: () => undefined,
        set: () => {
          throw new Error('disk on fire');
        },
      };
      const store = createMailboxSearchStore({ storage: broken });
      expectSearchError(() => store.addDocument(message()), 'MS_STORAGE_ERROR');
      const brokenRead = {
        get: () => {
          throw new Error('read failed');
        },
        set: () => {},
      };
      expectSearchError(
        () => createMailboxSearchStore({ storage: brokenRead }),
        'MS_STORAGE_ERROR',
      );
    });
  });

  describe('dependency injection', () => {
    it('uses injected tokenizer, clock, and id generator', () => {
      const box = { now: 5_000 };
      const store = createMailboxSearchStore({
        storage: fakeStorage(),
        clock: () => box.now,
        id: () => 'custom-id',
        tokenizer: (text) => text.toLowerCase().split(/\s+/).filter(Boolean),
      });
      const added = store.addDocument({
        from: 'john@trydemigod.com',
        to: 'chris@alphacompute.ai',
        subject: 'Budget review',
        body: 'Hi Chris, sharing a quick update.',
        channel: 'gmail',
      });
      assert.equal(added.id, 'custom-id');
      assert.equal(added.ts, 5_000);
      // With the custom tokenizer "Budget" is one token, no stopword removal.
      const { total } = store.search('budget review');
      assert.equal(total, 1);
    });
  });
});
