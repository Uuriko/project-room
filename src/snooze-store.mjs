/**
 * snooze-store.mjs — Pure snooze persistence + wake-up scheduling store.
 *
 * A snooze record marks a message as "remind me later": {id, messageId, channel,
 * snoozedAt, wakeAt, note?}. Due items transition to `woken` via wakeDue(); a
 * woken item may be re-snoozed. Presets (later-today / tomorrow / next-week)
 * compute wakeAt from the injected clock.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret — it
 * is a pure store plus scheduler. Persistence is write-through to an injected
 * `storage` dep; wake-ups are driven by the injected `clock` (no real timers).
 *
 * Dependency injection (all via the `deps` parameter of createSnoozeStore):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (snooze id generator; default: per-store counter)
 *   - storage: { read(): string|null, write(raw: string): void } | null
 *              (default: null — ephemeral, no persistence)
 *
 * The default storage shape stores the snapshot as a JSON string under whatever
 * key the caller chooses; production wiring wraps it around e.g. a file or KV.
 * On create, an existing persisted snapshot is loaded; if it is corrupt the
 * store throws SZ_CORRUPT_SNAPSHOT instead of silently dropping state.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   SZ_NOT_FOUND        — unknown snooze id
 *   SZ_INVALID_ARG      — bad argument (empty messageId, non-finite wake, bad preset…)
 *   SZ_ALREADY_SNOOZED  — one live snooze per messageId
 *   SZ_PAST_WAKE        — wakeAt is not in the future
 *   SZ_INVALID_STATE    — operation not valid for the record's state
 *   SZ_CORRUPT_SNAPSHOT — persisted/snapshot data fails schema validation
 * Failures are never silent.
 */

export const SNOOZE_SCHEMA_VERSION = 1;

export const SNOOZE_STATES = Object.freeze(['snoozed', 'woken']);

const PRESET = Object.freeze({
  LATER_TODAY: 'later-today',
  TOMORROW: 'tomorrow',
  NEXT_WEEK: 'next-week',
});

export const SNOOZE_PRESETS = Object.freeze([PRESET.LATER_TODAY, PRESET.TOMORROW, PRESET.NEXT_WEEK]);

/** Throw a coded snooze error (never silent failures). */
function snoozeError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isFiniteMs(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/** Validate a single snooze record object (used by restore()). */
function validateRecord(rec) {
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) return false;
  if (typeof rec.id !== 'string' || rec.id.length === 0) return false;
  if (typeof rec.messageId !== 'string' || rec.messageId.length === 0) return false;
  if (typeof rec.channel !== 'string') return false;
  if (!isFiniteMs(rec.snoozedAt) || !isFiniteMs(rec.wakeAt)) return false;
  if (!SNOOZE_STATES.includes(rec.state)) return false;
  if (rec.note !== undefined && rec.note !== null && typeof rec.note !== 'string') return false;
  return true;
}

function validateSnapshot(snap) {
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) return false;
  if (snap.schemaVersion !== SNOOZE_SCHEMA_VERSION) return false;
  if (!Array.isArray(snap.records)) return false;
  return snap.records.every(validateRecord);
}

/**
 * Create a new snooze store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{read(): string|null, write(raw: string): void}|null} [deps.storage]
 */
