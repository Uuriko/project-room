/**
 * agent-pause-enforcement.mjs — Pure owner-issued pause/resume policy engine.
 *
 * Model: an agent is either running or paused. Only the room owner may issue a
 * pause or a resume. A pause may carry an optional resumeAt timestamp; once
 * that time passes the pause lapses automatically (auto-resume). Action paths
 * call gate(action, agentId) before doing work; it throws PE_PAUSED while the
 * agent is paused and returns true otherwise.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure policy engine. All side effects (the actual enforcement on a
 * live agent) are the caller's job; this module only answers policy questions
 * and records the decisions.
 *
 * Pause record: { id, agentId, pausedBy, pausedAt, reason, resumeAt }
 *   - pausedBy is the identity that issued the pause; it MUST satisfy the
 *     injected isOwner() check or pause()/resume() throw PE_NOT_OWNER.
 *   - reason is a free-text note stored verbatim (defaults to '').
 *   - resumeAt is an optional ms-epoch deadline; null means indefinite.
 *
 * Dependency injection (all via the `deps` parameter of createPauseEnforcement):
 *   - clock:   () => number   (ms epoch; default: Date.now)
 *   - id:      () => string   (pause-event id generator; default: per-engine counter)
 *   - isOwner: (id: string) => boolean
 *              (owner check for the issuing identity; default: () => false,
 *               i.e. fail-closed — nobody is owner unless the caller says so)
 *
 * Event model:
 *   - Every pause, manual resume, and auto-resume is appended to the global
 *     audit log AND to the per-agent pause history (both append-only, frozen).
 *   - Subscribers registered via subscribe(fn) are notified (in registration
 *     order) with a frozen event object { type, agentId, at, by, reason?,
 *     resumeAt?, resumedAt? } on every 'pause' | 'resume' | 'auto-resume'.
 *     Subscriber exceptions propagate to the caller; they are never swallowed.
 *
 * Staleness: a pause whose resumeAt has passed is no longer effective.
 * isPaused(), gate(), listPaused() and sweep() all resolve staleness first:
 * the lapsed pause is recorded as an auto-resume (audit + history +
 * notification) and the agent is then treated as running. sweep(now) performs
 * this eagerly for every agent and returns the ids it auto-resumed.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   PE_INVALID         — bad argument (empty/blank agentId, non-string id,
 *                        resumeAt not a future timestamp)
 *   PE_NOT_OWNER       — the issuing identity is not the owner
 *   PE_ALREADY_PAUSED  — pause() while the agent is already paused
 *   PE_NOT_PAUSED      — resume() while the agent is not paused
 *   PE_NOT_FOUND       — history() for an agent with no pause history
 *   PE_PAUSED          — gate() blocked an action for a paused agent
 * Failures are never silent.
 */

export const EVENT_TYPES = Object.freeze(['pause', 'resume', 'auto-resume']);

/** Throw a coded pause-enforcement error (never silent failures). */
function pauseError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Create a new owner pause/resume enforcement engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {(id: string) => boolean} [deps.isOwner]
 */
