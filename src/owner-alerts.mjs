/**
 * owner-alerts.mjs — Pure owner-alert dispatcher: raise, dispatch, acknowledge,
 * resolve, dedupe, escalate, and audit owner-facing alerts.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret — it
 * is a pure state machine. Delivery happens through the injected `notifier`
 * dependency; production wiring injects the real channel (email, push, …).
 *
 * States:
 *   pending → sent → acknowledged → resolved
 *   pending → acknowledged → resolved   (acknowledge may skip dispatch)
 *   pending/sent stay put on dispatch failure (never silent)
 * Escalation re-notifies critical, unacknowledged alerts that have lived
 * longer than escalationAfterMs, marking them sent if they had not been.
 *
 * Dependency injection (all via the `deps` parameter of
 * createOwnerAlertDispatcher):
 *   - clock:             () => number  (ms epoch; default: Date.now)
 *   - id:                () => string  (alert id generator; default: per-dispatcher counter)
 *   - notifier:          { notify(alert, opts) } — async delivery channel;
 *                          `alert` is a frozen alert snapshot; `opts` may carry
 *                          `{ escalated: true }` for escalation re-notifies.
 *                          No default: dispatch without one throws
 *                          OA_NOTIFIER_MISSING. Production wiring MUST inject.
 *   - backoff:           (attempt: number) => number  (ms to wait before a
 *                          dispatch retry; default: () => 0 — production
 *                          wiring SHOULD inject a real backoff)
 *   - sleep:             (ms: number) => Promise  (default: real setTimeout;
 *                          inject a fake for tests)
 *   - escalationAfterMs: number  (critical-alert escalation threshold;
 *                          default: 15 minutes)
 *   - dedupeWindowMs:    number  (same source+title dedupe window;
 *                          default: 10 minutes)
 *   - storage:           optional durable store { load(): object | null,
 *                          save(snapshot: object): void }. When present the
 *                          dispatcher hydrates from it on creation and saves
 *                          after every mutation. In-memory subscriber
 *                          listeners are NOT persisted.
 *
 * Subscribers: subscribe(listener) registers a listener called synchronously
 * with { type, alert, at } on every alert event (raised, dispatched,
 * dispatch-failed, acknowledged, resolved, escalated, deduped). Subscriber
 * errors propagate to the caller — failures are never swallowed.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   OA_NOT_FOUND        — unknown alert id
 *   OA_INVALID_ALERT    — raise()/acknowledge()/resolve() validation failed
 *                         (bad severity, empty title/body/source/by)
 *   OA_INVALID_STATE    — operation not allowed from the current state
 *   OA_NOTIFIER_MISSING — dispatch/escalation attempted without an injected
 *                         notifier
 *   OA_DELIVERY_FAILED  — all dispatch retries (or an escalation re-notify)
 *                         failed; the alert stays pending, every attempt is
 *                         recorded, and the throw carries the failure
 *   OA_SNAPSHOT_CORRUPT — snapshot()/restore()/storage payload has the wrong
 *                         schema version or a malformed alert record
 *   OA_STORAGE_ERROR    — the injected storage threw during load or save
 * Failures are never silent.
 */

export const SEVERITIES = Object.freeze(['info', 'warning', 'critical']);

export const STATES = Object.freeze([
  'pending',
  'sent',
  'acknowledged',
  'resolved',
]);

export const OWNER_ALERTS_SCHEMA_VERSION = 1;
export const DEFAULT_ESCALATION_AFTER_MS = 15 * 60 * 1000;
export const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
export const MAX_DISPATCH_ATTEMPTS = 3;

const ACKABLE_STATES = ['pending', 'sent'];
const RESOLVABLE_STATES = ['pending', 'sent', 'acknowledged'];

/** Throw a coded alert error (never silent failures). */
function alertError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAlertFields({ severity, title, body, source }) {
  const problems = [];
  if (!SEVERITIES.includes(severity)) {
    problems.push(`severity must be one of ${SEVERITIES.join('|')}`);
  }
  if (!isNonEmptyString(title)) problems.push('title must be a non-empty string');
  if (!isNonEmptyString(body)) problems.push('body must be a non-empty string');
  if (!isNonEmptyString(source)) problems.push('source must be a non-empty string');
  return problems;
}

