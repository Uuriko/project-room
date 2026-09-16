/**
 * unified-inbox-store.mjs — Pure in-memory unified inbox store + wiring.
 *
 * Holds messages across channels (email, telegram, whatsapp) behind one
 * query surface: upsert/get/list with channel/read/starred filters, ts-desc
 * sorting, cursor pagination, read/unread and star/unstar toggles, delete,
 * change events, and versioned snapshot/restore.
 *
 * Nothing here touches the network, the DOM, or any secret — it is a pure
 * store. Persistence happens only through the injected `storage` dep
 * (write-through on every mutation), so swapping localStorage for anything
 * else is a one-line wiring change.
 *
 * Dependency injection (all via the `deps` parameter of createUnifiedInboxStore):
 *   - clock:      () => number                 (ms epoch; default: Date.now)
 *   - id:         () => string                 (message id generator; default: counter)
 *   - storage:    { get(key), set(key, value) } (default: in-memory stub)
 *   - storageKey: string                       (default: 'unified-inbox:v2')
 *   - onChange:   function | function[]        (initial change subscribers)
 *
 * Schema versioning:
 *   - SCHEMA_VERSION is the current snapshot version.
 *   - migrate(snapshot) upgrades an older snapshot in place; exported so
 *     tests and wiring can verify migrations directly.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   UIS_NOT_FOUND         — unknown message id
 *   UIS_VERSION_CONFLICT  — snapshot version newer than SCHEMA_VERSION
 *   UIS_CORRUPT_SNAPSHOT  — snapshot fails shape validation
 *   UIS_INVALID_MESSAGE   — upsert payload fails validation (bad channel, ts, …)
 *   UIS_INVALID_ARG       — bad argument (unknown cursor, bad subscriber, …)
 *   UIS_STORAGE_ERROR     — the injected storage threw (wrapped, never silent)
 * Failures are never silent.
 */

export const SCHEMA_VERSION = 2;

export const CHANNELS = Object.freeze(['email', 'telegram', 'whatsapp']);

export const DEFAULT_STORAGE_KEY = 'unified-inbox:v2';

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

/** Validate a channel name. */
function assertChannel(channel) {
  if (!CHANNELS.includes(channel)) {
    throw storeError(
      'UIS_INVALID_MESSAGE',
      `Invalid channel: ${JSON.stringify(channel)} (expected one of ${CHANNELS.join(', ')})`,
      { channel },
    );
  }
}

/** Validate an upsert payload before it touches the store. */
function assertMessageInput(input) {
  if (!isPlainObject(input)) {
    throw storeError('UIS_INVALID_MESSAGE', 'Message must be a plain object', { input });
  }
  assertChannel(input.channel);
  if (typeof input.ts !== 'number' || !Number.isFinite(input.ts)) {
    throw storeError('UIS_INVALID_MESSAGE', 'Message ts must be a finite number', {
      ts: input.ts,
    });
  }
  if (input.id !== undefined && (typeof input.id !== 'string' || input.id === '')) {
    throw storeError('UIS_INVALID_MESSAGE', 'Message id must be a non-empty string when given', {
      id: input.id,
    });
  }
  for (const field of ['from', 'subject', 'body']) {
    if (input[field] !== undefined && typeof input[field] !== 'string') {
      throw storeError('UIS_INVALID_MESSAGE', `Message ${field} must be a string`, {
        [field]: input[field],
      });
    }
  }
  for (const flag of ['read', 'starred']) {
    if (input[flag] !== undefined && typeof input[flag] !== 'boolean') {
      throw storeError('UIS_INVALID_MESSAGE', `Message ${flag} must be a boolean`, {
        [flag]: input[flag],
      });
    }
  }
}

/** Canonical v2 message record. */
function toRecord(input, id, at) {
  return {
    id,
    channel: input.channel,
    ts: input.ts,
    from: input.from ?? '',
    subject: input.subject ?? '',
    body: input.body ?? '',
    read: input.read ?? false,
    starred: input.starred ?? false,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Migrate an older snapshot to the current schema, in place, and return it.
 * Throws UIS_CORRUPT_SNAPSHOT when the snapshot has no usable message list.
 *
 * v1 → v2: `seen` (boolean) becomes `read`, `starred` defaults to false.
 * A snapshot with no `version` is treated as v1 when it has a messages array.
 */
export function migrate(snapshot) {
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.messages)) {
    throw storeError('UIS_CORRUPT_SNAPSHOT', 'Snapshot has no messages array', {
      snapshot: typeof snapshot,
    });
  }
  const version = snapshot.version ?? 1;
  if (version === SCHEMA_VERSION) return snapshot;
  if (version > SCHEMA_VERSION) {
    throw storeError(
      'UIS_VERSION_CONFLICT',
      `Snapshot version ${version} is newer than store schema ${SCHEMA_VERSION}`,
      { version, schemaVersion: SCHEMA_VERSION },
    );
  }
  if (version === 1) {
    for (const message of snapshot.messages) {
      if (!isPlainObject(message)) {
        throw storeError('UIS_CORRUPT_SNAPSHOT', 'Snapshot contains a non-object message', {});
      }
      if (typeof message.read !== 'boolean') {
        message.read = message.seen === true;
      }
      delete message.seen;
      if (typeof message.starred !== 'boolean') {
        message.starred = false;
      }
    }
    snapshot.version = SCHEMA_VERSION;
    return snapshot;
  }
  throw storeError('UIS_CORRUPT_SNAPSHOT', `Unknown snapshot version: ${version}`, { version });
}