export function createSnoozeStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `snooze-${(idCounter += 1)}`);

  /** Internal records, keyed by id. */
  const records = new Map();

  /** Append-only audit log: every mutation lands here, never removed. */
  const audit = [];

  /** Subscriber set: notified after each mutation and wake-up. */
  const subscribers = new Set();

  function record({ at, type, recordId, detail }) {
    const entry = Object.freeze({
      at,
      type,
      recordId,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function snapshot(rec) {
    return Object.freeze({
      id: rec.id,
      messageId: rec.messageId,
      channel: rec.channel,
      snoozedAt: rec.snoozedAt,
      wakeAt: rec.wakeAt,
      state: rec.state,
      note: rec.note ?? null,
      wokenAt: rec.wokenAt ?? null,
    });
  }

  /** Serialize the full store state (schema-versioned). */
  function toSnapshotObject() {
    return {
      schemaVersion: SNOOZE_SCHEMA_VERSION,
      at: clock(),
      records: [...records.values()].map((r) => ({
        id: r.id,
        messageId: r.messageId,
        channel: r.channel,
        snoozedAt: r.snoozedAt,
        wakeAt: r.wakeAt,
        state: r.state,
        note: r.note ?? null,
        wokenAt: r.wokenAt ?? null,
      })),
    };
  }

  /** Write-through: persist after every mutation. Storage write failures throw. */
  function persist() {
    if (!storage) return;
    storage.write(JSON.stringify(toSnapshotObject()));
  }

  function notify(event) {
    for (const fn of subscribers) {
      fn(event);
    }
  }

  function getRecordOrThrow(id) {
    const rec = records.get(id);
    if (!rec) {
      throw snoozeError('SZ_NOT_FOUND', `Unknown snooze id: ${id}`, { snoozeId: id });
    }
    return rec;
  }

  function assertMessageId(messageId) {
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw snoozeError('SZ_INVALID_ARG', 'messageId must be a non-empty string', { messageId });
    }
  }

  function resolveWakeAt(wake, asDuration) {
    if (!isFiniteMs(wake)) {
      throw snoozeError('SZ_INVALID_ARG', 'wake must be a finite positive ms value', { wake });
    }
    const wakeAt = asDuration ? clock() + wake : wake;
    if (!isFiniteMs(wakeAt)) {
      throw snoozeError('SZ_INVALID_ARG', 'computed wakeAt is not a finite positive ms value', { wake, asDuration });
    }
    if (wakeAt <= clock()) {
      throw snoozeError('SZ_PAST_WAKE', `wakeAt ${wakeAt} is not in the future (now ${clock()})`, {
        wakeAt,
        now: clock(),
      });
    }
    return wakeAt;
  }

  function assertNoLiveDuplicate(messageId) {
    for (const rec of records.values()) {
      if (rec.messageId === messageId && rec.state === 'snoozed') {
        throw snoozeError(
          'SZ_ALREADY_SNOOZED',
          `messageId ${messageId} already has a live snooze (${rec.id})`,
          { messageId, snoozeId: rec.id },
        );
      }
    }
  }

  /**
   * Load a persisted snapshot (JSON string) into the store, validating schema.
   * Used at creation (write-through target) and exposed via restore().
   */
  function loadSnapshotObject(snap, source) {
    if (!validateSnapshot(snap)) {
      throw snoozeError(
        'SZ_CORRUPT_SNAPSHOT',
        `Snapshot failed schema validation (expected schemaVersion ${SNOOZE_SCHEMA_VERSION})`,
        { source },
      );
    }
    records.clear();
    for (const rec of snap.records) {
      records.set(rec.id, { ...rec });
    }
  }

  // Eager load: a corrupt persisted state throws at creation, never silently.
  if (storage) {
    const raw = storage.read();
    if (raw !== null && raw !== undefined && raw !== '') {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw snoozeError('SZ_CORRUPT_SNAPSHOT', 'Persisted snapshot is not valid JSON', {
          source: 'storage',
        });
      }
      loadSnapshotObject(parsed, 'storage');
    }
  }

  const store = {
    /** Append-only audit trail: {at, type, recordId, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Snooze a message. `wake` is an absolute ms epoch by default, or a duration
     * from now when `opts.asDuration` is true. Third arg accepts a note string
     * or an options object {note, channel, asDuration}.
     */
    snooze(messageId, wake, noteOrOpts = null, channel = 'inbox') {
      assertMessageId(messageId);
      let note = null;
      let asDuration = false;
      if (noteOrOpts !== null && typeof noteOrOpts === 'object') {
        note = noteOrOpts.note ?? null;
        asDuration = noteOrOpts.asDuration === true;
        channel = noteOrOpts.channel ?? channel;
      } else {
        note = noteOrOpts;
      }
      if (note !== null && typeof note !== 'string') {
        throw snoozeError('SZ_INVALID_ARG', 'note must be a string or null', { note });
      }
      if (typeof channel !== 'string' || channel.length === 0) {
        throw snoozeError('SZ_INVALID_ARG', 'channel must be a non-empty string', { channel });
      }
      assertNoLiveDuplicate(messageId);
      const wakeAt = resolveWakeAt(wake, asDuration);
      const rec = {
        id: newId(),
        messageId,
        channel,
        snoozedAt: clock(),
        wakeAt,
        state: 'snoozed',
        note,
        wokenAt: null,
      };
      records.set(rec.id, rec);
      persist();
      record({
        at: clock(),
        type: 'snoozed',
        recordId: rec.id,
        detail: { messageId, wakeAt, channel },
      });
      const snap = snapshot(rec);
      notify({ type: 'snoozed', record: snap });
      return snap;
    },

    /** Cancel a snooze by id. Returns the removed record's snapshot. */
    unsnooze(id) {
      const rec = getRecordOrThrow(id);
      records.delete(id);
      persist();
      record({ at: clock(), type: 'unsnoozed', recordId: id, detail: { messageId: rec.messageId } });
      const snap = snapshot(rec);
      notify({ type: 'unsnoozed', record: snap });
      return snap;
    },

    /** Read-only snapshot of a snooze (null if unknown). */
    get(id) {
      const rec = records.get(id);
      return rec ? snapshot(rec) : null;
    },

    /** All live (snoozed) records, sorted by wakeAt ascending. */
    list() {
      return [...records.values()]
        .filter((r) => r.state === 'snoozed')
        .sort((a, b) => a.wakeAt - b.wakeAt)
        .map(snapshot);
    },

    /** Live records with wakeAt <= now, sorted by wakeAt ascending. */
    listDue(now = clock()) {
      if (!isFiniteMs(now)) {
        throw snoozeError('SZ_INVALID_ARG', 'now must be a finite positive ms value', { now });
      }
      return [...records.values()]
        .filter((r) => r.state === 'snoozed' && r.wakeAt <= now)
        .sort((a, b) => a.wakeAt - b.wakeAt)
        .map(snapshot);
    },

    /**
     * Wake every due record: transitions snoozed → woken, stamps wokenAt, one
     * audit entry per item, subscriber notification per item. Returns the woken
     * snapshots (wakeAt ascending).
     */
    wakeDue(now = clock(), actor = 'system') {
      const due = this.listDue(now);
      const woken = [];
      for (const snap of due) {
        const rec = records.get(snap.id);
        if (!rec || rec.state !== 'snoozed') continue;
        rec.state = 'woken';
        rec.wokenAt = now;
        woken.push(snapshot(rec));
      }
      if (woken.length > 0) {
        persist();
        for (const snap of woken) {
          record({
            at: now,
            type: 'woken',
            recordId: snap.id,
            detail: { messageId: snap.messageId, actor, wokenAt: now },
          });
          notify({ type: 'woken', record: snap });
        }
      }
      return woken;
    },

    /**
     * Re-snooze a woken record with a new wake time. The record keeps its id;
     * snoozedAt/wakeAt are refreshed and wokenAt cleared. Live (still snoozed)
     * records cannot be re-snoozed — unsnooze them first.
     */
    reSnooze(id, wake, noteOrOpts = null) {
      const rec = getRecordOrThrow(id);
      if (rec.state !== 'woken') {
        throw snoozeError(
          'SZ_INVALID_STATE',
          `Cannot re-snooze ${id} from state '${rec.state}' (must be 'woken')`,
          { snoozeId: id, state: rec.state },
        );
      }
      let note = rec.note;
      let asDuration = false;
      if (noteOrOpts !== null && typeof noteOrOpts === 'object') {
        note = noteOrOpts.note ?? rec.note;
        asDuration = noteOrOpts.asDuration === true;
      } else if (noteOrOpts !== null) {
        note = noteOrOpts;
      }
      if (note !== null && typeof note !== 'string') {
        throw snoozeError('SZ_INVALID_ARG', 'note must be a string or null', { note });
      }
      const wakeAt = resolveWakeAt(wake, asDuration);
      rec.snoozedAt = clock();
      rec.wakeAt = wakeAt;
      rec.state = 'snoozed';
      rec.note = note;
      rec.wokenAt = null;
      persist();
      record({
        at: clock(),
        type: 'resnoozed',
        recordId: id,
        detail: { messageId: rec.messageId, wakeAt },
      });
      const snap = snapshot(rec);
      notify({ type: 'resnoozed', record: snap });
      return snap;
    },

    /**
     * Preset wake times computed from the injected clock (UTC day math, so the
     * fake clock stays deterministic):
     *   later-today — end of the current UTC day (23:59:59.999)
     *   tomorrow    — 09:00 UTC the next day
     *   next-week   — same wall-clock time, 7 days out
     */
    preset(name) {
      if (!SNOOZE_PRESETS.includes(name)) {
        throw snoozeError(
          'SZ_INVALID_ARG',
          `Unknown preset '${name}' (expected one of ${SNOOZE_PRESETS.join(', ')})`,
          { name },
        );
      }
      const now = clock();
      const dayMs = 24 * 60 * 60 * 1000;
      const startOfTodayUtc = Math.floor(now / dayMs) * dayMs;
      if (name === PRESET.LATER_TODAY) {
        const endOfDay = startOfTodayUtc + dayMs - 1;
        // If the clock is already at/past end-of-day, push one hour out.
        return endOfDay > now ? endOfDay : now + 60 * 60 * 1000;
      }
      if (name === PRESET.TOMORROW) {
        return startOfTodayUtc + dayMs + 9 * 60 * 60 * 1000;
      }
      return now + 7 * dayMs;
    },

    /** Subscribe to store events; returns an unsubscribe function. */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw snoozeError('SZ_INVALID_ARG', 'subscriber must be a function', { fn });
      }
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    /** Schema-versioned snapshot of the full store state. */
    snapshot() {
      return toSnapshotObject();
    },

    /**
     * Replace store state from a snapshot object. Rejects corrupt/unknown
     * versions with SZ_CORRUPT_SNAPSHOT and writes the restored state through
     * to storage.
     */
    restore(snap) {
      loadSnapshotObject(snap, 'restore');
      persist();
      record({
        at: clock(),
        type: 'restored',
        recordId: null,
        detail: { schemaVersion: SNOOZE_SCHEMA_VERSION, count: records.size },
      });
      return this.snapshot();
    },
  };

  return Object.freeze(store);
}