export function createPauseEnforcement(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const isOwner = deps.isOwner ?? (() => false);

  let idCounter = 0;
  const newId = deps.id ?? (() => `pause-${(idCounter += 1)}`);

  /** Active pauses, keyed by agentId. */
  const active = new Map();

  /** Append-only per-agent pause history, keyed by agentId. */
  const histories = new Map();

  /** Append-only global audit log of every pause/resume/auto-resume. */
  const audit = [];

  /** Subscriber callbacks, notified in registration order. */
  const subscribers = new Set();

  function assertAgentId(agentId) {
    if (typeof agentId !== 'string' || agentId.trim() === '') {
      throw pauseError('PE_INVALID', 'agentId must be a non-empty string', { agentId });
    }
  }

  function assertOwner(by, op) {
    if (typeof by !== 'string' || by.trim() === '') {
      throw pauseError('PE_INVALID', `${op} requires an issuing identity`, { by });
    }
    if (!isOwner(by)) {
      throw pauseError('PE_NOT_OWNER', `Only the owner may ${op} (attempted by '${by}')`, {
        by,
        op,
      });
    }
  }

  function assertFutureResumeAt(resumeAt, now) {
    if (resumeAt === undefined || resumeAt === null) return null;
    if (typeof resumeAt !== 'number' || !Number.isFinite(resumeAt)) {
      throw pauseError('PE_INVALID', 'resumeAt must be a finite ms-epoch number or null', {
        resumeAt,
      });
    }
    if (resumeAt <= now) {
      throw pauseError('PE_INVALID', 'resumeAt must be in the future', { resumeAt, now });
    }
    return resumeAt;
  }

  /** Frozen snapshot of an active pause record. */
  function snapshot(record) {
    return Object.freeze({
      id: record.id,
      agentId: record.agentId,
      pausedBy: record.pausedBy,
      pausedAt: record.pausedAt,
      reason: record.reason,
      resumeAt: record.resumeAt,
    });
  }

  /** Frozen history/audit event entry. */
  function eventEntry(type, { agentId, by, at, reason, resumeAt, resumedAt, recordId }) {
    return Object.freeze({
      id: newId(),
      type,
      agentId,
      at,
      by,
      reason: reason === undefined ? null : reason,
      resumeAt: resumeAt === undefined ? null : resumeAt,
      resumedAt: resumedAt === undefined ? null : resumedAt,
      recordId: recordId === undefined ? null : recordId,
    });
  }

  function appendHistory(entry) {
    let history = histories.get(entry.agentId);
    if (!history) {
      history = [];
      histories.set(entry.agentId, history);
    }
    history.push(entry);
    audit.push(entry);
  }

  /** Notify subscribers of an event. Exceptions propagate (never swallowed). */
  function notify(event) {
    const frozen = Object.freeze({ ...event });
    for (const fn of subscribers) {
      fn(frozen);
    }
  }

  /**
   * Resolve staleness for one agent: if the active pause's resumeAt has passed,
   * record an auto-resume (audit + history + notification) and drop the pause.
   * Returns the remaining active record, or null.
   */
  function settle(agentId, now) {
    const record = active.get(agentId);
    if (!record) return null;
    if (record.resumeAt != null && record.resumeAt <= now) {
      active.delete(agentId);
      const entry = eventEntry('auto-resume', {
        agentId,
        by: 'system',
        at: now,
        reason: record.reason,
        resumeAt: record.resumeAt,
        resumedAt: now,
        recordId: record.id,
      });
      appendHistory(entry);
      notify(entry);
      return null;
    }
    return record;
  }

  const engine = {
    /** Append-only global audit trail of every pause/resume/auto-resume. */
    get audit() {
      return [...audit];
    },

    /**
     * Pause an agent. Only the owner may pause.
     * @param {string} agentId
     * @param {string} by       issuing identity (must satisfy isOwner)
     * @param {string} [reason]
     * @param {number|null} [resumeAt]  optional future ms-epoch auto-resume time
     */
    pause(agentId, by, reason, resumeAt) {
      assertAgentId(agentId);
      assertOwner(by, 'pause');
      const now = clock();
      const deadline = assertFutureResumeAt(resumeAt, now);
      const existing = settle(agentId, now);
      if (existing) {
        throw pauseError(
          'PE_ALREADY_PAUSED',
          `Agent '${agentId}' is already paused (by '${existing.pausedBy}')`,
          { agentId, pausedBy: existing.pausedBy, recordId: existing.id },
        );
      }
      const record = {
        id: newId(),
        agentId,
        pausedBy: by,
        pausedAt: now,
        reason: reason ?? '',
        resumeAt: deadline,
      };
      active.set(agentId, record);
      const entry = eventEntry('pause', {
        agentId,
        by,
        at: now,
        reason: record.reason,
        resumeAt: record.resumeAt,
        recordId: record.id,
      });
      appendHistory(entry);
      notify(entry);
      return snapshot(record);
    },

    /**
     * Resume a paused agent. Only the owner may resume.
     * Returns a frozen receipt describing the completed resume.
     */
    resume(agentId, by) {
      assertAgentId(agentId);
      assertOwner(by, 'resume');
      const now = clock();
      const record = settle(agentId, now);
      if (!record) {
        throw pauseError('PE_NOT_PAUSED', `Agent '${agentId}' is not paused`, { agentId });
      }
      active.delete(agentId);
      const entry = eventEntry('resume', {
        agentId,
        by,
        at: now,
        reason: record.reason,
        resumeAt: record.resumeAt,
        resumedAt: now,
        recordId: record.id,
      });
      appendHistory(entry);
      notify(entry);
      return Object.freeze({
        agentId,
        resumedBy: by,
        resumedAt: now,
        pause: snapshot(record),
      });
    },

    /**
     * True while the agent is effectively paused. Resolves staleness first:
     * a pause whose resumeAt has passed is auto-resumed (recorded) and reports
     * false. @param {number} [now] defaults to the injected clock.
     */
    isPaused(agentId, now = clock()) {
      assertAgentId(agentId);
      return settle(agentId, now) !== null;
    },

    /**
     * Action-path gate: throws PE_PAUSED while the agent is paused, returns
     * true otherwise. Call this before doing work for an agent.
     */
    gate(action, agentId, now = clock()) {
      assertAgentId(agentId);
      const record = settle(agentId, now);
      if (record) {
        throw pauseError('PE_PAUSED', `Action '${action}' blocked: agent '${agentId}' is paused`, {
          action,
          agentId,
          pausedBy: record.pausedBy,
          pausedAt: record.pausedAt,
          reason: record.reason,
          resumeAt: record.resumeAt,
          recordId: record.id,
        });
      }
      return true;
    },

    /**
     * Read-only frozen snapshots of every effectively-paused agent.
     * Stale pauses are auto-resumed (recorded) and excluded.
     * @param {number} [now] defaults to the injected clock.
     */
    listPaused(now = clock()) {
      const out = [];
      for (const agentId of [...active.keys()]) {
        const record = settle(agentId, now);
        if (record) out.push(snapshot(record));
      }
      return out;
    },

    /**
     * Eagerly auto-resume every agent whose resumeAt has passed. Each
     * auto-resume lands in the audit log, the per-agent history, and the
     * subscriber notifications. Returns the agentIds that were resumed.
     * @param {number} [now] defaults to the injected clock.
     */
    sweep(now = clock()) {
      const resumed = [];
      for (const agentId of [...active.keys()]) {
        if (settle(agentId, now) === null) {
          resumed.push(agentId);
        }
      }
      return resumed;
    },

    /**
     * Append-only per-agent pause history (frozen entries, oldest first).
     * Throws PE_NOT_FOUND for an agent with no pause history.
     */
    history(agentId) {
      assertAgentId(agentId);
      const history = histories.get(agentId);
      if (!history) {
        throw pauseError('PE_NOT_FOUND', `No pause history for agent '${agentId}'`, { agentId });
      }
      return [...history];
    },

    /** Read-only snapshot of the active pause for an agent (null when running). */
    get(agentId, now = clock()) {
      assertAgentId(agentId);
      const record = settle(agentId, now);
      return record ? snapshot(record) : null;
    },

    /**
     * Register a subscriber notified on every pause/resume/auto-resume with a
     * frozen event object. Returns an unsubscribe function.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw pauseError('PE_INVALID', 'subscribe requires a function', { fn });
      }
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
  };

  return Object.freeze(engine);
}
