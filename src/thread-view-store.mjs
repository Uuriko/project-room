/**
 * thread-view-store.mjs — Pure per-thread view-state store for the inbox.
 *
 * Tracks the UI view state of each inbox thread: expanded/collapsed,
 * per-thread scroll anchor (message id), per-thread selected message,
 * per-thread draft text (unsent composer state), per-thread muted flag,
 * and the "seen up to" marker (message id).
 *
 * Nothing here touches the network, the DOM, or any secret — it is a pure
 * in-memory store. Persistence happens only through the injected `storage`
 * dep (write-through on every mutation), so swapping localStorage for
 * anything else is a one-line wiring change.
 *
 * Dependency injection (all via the `deps` parameter of createThreadViewStore):
 *   - clock:      () => number                  (ms epoch; default: Date.now)
 *   - id:         () => string                  (change-event id generator; default: counter)
 *   - storage:    { get(key), set(key, value) }  (default: in-memory stub)
 *   - storageKey: string                        (default: 'thread-view:v1')
 *   - onChange:   function | function[]         (initial change subscribers)
 *
 * A thread view record:
 *   {
 *     threadId,           // string — key
 *     expanded,           // boolean — thread expanded in the list (default false)
 *     scrollAnchor,       // string | null — message id to scroll to
 *     selectedMessageId,  // string | null — currently selected message
 *     draftText,          // string — unsent composer text for this thread
 *     muted,              // boolean — notifications muted for this thread
 *     seenUpTo,           // string | null — last seen message id
 *     updatedAt,          // number — ms epoch of last mutation
 *   }
 *
 * Schema versioning:
 *   - SCHEMA_VERSION is the current snapshot version.
 *   - restore() validates the version: newer versions throw TV_VERSION_CONFLICT.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TV_NOT_FOUND        — operation on a thread with no view record (resetThreadView)
 *   TV_INVALID_ARG      — bad argument (bad thread id, bad patch field, bad subscriber, …)
 *   TV_VERSION_CONFLICT — snapshot version newer than SCHEMA_VERSION
 *   TV_CORRUPT_SNAPSHOT — snapshot fails shape validation
 *   TV_STORAGE_ERROR    — the injected storage threw (wrapped, never silent)
 * Failures are never silent.
 */

export const SCHEMA_VERSION = 1;

export const DEFAULT_STORAGE_KEY = 'thread-view:v1';

/** Throw a coded store error (never silent failures). */
function storeError(code, message, detail) {
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

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a thread id before it touches the store. */
function assertThreadId(threadId) {
  if (typeof threadId !== 'string' || threadId === '') {
    throw storeError('TV_INVALID_ARG', 'Thread id must be a non-empty string', {
      threadId,
    });
  }
}

/** Validate a message id (scroll anchors, selected message, seen-up-to). */
function assertMessageId(messageId, field) {
  if (messageId !== null && (typeof messageId !== 'string' || messageId === '')) {
    throw storeError('TV_INVALID_ARG', `View field '${field}' must be a non-empty string or null`, {
      [field]: messageId,
    });
  }
}

/** Validate the optional partial-view patch accepted by setViewState. */
function assertViewPatch(patch) {
  if (!isPlainObject(patch)) {
    throw storeError('TV_INVALID_ARG', 'View patch must be a plain object', {
      patch,
    });
  }
  for (const flag of ['expanded', 'muted']) {
    if (patch[flag] !== undefined && typeof patch[flag] !== 'boolean') {
      throw storeError('TV_INVALID_ARG', `View field '${flag}' must be a boolean`, {
        [flag]: patch[flag],
      });
    }
  }
  for (const anchor of ['scrollAnchor', 'selectedMessageId', 'seenUpTo']) {
    if (patch[anchor] !== undefined) assertMessageId(patch[anchor], anchor);
  }
  if (patch.draftText !== undefined && typeof patch.draftText !== 'string') {
    throw storeError('TV_INVALID_ARG', "View field 'draftText' must be a string", {
      draftText: patch.draftText,
    });
  }
  const known = new Set([
    'expanded',
    'scrollAnchor',
    'selectedMessageId',
    'draftText',
    'muted',
    'seenUpTo',
  ]);
  for (const key of Object.keys(patch)) {
    if (!known.has(key)) {
      throw storeError('TV_INVALID_ARG', `Unknown view field '${key}'`, { key });
    }
  }
}

/** Canonical thread-view record (mutable internal copy). */
function defaultRecord(threadId, at) {
  return {
    threadId,
    expanded: false,
    scrollAnchor: null,
    selectedMessageId: null,
    draftText: '',
    muted: false,
    seenUpTo: null,
    updatedAt: at,
  };
}

/** Deep-validate one restored view record before it replaces store state. */
function assertRestoredRecord(record) {
  if (!isPlainObject(record)) {
    throw storeError('TV_CORRUPT_SNAPSHOT', 'Snapshot contains a non-object view record', {});
  }
  try {
    assertThreadId(record.threadId);
  } catch (err) {
    throw storeError('TV_CORRUPT_SNAPSHOT', `Corrupt view record: ${err.message}`, {
      threadId: record.threadId,
    });
  }
  for (const flag of ['expanded', 'muted']) {
    if (typeof record[flag] !== 'boolean') {
      throw storeError('TV_CORRUPT_SNAPSHOT', `View record has non-boolean '${flag}'`, {
        threadId: record.threadId,
      });
    }
  }
  for (const anchor of ['scrollAnchor', 'selectedMessageId', 'seenUpTo']) {
    try {
      assertMessageId(record[anchor], anchor);
    } catch (err) {
      throw storeError('TV_CORRUPT_SNAPSHOT', `Corrupt view record: ${err.message}`, {
        threadId: record.threadId,
        [anchor]: record[anchor],
      });
    }
  }
  if (typeof record.draftText !== 'string') {
    throw storeError('TV_CORRUPT_SNAPSHOT', "View record has non-string 'draftText'", {
      threadId: record.threadId,
    });
  }
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
    throw storeError('TV_CORRUPT_SNAPSHOT', 'View record has a non-finite updatedAt', {
      threadId: record.threadId,
    });
  }
}

