/**
 * dlq-store.mjs — Pure dead-letter queue store for failed work.
 *
 * A dead-letter queue holds work items that failed elsewhere so they can be
 * inspected, replayed, discarded, or redriven later. Nothing here touches the
 * network, the DOM, or any secret — it is a pure state machine with
 * persistence behind an injected `storage` dependency.
 *
 * Entry shape:
 *   { id, payload, reason, source, enqueuedAt, attempts,
 *     state: 'queued' | 'replaying' | 'discarded' | 'done',
 *     updatedAt, discardedBy?, discardedAt?, note?, lastError? }
 *
 * Dependency injection (all via the `deps` parameter of createDlqStore):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (entry id generator; default: per-store counter)
 *   - storage: { load(): string | null, save(serialized: string): void }
 *              (default: in-memory). The store hydrates from storage.load() on
 *              construction and persists after every mutation.
 *
 * Subscriber events: { type, at, entry } where type is one of
 *   'enqueued' | 'replay-started' | 'replay-succeeded' | 'replay-failed' | 'discarded'.
 * A throwing subscriber never breaks the store (its exception is isolated).
 *
 * Snapshot format: a JSON string of { version, exportedAt, entries }.
 * restore() replaces the store contents; anything that is not well-formed
 * JSON, has the wrong schema version, or contains a malformed entry throws
 * DLQ_CORRUPT_SNAPSHOT — corruption is never silently accepted.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   DLQ_NOT_FOUND        — unknown entry id
 *   DLQ_INVALID_ENTRY    — enqueue argument failed validation
 *   DLQ_INVALID_HANDLER  — replay/replayAll handler is not a function
 *   DLQ_INVALID_STATE    — operation not allowed from the entry's state, or an
 *                          unknown state filter/purge target
 *   DLQ_INVALID_SUBSCRIBER — subscribe() argument is not a function
 *   DLQ_CORRUPT_SNAPSHOT — snapshot failed to parse, wrong schema version, or
 *                          malformed entry (on restore or on load from storage)
 * Failures are never silent: a failed replay puts the entry back in `queued`,
 * bumps attempts, and records lastError instead of dropping the failure.
 */

export const ENTRY_STATES = Object.freeze(['queued', 'replaying', 'discarded', 'done']);

export const SNAPSHOT_SCHEMA_VERSION = 1;

const REPLAYABLE_STATES = new Set(['queued']);
const DISCARDABLE_STATES = new Set(['queued', 'replaying']);

/** Throw a coded DLQ error (never silent failures). */
function dlqError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read-only frozen copy of an entry record. */
function snapshotEntry(entry) {
  return Object.freeze({ ...entry });
}

/**
 * Validate a plain entry object (used on restore / storage hydration).
 * Throws DLQ_CORRUPT_SNAPSHOT on anything malformed.
 */
function validateEntryShape(entry, index) {
  const where = `entries[${index}]`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where} is not an object`, {
      index,
    });
  }
  if (!isNonEmptyString(entry.id)) {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where}.id is not a string`, {
      index,
    });
  }
  if (entry.payload === undefined) {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where}.payload is missing`, {
      index,
    });
  }
  if (!isNonEmptyString(entry.reason) || !isNonEmptyString(entry.source)) {
    throw dlqError(
      'DLQ_CORRUPT_SNAPSHOT',
      `Corrupt snapshot: ${where}.reason/source must be non-empty strings`,
      { index },
    );
  }
  if (!ENTRY_STATES.includes(entry.state)) {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where}.state is unknown`, {
      index,
      state: entry.state,
    });
  }
  if (typeof entry.enqueuedAt !== 'number' || typeof entry.updatedAt !== 'number') {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where} has bad timestamps`, {
      index,
    });
  }
  if (!Number.isInteger(entry.attempts) || entry.attempts < 0) {
    throw dlqError('DLQ_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${where}.attempts is invalid`, {
      index,
    });
  }
}

/**
 * Create a new dead-letter queue store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ load(): (string|null), save(serialized: string): void }} [deps.storage]
 */