/** Deep-validate a migrated snapshot before it replaces store state. */
function validateMigratedSnapshot(snapshot) {
  for (const message of snapshot.messages) {
    if (!isPlainObject(message)) {
      throw storeError('UIS_CORRUPT_SNAPSHOT', 'Snapshot contains a non-object message', {});
    }
    try {
      assertMessageInput(message);
    } catch (err) {
      if (err?.code === 'UIS_INVALID_MESSAGE') {
        throw storeError('UIS_CORRUPT_SNAPSHOT', `Corrupt message in snapshot: ${err.message}`, {
          id: message.id,
        });
      }
      throw err;
    }
  }
}

/**
 * Create a new unified inbox store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ get(string): any, set(string, any): void }} [deps.storage]
 * @param {string} [deps.storageKey]
 * @param {Function | Function[]} [deps.onChange]
 */
export function createUnifiedInboxStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? memoryStorage();
  const storageKey = deps.storageKey ?? DEFAULT_STORAGE_KEY;

  let idCounter = 0;
  const newId = deps.id ?? (() => `msg-${(idCounter += 1)}`);

  /** Internal message records, keyed by id. */
  const messages = new Map();

  /** Change subscribers: Set of functions. */
  const subscribers = new Set();
  const initial = Array.isArray(deps.onChange) ? deps.onChange : deps.onChange ? [deps.onChange] : [];
  for (const fn of initial) {
    if (typeof fn !== 'function') {
      throw storeError('UIS_INVALID_ARG', 'onChange subscribers must be functions', { fn });
    }
    subscribers.add(fn);
  }

  function emit(event) {
    const full = Object.freeze({ at: clock(), ...event });
    for (const fn of [...subscribers]) {
      fn(full);
    }
  }

  /** Write-through: persist the full snapshot on every mutation. */
  function persist() {
    const state = { version: SCHEMA_VERSION, messages: [...messages.values()].map((m) => ({ ...m })) };
    try {
      storage.set(storageKey, state);
    } catch (err) {
      throw storeError('UIS_STORAGE_ERROR', `Storage write failed for key ${storageKey}: ${err.message}`, {
        storageKey,
        cause: err,
      });
    }
  }

  function getRecordOrThrow(id) {
    const message = messages.get(id);
    if (!message) {
      throw storeError('UIS_NOT_FOUND', `Unknown message id: ${id}`, { messageId: id });
    }
    return message;
  }

  function messageSnapshot(message) {
    return Object.freeze({ ...message });
  }

  const store = {
    get storageKey() {
      return storageKey;
    },

    get size() {
      return messages.size;
    },

    /**
     * Insert a new message (no id, or an id not yet in the store) or update
     * the existing message with the same id. Returns a frozen record.
     */
    upsertMessage(input) {
      assertMessageInput(input);
      const at = clock();
      const existing = input.id !== undefined ? messages.get(input.id) : undefined;
      if (existing) {
        const updated = {
          ...existing,
          channel: input.channel,
          ts: input.ts,
          from: input.from ?? existing.from,
          subject: input.subject ?? existing.subject,
          body: input.body ?? existing.body,
          read: input.read ?? existing.read,
          starred: input.starred ?? existing.starred,
          updatedAt: at,
        };
        messages.set(existing.id, updated);
        persist();
        emit({ type: 'message-updated', messageId: existing.id });
        return messageSnapshot(updated);
      }
      const id = input.id ?? newId();
      const record = toRecord(input, id, at);
      messages.set(id, record);
      persist();
      emit({ type: 'message-created', messageId: id });
      return messageSnapshot(record);
    },

    /** Read-only snapshot of a message (null if unknown — no throw). */
    getMessage(id) {
      const message = messages.get(id);
      return message ? messageSnapshot(message) : null;
    },

    /**
     * List messages: filter by channel/read/starred, sorted by ts desc
     * (id desc as deterministic tie-break), paginated by cursor.
     * Returns { messages, nextCursor } — nextCursor is null on the last page.
     * `cursor` is the id of the last message of the previous page.
     */
    list({ channel, read, starred, cursor, limit } = {}) {
      if (channel !== undefined) assertChannel(channel);
      if (read !== undefined && typeof read !== 'boolean') {
        throw storeError('UIS_INVALID_ARG', 'list filter `read` must be a boolean', { read });
      }
      if (starred !== undefined && typeof starred !== 'boolean') {
        throw storeError('UIS_INVALID_ARG', 'list filter `starred` must be a boolean', { starred });
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw storeError('UIS_INVALID_ARG', 'list `limit` must be a positive integer', { limit });
      }

      const sorted = [...messages.values()]
        .filter((m) => channel === undefined || m.channel === channel)
        .filter((m) => read === undefined || m.read === read)
        .filter((m) => starred === undefined || m.starred === starred)
        .sort((a, b) => (b.ts - a.ts) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

      let start = 0;
      if (cursor !== undefined && cursor !== null) {
        const index = sorted.findIndex((m) => m.id === cursor);
        if (index === -1) {
          throw storeError('UIS_INVALID_ARG', `Unknown list cursor: ${cursor}`, { cursor });
        }
        start = index + 1;
      }

      const page = limit === undefined ? sorted.slice(start) : sorted.slice(start, start + limit);
      const hasMore = start + page.length < sorted.length;
      return {
        messages: page.map(messageSnapshot),
        nextCursor: hasMore ? page[page.length - 1].id : null,
      };
    },

    /** Set the read flag on a message (default true). */
    markRead(id, read = true) {
      const message = getRecordOrThrow(id);
      message.read = read === true;
      message.updatedAt = clock();
      persist();
      emit({ type: read ? 'message-read' : 'message-unread', messageId: id });
      return messageSnapshot(message);
    },

    /** Convenience: mark a message unread. */
    markUnread(id) {
      return this.markRead(id, false);
    },

    /** Star a message. */
    star(id) {
      const message = getRecordOrThrow(id);
      message.starred = true;
      message.updatedAt = clock();
      persist();
      emit({ type: 'message-starred', messageId: id });
      return messageSnapshot(message);
    },

    /** Unstar a message. */
    unstar(id) {
      const message = getRecordOrThrow(id);
      message.starred = false;
      message.updatedAt = clock();
      persist();
      emit({ type: 'message-unstarred', messageId: id });
      return messageSnapshot(message);
    },

    /** Remove a message. Throws UIS_NOT_FOUND for unknown ids. */
    deleteMessage(id) {
      getRecordOrThrow(id);
      messages.delete(id);
      persist();
      emit({ type: 'message-deleted', messageId: id });
      return true;
    },

    /** Register a change subscriber. Returns an unsubscribe function. */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw storeError('UIS_INVALID_ARG', 'subscribe requires a function', { fn });
      }
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    /** Remove a previously registered subscriber. */
    unsubscribe(fn) {
      subscribers.delete(fn);
    },

    /** Serializable state: { version, messages }. */
    snapshot() {
      return {
        version: SCHEMA_VERSION,
        messages: [...messages.values()].map((m) => ({ ...m })),
      };
    },

    /**
     * Replace store state from a snapshot. Older versions are migrated;
     * newer versions throw UIS_VERSION_CONFLICT; bad shapes throw
     * UIS_CORRUPT_SNAPSHOT. Persists and emits a restore event.
     */
    restore(snapshot) {
      if (!isPlainObject(snapshot)) {
        throw storeError('UIS_CORRUPT_SNAPSHOT', 'Snapshot must be a plain object', {});
      }
      // Copy before migrate: migration mutates message records in place and
      // must never mutate the caller's snapshot. A non-array messages value
      // is passed through so migrate() can reject it with UIS_CORRUPT_SNAPSHOT.
      const rawMessages = snapshot.messages;
      const copied = Array.isArray(rawMessages) ? rawMessages.map((m) => ({ ...m })) : rawMessages;
      const migrated = migrate({ version: snapshot.version, messages: copied });
      validateMigratedSnapshot(migrated);
      messages.clear();
      for (const message of migrated.messages) {
        messages.set(message.id, { ...message });
      }
      persist();
      emit({ type: 'store-restored', messageId: null });
      return this.snapshot();
    },
  };

  // Hydrate from injected storage when a snapshot is already persisted.
  let hydrated;
  try {
    hydrated = storage.get(storageKey);
  } catch (err) {
    throw storeError('UIS_STORAGE_ERROR', `Storage read failed for key ${storageKey}: ${err.message}`, {
      storageKey,
      cause: err,
    });
  }
  if (hydrated !== undefined && hydrated !== null) {
    store.restore(hydrated);
  }

  return Object.freeze(store);
}
