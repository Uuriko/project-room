/**
 * digest-scheduler.mjs — Pure digest-subscription scheduler for digest mode.
 *
 * A subscription collects pending notification items per user and releases
 * them as one digest payload per cadence tick, skipping the subscriber's
 * quiet hours. Nothing here touches the network, the DOM, localStorage, or
 * any secret — wake-up times are computed purely from the injected clock.
 *
 * Model:
 *   subscription = {
 *     id, userId, channels[], cadence, quietHours, lastSentAt, paused, createdAt
 *   }
 *   cadence: 'immediate' | 'hourly' | 'daily' | 'weekly'
 *   quietHours: null | { start: 'HH:MM', end: 'HH:MM', tz?: 'IANA name' }
 *     — half-open local window [start, end); if end <= start the window wraps
 *       overnight; start === end disables quiet hours.
 *   digest payload = { subscriptionId, items, windowStart, windowEnd }
 *     — windowStart is the previous send time (0 for never-sent), windowEnd
 *       is the collection time; items are sorted by `at` ascending.
 *
 * Dependency injection (all via the `deps` parameter of createDigestScheduler):
 *   - clock:   () => number  (ms epoch; default: Date.now)
 *   - id:      () => string  (subscription id generator; default: per-scheduler counter)
 *   - storage: { save(obj), load() -> obj | null } (write-through persistence;
 *              default: null — in-memory only). load() is read once at
 *              construction; every mutation calls save(snapshot()).
 *
 * Quiet-hours timezone: `tz` is an IANA zone name resolved with the built-in
 * Intl API (no network). Omitted or 'UTC' means the window is expressed in UTC.
 * An unresolvable tz is rejected at subscribe()/restore() time.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   DS_NOT_FOUND         — unknown subscription id (get returns null instead)
 *   DS_INVALID_ARGUMENT  — bad argument shape (userId, channels, item index, ...)
 *   DS_INVALID_ITEM      — collect() item missing subscriptionId/at or unknown
 *                          subscription (unknown id reports as DS_NOT_FOUND)
 *   DS_INVALID_SCHEDULE  — bad cadence or quietHours value
 *   DS_CORRUPT_SNAPSHOT  — restore()/constructor data fails schema validation
 *   DS_STORAGE_FAILURE   — the injected storage threw (wrapped, original attached)
 * Failures are never silent.
 */

export const CADENCES = Object.freeze(['immediate', 'hourly', 'daily', 'weekly']);

export const SCHEMA_VERSION = 1;

const CADENCE_MS = Object.freeze({
  immediate: 0,
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
});

const DAY_MS = 24 * 60 * 60 * 1000;
const HM_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_QUIET_SKIPS = 1000;

/** Throw a coded digest-scheduler error (never silent failures). */
function dsError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** 'HH:MM' → minutes since local midnight; throws DS_INVALID_SCHEDULE. */
function parseHM(value, field) {
  if (typeof value !== 'string' || !HM_RE.test(value)) {
    throw dsError(
      'DS_INVALID_SCHEDULE',
      `quietHours.${field} must be 'HH:MM' (24h), got ${JSON.stringify(value)}`,
      { field, value },
    );
  }
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}

/** Offset of an IANA zone from UTC at instant `t`, in ms (built-in Intl only). */
function tzOffsetMs(t, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - t;
}

/** Absolute ms of local midnight (in `tz`) for the local day containing `t`. */
function localMidnightMs(t, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const guess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day));
  // Two-pass refinement keeps DST transitions exact at the boundary.
  const midnight = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(midnight, tz);
}

/**
 * End (absolute ms) of the quiet window containing `t`, or null when `t` is
 * outside quiet hours. Checks today's and yesterday's window so overnight
 * windows (e.g. 22:00–07:00) are caught after local midnight.
 */
function quietWindowEndContaining(t, tz, startMin, endMin) {
  const midnight = localMidnightMs(t, tz);
  for (const dayOffset of [0, -1]) {
    const base = midnight + dayOffset * DAY_MS;
    const ws = base + startMin * 60 * 1000;
    let we = base + endMin * 60 * 1000;
    if (we <= ws) we += DAY_MS; // overnight wrap
    if (t >= ws && t < we) return we;
  }
  return null;
}