export function createDlqStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage =
    deps.storage ??
    (() => {
      let buf = null;
      return {
        load: () => buf,
        save: (serialized) => {
          buf = serialized;
        },
      };
    })();

  let idCounter = 0;
  const newId = deps.id ?? (() => `dlq-${(idCounter += 1)}`);

  /** Internal entry records, keyed by id. */
  const entries = new Map();

  /** Subscriber callbacks for queue events. */
  const subscribers = new Set();

  function serialize() {
    return JSON.stringify({
      version: SNAPSHOT_SCHEMA_VERSION,
      exportedAt: clock(),
      entries: [...entries.values()],
    });
  }

  /** Persist the whole store to the injected storage. */
  function persist() {
    storage.save(serialize());
  }

  function notify(type, entry) {
    const event = Object.freeze({ type, at: clock(), entry: snapshotEntry(entry) });
    for (const fn of subscribers) {
      try {
        fn(event);
      } catch {
        // A bad subscriber must never break the queue; the queue's own
        // failures always surface through the coded-error contract instead.
      }
    }
  }

  function getEntryOrThrow(id) {
    const entry = entries.get(id);
    if (!entry) {
      throw dlqError('DLQ_NOT_FOUND', `Unknown DLQ entry id: ${id}`, { entryId: id });
    }
    return entry;
  }

  function assertHandler(handler, op) {
    if (typeof handler !== 'function') {
      throw dlqError('DLQ_INVALID_HANDLER', `${op} requires a function handler`, { op });
    }
  }

  function assertKnownState(state, op) {
    if (!ENTRY_STATES.includes(state)) {
      throw dlqError('DLQ_INVALID_STATE', `Unknown state '${state}' in ${op}`, { state, op });
    }
  }

  /** Parse and validate a snapshot string; throws DLQ_CORRUPT_SNAPSHOT. */
  function parseSnapshot(serialized) {
    let parsed;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw dlqError('DLQ_CORRUPT_SNAPSHOT', 'Snapshot is not valid JSON', {});
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw dlqError('DLQ_CORRUPT_SNAPSHOT', 'Snapshot root must be an object', {});
    }
    if (parsed.version !== SNAPSHOT_SCHEMA_VERSION) {
      throw dlqError(
        'DLQ_CORRUPT_SNAPSHOT',
        `Unsupported snapshot schema version: ${parsed.version} (expected ${SNAPSHOT_SCHEMA_VERSION})`,
        { version: parsed.version, expected: SNAPSHOT_SCHEMA_VERSION },
      );
    }
    if (!Array.isArray(parsed.entries)) {
      throw dlqError('DLQ_CORRUPT_SNAPSHOT', 'Snapshot entries must be an array', {});
    }
    parsed.entries.forEach(validateEntryShape);
    return parsed.entries;
  }

  /** Seed the store from a validated entry list (replace, not merge). */
  function seed(validatedEntries) {
    entries.clear();
    for (const raw of validatedEntries) {
      entries.set(raw.id, { ...raw });
    }
    // Keep default ids from colliding with restored ones.
    for (const id of entries.keys()) {
      const match = /^dlq-(\d+)$/.exec(id);
      if (match) idCounter = Math.max(idCounter, Number(match[1]));
    }
    persist();
  }

  // Hydrate from injected storage on construction. A corrupt store is a loud
  // failure, never a silently empty queue.
  {
    const existing = storage.load();
    if (existing !== null && existing !== undefined) {
      seed(parseSnapshot(existing));
    }
  }

  const store = {
    /**
     * Enqueue a failed work item. Validates payload/reason/source.
     * Returns a frozen entry snapshot in state 'queued'.
     */
    enqueue({ payload, reason, source } = {}) {
      if (payload === undefined) {
        throw dlqError('DLQ_INVALID_ENTRY', 'enqueue requires a payload', {});
      }
      if (!isNonEmptyString(reason)) {
        throw dlqError('DLQ_INVALID_ENTRY', 'enqueue requires a non-empty reason string', {
          reason,
        });
      }
      if (!isNonEmptyString(source)) {
        throw dlqError('DLQ_INVALID_ENTRY', 'enqueue requires a non-empty source string', {
          source,
        });
      }
      const now = clock();
      const entry = {
        id: newId(),
        payload,
        reason: reason.trim(),
        source: source.trim(),
        enqueuedAt: now,
        updatedAt: now,
        attempts: 0,
        state: 'queued',
      };
      entries.set(entry.id, entry);
      persist();
      notify('enqueued', entry);
      return snapshotEntry(entry);
    },

    /**
     * Replay one entry through `handler(entry)`.
     * Entry goes queued → replaying; handler success → done; handler throw →
     * back to queued with attempts++ and lastError recorded (never silent,
     * never rethrown — redrive-all style redelivery depends on this).
     */
    replay(entryId, handler) {
      assertHandler(handler, 'replay');
      const entry = getEntryOrThrow(entryId);
      if (!REPLAYABLE_STATES.has(entry.state)) {
        throw dlqError(
          'DLQ_INVALID_STATE',
          `Cannot replay entry ${entryId} from state '${entry.state}'`,
          { entryId, state: entry.state },
        );
      }
      entry.state = 'replaying';
      entry.updatedAt = clock();
      notify('replay-started', entry);
      try {
        handler(snapshotEntry(entry));
      } catch (err) {
        entry.state = 'queued';
        entry.attempts += 1;
        entry.lastError = err instanceof Error ? err.message : String(err);
        entry.updatedAt = clock();
        persist();
        notify('replay-failed', entry);
        return snapshotEntry(entry);
      }
      entry.state = 'done';
      delete entry.lastError;
      entry.updatedAt = clock();
      persist();
      notify('replay-succeeded', entry);
      return snapshotEntry(entry);
    },

    /**
     * Discard an entry (queued or replaying only), recording who and why.
     */
    discard(entryId, by, note) {
      const entry = getEntryOrThrow(entryId);
      if (!DISCARDABLE_STATES.has(entry.state)) {
        throw dlqError(
          'DLQ_INVALID_STATE',
          `Cannot discard entry ${entryId} from state '${entry.state}'`,
          { entryId, state: entry.state },
        );
      }
      if (!isNonEmptyString(by)) {
        throw dlqError('DLQ_INVALID_ENTRY', 'discard requires a non-empty `by` string', { by });
      }
      entry.state = 'discarded';
      entry.discardedBy = by.trim();
      entry.discardedAt = clock();
      if (note !== undefined) entry.note = note;
      entry.updatedAt = clock();
      persist();
      notify('discarded', entry);
      return snapshotEntry(entry);
    },

    /**
     * List entries, optionally filtered by { state, source }. Unknown state
     * filters throw DLQ_INVALID_STATE.
     */
    list({ state, source } = {}) {
      if (state !== undefined) assertKnownState(state, 'list filter');
      return [...entries.values()]
        .filter((entry) => (state === undefined || entry.state === state) && (source === undefined || entry.source === source))
        .map(snapshotEntry);
    },

    /** Read-only snapshot of one entry (null if unknown). */
    get(entryId) {
      const entry = entries.get(entryId);
      return entry ? snapshotEntry(entry) : null;
    },

    /** Counts per state plus the oldest queued entry's enqueuedAt (null if none). */
    stats() {
      const result = { queued: 0, replaying: 0, discarded: 0, done: 0, oldestQueuedAt: null };
      for (const entry of entries.values()) {
        result[entry.state] += 1;
        if (
          entry.state === 'queued' &&
          (result.oldestQueuedAt === null || entry.enqueuedAt < result.oldestQueuedAt)
        ) {
          result.oldestQueuedAt = entry.enqueuedAt;
        }
      }
      return Object.freeze(result);
    },

    /**
     * Remove entries in `state` whose updatedAt is older than `olderThanMs`.
     * Returns the number removed.
     */
    purge(state = 'done', olderThanMs = 0) {
      assertKnownState(state, 'purge');
      if (typeof olderThanMs !== 'number' || olderThanMs < 0 || Number.isNaN(olderThanMs)) {
        throw dlqError('DLQ_INVALID_ENTRY', 'purge requires a non-negative olderThanMs', {
          olderThanMs,
        });
      }
      const cutoff = clock() - olderThanMs;
      let removed = 0;
      for (const [id, entry] of entries) {
        if (entry.state === state && entry.updatedAt < cutoff) {
          entries.delete(id);
          removed += 1;
        }
      }
      if (removed > 0) persist();
      return removed;
    },

    /**
     * Replay every queued entry through `handler`, up to `limit` entries.
     * Individual failures are recorded on the entries (queued + attempts++);
     * this never throws for handler failures. Returns { done, failed }.
     */
    replayAll(handler, { limit } = {}) {
      assertHandler(handler, 'replayAll');
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
        throw dlqError('DLQ_INVALID_ENTRY', 'replayAll limit must be a non-negative integer', {
          limit,
        });
      }
      const queued = this.list({ state: 'queued' }).slice(
        0,
        limit === undefined ? undefined : limit,
      );
      let done = 0;
      let failed = 0;
      for (const entry of queued) {
        const before = this.get(entry.id);
        const after = this.replay(entry.id, handler);
        if (after.state === 'done' && before.state !== 'done') done += 1;
        else if (after.attempts > before.attempts) failed += 1;
      }
      return Object.freeze({ done, failed });
    },

    /** Subscribe to queue events. Returns an unsubscribe function. */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw dlqError('DLQ_INVALID_SUBSCRIBER', 'subscribe requires a function', {});
      }
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /** Export the whole store as a versioned JSON string. */
    snapshot() {
      return serialize();
    },

    /**
     * Replace the store contents from a snapshot string. Throws
     * DLQ_CORRUPT_SNAPSHOT on parse errors, wrong schema version, or
     * malformed entries — corruption is never silently accepted.
     */
    restore(serialized) {
      const validated = parseSnapshot(serialized);
      seed(validated);
      return this.stats();
    },
  };

  return Object.freeze(store);
}