/**
 * Create a new thread view store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ get(string): any, set(string, any): void }} [deps.storage]
 * @param {string} [deps.storageKey]
 * @param {Function | Function[]} [deps.onChange]
 */
export function createThreadViewStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? memoryStorage();
  const storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;

  let idCounter = 0;
  const newEventId = deps.id ?? (() => `tve-${(idCounter += 1)}`);

  /** Internal view records, keyed by thread id. */
  const views = new Map();

  /** Change subscribers: Set of functions. */
  const subscribers = new Set();
  const initial = Array.isArray(deps.onChange)
    ? deps.onChange
    : deps.onChange
      ? [deps.onChange]
      : [];
  for (const fn of initial) {
    if (typeof fn !== 'function') {
      throw storeError('TV_INVALID_ARG', 'onChange subscribers must be functions', { fn });
    }
    subscribers.add(fn);
  }

  function emit(event) {
    const full = Object.freeze({ id: newEventId(), at: clock(), ...event });
    for (const fn of [...subscribers]) {
      fn(full);
    }
  }

  /** Write-through: persist the full snapshot on every mutation. */
  function persist() {
    const state = {
      version: SCHEMA_VERSION,
      threads: [...views.values()].map((v) => ({ ...v })),
    };
    try {
      storage.set(storageKey, state);
    } catch (err) {
      throw storeError(
        'TV_STORAGE_ERROR',
        `Storage write failed for key ${storageKey}: ${err.message}`,
        { storageKey, cause: err },
      );
    }
  }

  function viewSnapshot(view) {
    return Object.freeze({ ...view });
  }

  function getOrCreate(threadId) {
    let view = views.get(threadId);
    if (!view) {
      view = defaultRecord(threadId, clock());
      views.set(threadId, view);
    }
    return view;
  }

  /** Apply a validated patch to a record, returning whether anything changed. */
  function applyPatch(view, patch) {
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (view[key] !== value) {
        view[key] = value;
        changed = true;
      }
    }
    if (changed) view.updatedAt = clock();
    return changed;
  }

  const store = {
    get storageKey() {
      return storageKey;
    },

    get size() {
      return views.size;
    },

    /**
     * Create or update the view state for a thread. Returns a frozen record.
     * Unknown threads start from the default record; records never share
     * references between threads.
     */
    setViewState(threadId, patch = {}) {
      assertThreadId(threadId);
      assertViewPatch(patch);
      const existed = views.has(threadId);
      const view = getOrCreate(threadId);
      const changed = applyPatch(view, patch);
      if (existed && !changed) return viewSnapshot(view); // no-op: no write, no event
      persist();
      emit({ type: existed ? 'view-updated' : 'view-created', threadId });
      return viewSnapshot(view);
    },

    /** Read-only view record for a thread (null if none — no throw). */
    getViewState(threadId) {
      assertThreadId(threadId);
      const view = views.get(threadId);
      return view ? viewSnapshot(view) : null;
    },

    /**
     * Replace the unsent composer draft text for a thread. Returns a frozen
     * record.
     */
    updateDraft(threadId, text) {
      assertThreadId(threadId);
      if (typeof text !== 'string') {
        throw storeError('TV_INVALID_ARG', 'Draft text must be a string', { text });
      }
      const view = getOrCreate(threadId);
      view.draftText = text;
      view.updatedAt = clock();
      persist();
      emit({ type: 'draft-updated', threadId });
      return viewSnapshot(view);
    },

    /** Flip the muted flag for a thread; returns the new frozen record. */
    toggleMute(threadId) {
      assertThreadId(threadId);
      const view = getOrCreate(threadId);
      view.muted = !view.muted;
      view.updatedAt = clock();
      persist();
      emit({ type: 'mute-toggled', threadId, muted: view.muted });
      return viewSnapshot(view);
    },

    /**
     * Mark a thread seen up to a message id. Returns a frozen record.
     * Passing null clears the marker.
     */
    markSeen(threadId, messageId) {
      assertThreadId(threadId);
      assertMessageId(messageId, 'seenUpTo');
      const view = getOrCreate(threadId);
      view.seenUpTo = messageId;
      view.updatedAt = clock();
      persist();
      emit({ type: 'seen-updated', threadId, seenUpTo: messageId });
      return viewSnapshot(view);
    },

    /**
     * Drop a thread's view state entirely (back to no record). Throws
     * TV_NOT_FOUND when the thread has no record — never silently a no-op.
     */
    resetThreadView(threadId) {
      assertThreadId(threadId);
      if (!views.has(threadId)) {
        throw storeError('TV_NOT_FOUND', `Unknown thread id: ${threadId}`, {
          threadId,
        });
      }
      views.delete(threadId);
      persist();
      emit({ type: 'view-reset', threadId });
    },

    /**
     * List threads with view state, sorted by thread id. Optional boolean
     * filters on `muted` and `expanded`.
     */
    listViews({ muted, expanded } = {}) {
      if (muted !== undefined && typeof muted !== 'boolean') {
        throw storeError('TV_INVALID_ARG', 'listViews filter `muted` must be a boolean', {
          muted,
        });
      }
      if (expanded !== undefined && typeof expanded !== 'boolean') {
        throw storeError('TV_INVALID_ARG', 'listViews filter `expanded` must be a boolean', {
          expanded,
        });
      }
      return [...views.values()]
        .filter((v) => muted === undefined || v.muted === muted)
        .filter((v) => expanded === undefined || v.expanded === expanded)
        .sort((a, b) => (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0))
        .map(viewSnapshot);
    },

    /** Drop ALL thread view state. Emits a single 'cleared' change event. */
    clear() {
      views.clear();
      persist();
      emit({ type: 'cleared' });
    },

    /**
     * Register a change subscriber. Returns an unsubscribe function.
     * Throws TV_INVALID_ARG for non-function subscribers.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw storeError('TV_INVALID_ARG', 'Subscriber must be a function', { fn });
      }
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    /**
     * Current state as a versioned plain-object snapshot, suitable for
     * storage or for restore() on another store.
     */
    snapshot() {
      return {
        version: SCHEMA_VERSION,
        threads: [...views.values()].map((v) => ({ ...v })),
      };
    },

    /**
     * Replace all store state from a snapshot. Validates version and shape;
     * throws TV_VERSION_CONFLICT for newer versions and TV_CORRUPT_SNAPSHOT
     * for anything malformed. Persisted and emits 'restored'.
     */
    restore(snapshot) {
      if (!isPlainObject(snapshot) || !Array.isArray(snapshot.threads)) {
        throw storeError('TV_CORRUPT_SNAPSHOT', 'Snapshot has no threads array', {
          snapshot: typeof snapshot,
        });
      }
      const version = snapshot.version ?? SCHEMA_VERSION;
      if (version > SCHEMA_VERSION) {
        throw storeError(
          'TV_VERSION_CONFLICT',
          `Snapshot version ${version} is newer than store schema ${SCHEMA_VERSION}`,
          { version, schemaVersion: SCHEMA_VERSION },
        );
      }
      if (version !== SCHEMA_VERSION) {
        throw storeError('TV_CORRUPT_SNAPSHOT', `Unknown snapshot version: ${version}`, {
          version,
        });
      }
      const incoming = new Map();
      for (const record of snapshot.threads) {
        assertRestoredRecord(record);
        if (incoming.has(record.threadId)) {
          throw storeError(
            'TV_CORRUPT_SNAPSHOT',
            `Snapshot has duplicate view record for thread ${record.threadId}`,
            { threadId: record.threadId },
          );
        }
        incoming.set(record.threadId, { ...record });
      }
      views.clear();
      for (const [threadId, record] of incoming) views.set(threadId, record);
      persist();
      emit({ type: 'restored', threadCount: views.size });
    },
  };

  return Object.freeze(store);
}