/** Normalize + validate quietHours (null/undefined → null = no quiet hours). */
function normalizeQuietHours(quietHours) {
  if (quietHours == null) return null;
  if (typeof quietHours !== 'object' || Array.isArray(quietHours)) {
    throw dsError('DS_INVALID_SCHEDULE', 'quietHours must be an object or null', { quietHours });
  }
  const { start, end, tz } = quietHours;
  const startMin = parseHM(start, 'start');
  const endMin = parseHM(end, 'end');
  const zone = tz === undefined ? 'UTC' : tz;
  if (typeof zone !== 'string') {
    throw dsError('DS_INVALID_SCHEDULE', 'quietHours.tz must be an IANA zone name string', { tz });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw dsError('DS_INVALID_SCHEDULE', `quietHours.tz is not a known IANA zone: ${zone}`, { tz: zone });
  }
  if (startMin === endMin) return null; // zero-length window = quiet hours off
  return Object.freeze({ start, end, tz: zone });
}

function assertCadence(cadence) {
  if (!CADENCES.includes(cadence)) {
    throw dsError(
      'DS_INVALID_SCHEDULE',
      `cadence must be one of ${CADENCES.join('|')}, got ${JSON.stringify(cadence)}`,
      { cadence },
    );
  }
  return cadence;
}

function assertSubscriptionFields({ userId, channels, cadence, quietHours }) {
  if (typeof userId !== 'string' || userId.trim() === '') {
    throw dsError('DS_INVALID_ARGUMENT', 'userId must be a non-empty string', { userId });
  }
  if (!Array.isArray(channels) || channels.length === 0 || channels.some((c) => typeof c !== 'string' || c === '')) {
    throw dsError('DS_INVALID_ARGUMENT', 'channels must be a non-empty array of strings', { channels });
  }
  assertCadence(cadence);
  return normalizeQuietHours(quietHours);
}

/** Deep-validate one stored subscription record; throws DS_CORRUPT_SNAPSHOT. */
function validateStoredSubscription(rec) {
  const bad = (detail) => {
    throw dsError('DS_CORRUPT_SNAPSHOT', 'Stored subscription record failed schema validation', detail);
  };
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) bad({ record: rec });
  if (typeof rec.id !== 'string' || rec.id === '') bad({ field: 'id', record: rec });
  if (typeof rec.userId !== 'string' || rec.userId === '') bad({ field: 'userId', record: rec });
  if (!Array.isArray(rec.channels) || rec.channels.length === 0 || rec.channels.some((c) => typeof c !== 'string')) {
    bad({ field: 'channels', record: rec });
  }
  if (!CADENCES.includes(rec.cadence)) bad({ field: 'cadence', record: rec });
  try {
    normalizeQuietHours(rec.quietHours ?? null);
  } catch (err) {
    bad({ field: 'quietHours', record: rec, reason: err.message });
  }
  if (rec.lastSentAt !== null && (typeof rec.lastSentAt !== 'number' || !Number.isFinite(rec.lastSentAt))) {
    bad({ field: 'lastSentAt', record: rec });
  }
  if (typeof rec.paused !== 'boolean') bad({ field: 'paused', record: rec });
  if (typeof rec.createdAt !== 'number' || !Number.isFinite(rec.createdAt)) bad({ field: 'createdAt', record: rec });
}

/**
 * Create a digest scheduler.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ save: (obj: object) => void, load: () => object | null }} [deps.storage]
 */