/**
 * Create a new owner-alert dispatcher.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ notify(alert: object, opts?: object): Promise<any> }} [deps.notifier]
 * @param {(attempt: number) => number} [deps.backoff]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.escalationAfterMs]
 * @param {number} [deps.dedupeWindowMs]
 * @param {{ load(): object | null, save(snapshot: object): void }} [deps.storage]
 */
export function createOwnerAlertDispatcher(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const notifier = deps.notifier ?? null;
  const backoff = deps.backoff ?? (() => 0);
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const escalationAfterMs = deps.escalationAfterMs ?? DEFAULT_ESCALATION_AFTER_MS;
  const dedupeWindowMs = deps.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const storage = deps.storage ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `alert-${(idCounter += 1)}`);

  /** Internal alert records, keyed by id. */
  const alerts = new Map();

  /** Append-only audit log: every raise/transition/attempt lands here. */
  const audit = [];

  /** In-memory subscriber listeners (not persisted). */
  const subscribers = new Set();

  function record({ at, from, to, actor, detail }) {
    const entry = Object.freeze({
      at,
      from,
      to,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function emit(type, alert, at) {
    for (const listener of [...subscribers]) {
      listener({ type, alert: snapshot(alert), at });
    }
  }

  function snapshot(alert) {
    return Object.freeze({
      id: alert.id,
      severity: alert.severity,
      title: alert.title,
      body: alert.body,
      source: alert.source,
      createdAt: alert.createdAt,
      state: alert.state,
      attempts: Object.freeze(alert.attempts.map((a) => Object.freeze({ ...a }))),
      sentAt: alert.sentAt,
      acknowledgedAt: alert.acknowledgedAt,
      acknowledgedBy: alert.acknowledgedBy,
      resolvedAt: alert.resolvedAt,
      resolvedBy: alert.resolvedBy,
      resolveNote: alert.resolveNote,
      escalatedAt: alert.escalatedAt,
    });
  }

  function getAlertOrThrow(id) {
    const alert = alerts.get(id);
    if (!alert) {
      throw alertError('OA_NOT_FOUND', `Unknown alert id: ${id}`, { alertId: id });
    }
    return alert;
  }

  function assertState(alert, allowed, op) {
    if (!allowed.includes(alert.state)) {
      throw alertError(
        'OA_INVALID_STATE',
        `Cannot ${op} alert ${alert.id} from state '${alert.state}'`,
        { alertId: alert.id, state: alert.state, op },
      );
    }
  }

  function recordAttempt(alert, attempt) {
    const entry = Object.freeze({
      at: clock(),
      kind: attempt.kind,
      attempt: attempt.attempt,
      ok: attempt.ok,
      error: attempt.error ?? null,
    });
    alert.attempts.push(entry);
    return entry;
  }

  function transition(alert, to, actor, detail) {
    const from = alert.state;
    alert.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { alertId: alert.id, ...(detail ?? {}) },
    });
    return snapshot(alert);
  }

  function requireNotifier(op) {
    if (!notifier) {
      throw alertError(
        'OA_NOTIFIER_MISSING',
        `Cannot ${op}: no notifier injected (production wiring must provide deps.notifier)`,
        { op },
      );
    }
    return notifier;
  }

  function snapshotData() {
    return {
      version: OWNER_ALERTS_SCHEMA_VERSION,
      exportedAt: clock(),
      alerts: [...alerts.values()].map((a) => ({ ...a, attempts: a.attempts.map((x) => ({ ...x })) })),
      audit: audit.map((e) => ({ ...e, detail: e.detail == null ? null : { ...e.detail } })),
    };
  }

  function persist() {
    if (!storage) return;
    let failed = null;
    try {
      storage.save(snapshotData());
    } catch (err) {
      failed = err;
    }
    if (failed) {
      throw alertError(
        'OA_STORAGE_ERROR',
        `Storage save failed: ${failed instanceof Error ? failed.message : String(failed)}`,
        { cause: failed instanceof Error ? failed.message : String(failed) },
      );
    }
  }

  function validateRecord(rec) {
    return (
      rec != null &&
      typeof rec === 'object' &&
      typeof rec.id === 'string' &&
      SEVERITIES.includes(rec.severity) &&
      typeof rec.title === 'string' &&
      typeof rec.body === 'string' &&
      typeof rec.source === 'string' &&
      typeof rec.createdAt === 'number' &&
      STATES.includes(rec.state) &&
      Array.isArray(rec.attempts)
    );
  }

  function hydrate(data) {
    if (data == null || typeof data !== 'object') {
      throw alertError('OA_SNAPSHOT_CORRUPT', 'Alert data must be an object with a schema version', {
        received: data === null ? 'null' : typeof data,
      });
    }
    if (data.version !== OWNER_ALERTS_SCHEMA_VERSION) {
      throw alertError(
        'OA_SNAPSHOT_CORRUPT',
        `Unsupported alert schema version ${data.version} (expected ${OWNER_ALERTS_SCHEMA_VERSION})`,
        { version: data.version, expected: OWNER_ALERTS_SCHEMA_VERSION },
      );
    }
    if (!Array.isArray(data.alerts)) {
      throw alertError('OA_SNAPSHOT_CORRUPT', 'Alert data must contain an alerts array', {});
    }
    const next = new Map();
    for (const rec of data.alerts) {
      if (!validateRecord(rec)) {
        throw alertError('OA_SNAPSHOT_CORRUPT', 'Alert data contains a malformed alert record', {
          alertId: rec && typeof rec === 'object' ? rec.id : undefined,
        });
      }
      next.set(rec.id, {
        id: rec.id,
        severity: rec.severity,
        title: rec.title,
        body: rec.body,
        source: rec.source,
        createdAt: rec.createdAt,
        state: rec.state,
        attempts: rec.attempts.map((a) => ({ ...a })),
        sentAt: rec.sentAt ?? null,
        acknowledgedAt: rec.acknowledgedAt ?? null,
        acknowledgedBy: rec.acknowledgedBy ?? null,
        resolvedAt: rec.resolvedAt ?? null,
        resolvedBy: rec.resolvedBy ?? null,
        resolveNote: rec.resolveNote ?? null,
        escalatedAt: rec.escalatedAt ?? null,
      });
    }
    alerts.clear();
    for (const [id, alert] of next) alerts.set(id, alert);
    audit.length = 0;
    if (Array.isArray(data.audit)) {
      for (const e of data.audit) audit.push(Object.freeze({ ...e }));
    }
  }

  // Hydrate from durable storage when provided (corruption is never silent).
  if (storage) {
    let loaded = null;
    let failed = null;
    try {
      loaded = storage.load();
    } catch (err) {
      failed = err;
    }
    if (failed) {
      throw alertError(
        'OA_STORAGE_ERROR',
        `Storage load failed: ${failed instanceof Error ? failed.message : String(failed)}`,
        { cause: failed instanceof Error ? failed.message : String(failed) },
      );
    }
    if (loaded != null) hydrate(loaded);
  }

  const dispatcher = {
    /** Schema version this dispatcher reads and writes. */
    get schemaVersion() {
      return OWNER_ALERTS_SCHEMA_VERSION;
    },

    /** Append-only audit trail: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    get escalationAfterMs() {
      return escalationAfterMs;
    },

    get dedupeWindowMs() {
      return dedupeWindowMs;
    },

    /**
     * Raise a new alert. Validates severity/title/body/source; throws
     * OA_INVALID_ALERT on bad input. Dedupe: a pending alert with the same
     * (source, title) created within dedupeWindowMs is returned instead of
     * creating a new one (the dedupe is itself recorded in the audit log).
     */
    raise({ severity, title, body, source } = {}, actor = 'agent') {
      const problems = validateAlertFields({ severity, title, body, source });
      if (problems.length > 0) {
        throw alertError('OA_INVALID_ALERT', `Invalid alert: ${problems.join('; ')}`, {
          problems,
        });
      }
      const now = clock();
      for (const existing of alerts.values()) {
        if (
          existing.state === 'pending' &&
          existing.source === source &&
          existing.title === title &&
          now - existing.createdAt < dedupeWindowMs
        ) {
          record({
            at: now,
            from: null,
            to: 'pending',
            actor,
            detail: {
              alertId: existing.id,
              deduped: true,
              reason: 'duplicate (source, title) within dedupeWindowMs',
              dedupeWindowMs,
            },
          });
          emit('deduped', existing, now);
          return snapshot(existing);
        }
      }
      const alert = {
        id: newId(),
        severity,
        title,
        body,
        source,
        createdAt: now,
        state: 'pending',
        attempts: [],
        sentAt: null,
        acknowledgedAt: null,
        acknowledgedBy: null,
        resolvedAt: null,
        resolvedBy: null,
        resolveNote: null,
        escalatedAt: null,
      };
      alerts.set(alert.id, alert);
      record({
        at: now,
        from: null,
        to: 'pending',
        actor,
        detail: { alertId: alert.id, severity, source },
      });
      emit('raised', alert, now);
      persist();
      return snapshot(alert);
    },

    /**
     * Dispatch a pending alert through notifier.notify(alert). Retries up to
     * MAX_DISPATCH_ATTEMPTS with the injected backoff between attempts. On
     * success the alert moves to `sent`; if every attempt fails the alert
     * stays pending, every attempt is recorded, and OA_DELIVERY_FAILED is
     * thrown — never silent.
     */
    async dispatch(alertId, actor = 'agent') {
      const alert = getAlertOrThrow(alertId);
      assertState(alert, ['pending'], 'dispatch');
      const channel = requireNotifier('dispatch');

      let lastError = null;
      for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await channel.notify(snapshot(alert));
          recordAttempt(alert, { kind: 'dispatch', attempt, ok: true });
          alert.sentAt = clock();
          const sent = transition(alert, 'sent', actor, {
            attempt,
            attempts: attempt,
          });
          emit('dispatched', alert, clock());
          persist();
          return sent;
        } catch (err) {
          lastError = err;
          recordAttempt(alert, {
            kind: 'dispatch',
            attempt,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          if (attempt < MAX_DISPATCH_ATTEMPTS) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(Math.max(0, backoff(attempt)));
          }
        }
      }
      record({
        at: clock(),
        from: 'pending',
        to: 'pending',
        actor,
        detail: {
          alertId: alert.id,
          kind: 'dispatch-failed',
          attempts: MAX_DISPATCH_ATTEMPTS,
          lastError: lastError instanceof Error ? lastError.message : String(lastError),
        },
      });
      emit('dispatch-failed', alert, clock());
      persist();
      throw alertError(
        'OA_DELIVERY_FAILED',
        `Delivery failed for alert ${alert.id} after ${MAX_DISPATCH_ATTEMPTS} attempts`,
        {
          alertId: alert.id,
          attempts: MAX_DISPATCH_ATTEMPTS,
          lastError: lastError instanceof Error ? lastError.message : String(lastError),
        },
      );
    },

    /**
     * Acknowledge an alert (pending or sent → acknowledged), recording who did
     * it. Acknowledging an already-acknowledged or resolved alert throws
     * OA_INVALID_STATE.
     */
    acknowledge(alertId, by = 'owner') {
      const alert = getAlertOrThrow(alertId);
      assertState(alert, ACKABLE_STATES, 'acknowledge');
      if (!isNonEmptyString(by)) {
        throw alertError('OA_INVALID_ALERT', 'acknowledge requires a non-empty `by`', {
          alertId: alert.id,
        });
      }
      const now = clock();
      alert.acknowledgedAt = now;
      alert.acknowledgedBy = by;
      const acked = transition(alert, 'acknowledged', by, { acknowledgedBy: by });
      emit('acknowledged', alert, now);
      persist();
      return acked;
    },

    /**
     * Resolve an alert (pending, sent, or acknowledged → resolved) with an
     * optional note. Resolving an already-resolved alert throws
     * OA_INVALID_STATE.
     */
    resolve(alertId, by = 'owner', note = '') {
      const alert = getAlertOrThrow(alertId);
      assertState(alert, RESOLVABLE_STATES, 'resolve');
      if (!isNonEmptyString(by)) {
        throw alertError('OA_INVALID_ALERT', 'resolve requires a non-empty `by`', {
          alertId: alert.id,
        });
      }
      const now = clock();
      alert.resolvedAt = now;
      alert.resolvedBy = by;
      alert.resolveNote = typeof note === 'string' ? note : '';
      const resolved = transition(alert, 'resolved', by, {
        resolvedBy: by,
        note: alert.resolveNote,
      });
      emit('resolved', alert, now);
      persist();
      return resolved;
    },

    /**
     * Escalation sweep: re-notify every critical alert that is still
     * unacknowledged (state pending or sent), was created at least
     * escalationAfterMs ago, and has not been escalated yet. The re-notify
     * goes through notifier.notify(alert, { escalated: true }); pending
     * alerts that re-notify successfully move to `sent`. Each escalation is
     * recorded in the audit log. Returns the ids escalated in this sweep.
     * A failed re-notify records a failed attempt and is reported via a
     * thrown OA_DELIVERY_FAILED (never silent).
     */
    async sweep(actor = 'system') {
      const channel = requireNotifier('escalate');
      const now = clock();
      const escalated = [];
      const failed = [];
      for (const alert of alerts.values()) {
        if (alert.severity !== 'critical') continue;
        if (alert.state !== 'pending' && alert.state !== 'sent') continue;
        if (alert.escalatedAt != null) continue;
        if (now - alert.createdAt < escalationAfterMs) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await channel.notify(snapshot(alert), { escalated: true });
          recordAttempt(alert, { kind: 'escalation', attempt: 'escalation', ok: true });
          alert.escalatedAt = now;
          if (alert.state === 'pending') {
            alert.sentAt = now;
            transition(alert, 'sent', actor, { escalated: true });
          } else {
            record({
              at: now,
              from: 'sent',
              to: 'sent',
              actor,
              detail: { alertId: alert.id, escalated: true },
            });
          }
          escalated.push(alert.id);
          emit('escalated', alert, now);
        } catch (err) {
          recordAttempt(alert, {
            kind: 'escalation',
            attempt: 'escalation',
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
          record({
            at: now,
            from: alert.state,
            to: alert.state,
            actor,
            detail: {
              alertId: alert.id,
              kind: 'escalation-failed',
              error: err instanceof Error ? err.message : String(err),
            },
          });
          failed.push(alert.id);
        }
      }
      persist();
      if (failed.length > 0) {
        throw alertError(
          'OA_DELIVERY_FAILED',
          `Escalation re-notify failed for ${failed.length} alert(s)`,
          { alertIds: failed, escalated },
        );
      }
      return escalated;
    },

    /** List alert snapshots, optionally filtered by state and/or severity. */
    list({ state, severity } = {}) {
      const out = [];
      for (const alert of alerts.values()) {
        if (state !== undefined && alert.state !== state) continue;
        if (severity !== undefined && alert.severity !== severity) continue;
        out.push(snapshot(alert));
      }
      return out;
    },

    /** Read-only snapshot of an alert (null if unknown). */
    get(id) {
      const alert = alerts.get(id);
      return alert ? snapshot(alert) : null;
    },

    /**
     * Subscribe to alert events: listener({ type, alert, at }) is called
     * synchronously on every event. Returns an unsubscribe function.
     */
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw alertError('OA_INVALID_ALERT', 'subscribe requires a listener function', {});
      }
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },

    /** Full export: { version, exportedAt, alerts, audit }. */
    snapshot() {
      return snapshotData();
    },

    /**
     * Replace all dispatcher state from a snapshot. Validates the schema
     * version and every alert record; throws OA_SNAPSHOT_CORRUPT on any
     * mismatch. Returns the number of alerts restored.
     */
    restore(data) {
      hydrate(data);
      persist();
      return alerts.size;
    },
  };

  return Object.freeze(dispatcher);
}