export function createDigestScheduler(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `digest-sub-${(idCounter += 1)}`);

  /** Internal subscription records, keyed by id (insertion order). */
  const subs = new Map();

  function subSnapshot(sub) {
    return Object.freeze({
      id: sub.id,
      userId: sub.userId,
      channels: Object.freeze([...sub.channels]),
      cadence: sub.cadence,
      quietHours: sub.quietHours,
      lastSentAt: sub.lastSentAt,
      paused: sub.paused,
      createdAt: sub.createdAt,
    });
  }

  function fullSnapshot() {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      at: clock(),
      subscriptions: Object.freeze([...subs.values()].map(subSnapshot)),
    });
  }

  /** Write-through: persist after every mutation; storage failures are coded. */
  function persist() {
    if (!storage) return;
    try {
      storage.save(fullSnapshot());
    } catch (err) {
      throw dsError('DS_STORAGE_FAILURE', `Injected storage.save failed: ${err.message}`, {
        cause: err.message,
      });
    }
  }

  function getSubOrThrow(id) {
    const sub = subs.get(id);
    if (!sub) {
      throw dsError('DS_NOT_FOUND', `Unknown subscription id: ${id}`, { subscriptionId: id });
    }
    return sub;
  }

  /**
   * Advance `t` past any quiet window it falls in. Converges because each
   * skip moves strictly forward to a window end (bounded by MAX_QUIET_SKIPS).
   */
  function applyQuietHours(sub, t) {
    const q = sub.quietHours;
    if (!q) return t;
    const startMin = parseHM(q.start, 'start');
    const endMin = parseHM(q.end, 'end');
    let skipped = 0;
    for (;;) {
      const end = quietWindowEndContaining(t, q.tz ?? 'UTC', startMin, endMin);
      if (end == null) return t;
      t = end;
      skipped += 1;
      if (skipped > MAX_QUIET_SKIPS) {
        throw dsError('DS_INVALID_SCHEDULE', 'Quiet-hours skip did not converge', {
          subscriptionId: sub.id,
        });
      }
    }
  }

  /** Restore internal state from already-validated records (no persist). */
  function hydrate(records) {
    subs.clear();
    for (const rec of records) {
      subs.set(rec.id, {
        id: rec.id,
        userId: rec.userId,
        channels: [...rec.channels],
        cadence: rec.cadence,
        quietHours: rec.quietHours ?? null,
        lastSentAt: rec.lastSentAt ?? null,
        paused: rec.paused ?? false,
        createdAt: rec.createdAt,
      });
    }
  }

  function validateSnapshotData(data) {
    const bad = (detail) => {
      throw dsError('DS_CORRUPT_SNAPSHOT', 'Snapshot failed schema validation', detail);
    };
    if (data === null || typeof data !== 'object' || Array.isArray(data)) bad({ data });
    if (data.schemaVersion !== SCHEMA_VERSION) {
      bad({ expectedSchemaVersion: SCHEMA_VERSION, got: data.schemaVersion });
    }
    if (!Array.isArray(data.subscriptions)) bad({ field: 'subscriptions' });
    const seen = new Set();
    for (const rec of data.subscriptions) {
      validateStoredSubscription(rec);
      if (seen.has(rec.id)) bad({ duplicateId: rec.id });
      seen.add(rec.id);
    }
  }

  const scheduler = {
    /** Valid cadence values. */
    get cadences() {
      return CADENCES;
    },

    get schemaVersion() {
      return SCHEMA_VERSION;
    },

    /**
     * Next eligible send time (ms epoch) for a subscription record or id at
     * `now`. Honours cadence (anchored on lastSentAt, or now when never sent)
     * and skips forward past quiet hours. Returns null for paused ids.
     */
    nextDue(subOrId, now = clock()) {
      const sub = typeof subOrId === 'string' ? getSubOrThrow(subOrId) : subOrId;
      if (!sub || typeof sub !== 'object') {
        throw dsError('DS_INVALID_ARGUMENT', 'nextDue requires a subscription record or id');
      }
      if (sub.paused) return null;
      let base;
      if (sub.cadence === 'immediate' || sub.lastSentAt == null) {
        base = now; // immediate cadence, or never sent: due right away
      } else {
        base = sub.lastSentAt + CADENCE_MS[sub.cadence];
      }
      return applyQuietHours(sub, base);
    },

    /** Subscriptions currently due (frozen snapshots, insertion order). */
    dueSubscriptions(now = clock()) {
      const due = [];
      for (const sub of subs.values()) {
        if (sub.paused) continue;
        if (scheduler.nextDue(sub, now) <= now) due.push(subSnapshot(sub));
      }
      return Object.freeze(due);
    },

    /** Create a subscription; returns a frozen snapshot. */
    subscribe({ userId, channels, cadence, quietHours } = {}) {
      const qh = assertSubscriptionFields({ userId, channels, cadence, quietHours });
      assertCadence(cadence);
      const id = newId();
      if (subs.has(id)) {
        throw dsError('DS_INVALID_ARGUMENT', `Generated subscription id already exists: ${id}`, { id });
      }
      const sub = {
        id,
        userId,
        channels: [...channels],
        cadence,
        quietHours: qh,
        lastSentAt: null,
        paused: false,
        createdAt: clock(),
      };
      subs.set(id, sub);
      persist();
      return subSnapshot(sub);
    },

    /** Remove a subscription; returns its final snapshot. */
    unsubscribe(id) {
      const sub = getSubOrThrow(id);
      subs.delete(id);
      persist();
      return subSnapshot(sub);
    },

    /** Read-only snapshot of a subscription, or null when unknown. */
    get(id) {
      const sub = subs.get(id);
      return sub ? subSnapshot(sub) : null;
    },

    /** All subscriptions as frozen snapshots (insertion order). */
    list() {
      return Object.freeze([...subs.values()].map(subSnapshot));
    },

    /** Record a send: re-anchors the cadence at `now`. */
    markSent(id, now = clock()) {
      const sub = getSubOrThrow(id);
      if (typeof now !== 'number' || !Number.isFinite(now)) {
        throw dsError('DS_INVALID_ARGUMENT', 'markSent requires a finite ms-epoch time', { now });
      }
      sub.lastSentAt = now;
      persist();
      return subSnapshot(sub);
    },

    /** Pause a subscription (never due while paused). */
    pause(id) {
      const sub = getSubOrThrow(id);
      sub.paused = true;
      persist();
      return subSnapshot(sub);
    },

    /** Resume a paused subscription. */
    resume(id) {
      const sub = getSubOrThrow(id);
      sub.paused = false;
      persist();
      return subSnapshot(sub);
    },

    /**
     * Group pending items into one digest payload per subscription.
     * items: [{ subscriptionId, at, ...any }] — subscriptionId must exist,
     * at must be a finite number. Returns frozen payloads:
     * { subscriptionId, items (by `at` asc, frozen), windowStart, windowEnd }.
     * Only subscriptions with ≥1 item produce a payload.
     */
    collect(items, now = clock()) {
      if (!Array.isArray(items)) {
        throw dsError('DS_INVALID_ARGUMENT', 'collect requires an array of items', { items });
      }
      const grouped = new Map();
      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          throw dsError('DS_INVALID_ITEM', `Item at index ${index} must be an object`, { index });
        }
        const { subscriptionId, at } = item;
        if (typeof subscriptionId !== 'string' || subscriptionId === '') {
          throw dsError('DS_INVALID_ITEM', `Item at index ${index} needs a subscriptionId string`, { index });
        }
        if (typeof at !== 'number' || !Number.isFinite(at)) {
          throw dsError('DS_INVALID_ITEM', `Item at index ${index} needs a finite numeric 'at'`, { index });
        }
        const sub = getSubOrThrow(subscriptionId);
        if (!grouped.has(subscriptionId)) grouped.set(subscriptionId, { sub, list: [] });
        grouped.get(subscriptionId).list.push(item);
      }
      const payloads = [];
      for (const [subscriptionId, { sub, list }] of grouped) {
        const sorted = [...list].sort((a, b) => a.at - b.at);
        payloads.push(
          Object.freeze({
            subscriptionId,
            items: Object.freeze(sorted.map((item) => Object.freeze({ ...item }))),
            windowStart: sub.lastSentAt ?? 0,
            windowEnd: now,
          }),
        );
      }
      return Object.freeze(payloads);
    },

    /** Versioned snapshot of all scheduler state (for storage/export). */
    snapshot() {
      return fullSnapshot();
    },

    /**
     * Replace all state from a snapshot; validates schema version and every
     * record — anything off throws DS_CORRUPT_SNAPSHOT and state is untouched.
     */
    restore(data) {
      validateSnapshotData(data);
      hydrate(data.subscriptions);
      persist();
      return fullSnapshot();
    },
  };

  // Constructor hydration: a stored snapshot is the source of truth.
  if (storage) {
    let stored;
    try {
      stored = storage.load();
    } catch (err) {
      throw dsError('DS_STORAGE_FAILURE', `Injected storage.load failed: ${err.message}`, {
        cause: err.message,
      });
    }
    if (stored != null) {
      validateSnapshotData(stored);
      hydrate(stored.subscriptions);
    }
  }

  return Object.freeze(scheduler);
}
