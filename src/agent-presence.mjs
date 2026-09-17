/**
 * agent-presence.mjs — Pure agent presence + heartbeat tracker.
 *
 * Tracks which agents are around and how fresh their last heartbeat is.
 * Records: { agentId, state, lastHeartbeatAt, lastSeenAt, meta? }
 * States:  online | away | busy | offline
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure in-memory tracker. Callers own persistence and any realtime
 * wiring (heartbeats arrive as plain method calls).
 *
 * Dependency injection (all via the `deps` parameter of createAgentPresence):
 *   - clock:        () => number  (ms epoch; default: Date.now)
 *   - awayAfterMs:  number        (online → away after this long with no
 *                                  heartbeat; default: 5 minutes)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   AP_NOT_FOUND     — unknown agentId
 *   AP_INVALID_STATE — state not one of online|away|busy|offline
 *   AP_INVALID_ARG   — bad agentId, bad ms value, or other malformed argument
 * Failures are never silent.
 */

export const PRESENCE_STATES = Object.freeze(['online', 'away', 'busy', 'offline']);

export const DEFAULT_AWAY_AFTER_MS = 5 * 60 * 1000;

/** Throw a coded presence error (never silent failures). */
function presenceError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || agentId.trim() === '') {
    throw presenceError(
      'AP_INVALID_ARG',
      `agentId must be a non-empty string, got: ${JSON.stringify(agentId)}`,
      { agentId },
    );
  }
}

function assertState(state) {
  if (!PRESENCE_STATES.includes(state)) {
    throw presenceError(
      'AP_INVALID_STATE',
      `Invalid presence state: ${JSON.stringify(state)} (expected one of ${PRESENCE_STATES.join('|')})`,
      { state },
    );
  }
}

function assertMs(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw presenceError(
      'AP_INVALID_ARG',
      `${name} must be a positive finite number of ms, got: ${JSON.stringify(value)}`,
      { [name]: value },
    );
  }
}

/**
 * Create a new agent presence tracker.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {number} [deps.awayAfterMs]
 */
export function createAgentPresence(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const awayAfterMs = deps.awayAfterMs ?? DEFAULT_AWAY_AFTER_MS;
  assertMs(awayAfterMs, 'awayAfterMs');

  /** Internal presence records, keyed by agentId. */
  const agents = new Map();

  /** Append-only audit log: every state change lands here, never removed. */
  const audit = [];

  /** Subscriber callbacks notified on every state change. */
  const subscribers = new Set();

  function record({ at, agentId, from, to, reason }) {
    const entry = Object.freeze({
      at,
      agentId,
      from,
      to,
      reason: reason === undefined ? null : reason,
    });
    audit.push(entry);
    return entry;
  }

  function notify({ agentId, from, to, at, reason }) {
    const event = Object.freeze({
      agentId,
      from,
      to,
      at,
      reason: reason === undefined ? null : reason,
    });
    for (const fn of subscribers) {
      fn(event);
    }
    return event;
  }

  function snapshot(rec) {
    return Object.freeze({
      agentId: rec.agentId,
      state: rec.state,
      lastHeartbeatAt: rec.lastHeartbeatAt,
      lastSeenAt: rec.lastSeenAt,
      meta: rec.meta == null ? null : Object.freeze({ ...rec.meta }),
    });
  }

  function getRecordOrThrow(agentId) {
    assertAgentId(agentId);
    const rec = agents.get(agentId);
    if (!rec) {
      throw presenceError('AP_NOT_FOUND', `Unknown agent: ${agentId}`, { agentId });
    }
    return rec;
  }

  /** Apply a state change: mutate, audit, then notify subscribers. */
  function transition(rec, to, reason) {
    const from = rec.state;
    if (from === to) return snapshot(rec);
    rec.state = to;
    const at = clock();
    record({ at, agentId: rec.agentId, from, to, reason });
    notify({ agentId: rec.agentId, from, to, at, reason });
    return snapshot(rec);
  }

  const tracker = {
    /** Append-only audit trail: {at, agentId, from, to, reason}. */
    get audit() {
      return [...audit];
    },

    get awayAfterMs() {
      return awayAfterMs;
    },

    /** Number of tracked agents. */
    size() {
      return agents.size;
    },

    /**
     * Record a heartbeat. Upserts: creates the agent (default state `online`)
     * or refreshes an existing record. Always sets lastHeartbeatAt and
     * lastSeenAt to now. An explicit `state` is validated and applied as a
     * state change; `meta` replaces the stored meta.
     */
    heartbeat(agentId, { state, meta } = {}) {
      assertAgentId(agentId);
      if (state !== undefined) assertState(state);
      const now = clock();
      let rec = agents.get(agentId);
      if (!rec) {
        rec = {
          agentId,
          state: state ?? 'online',
          lastHeartbeatAt: now,
          lastSeenAt: now,
          meta: meta === undefined ? null : { ...meta },
        };
        agents.set(agentId, rec);
        record({ at: now, agentId, from: null, to: rec.state, reason: 'heartbeat' });
        notify({ agentId, from: null, to: rec.state, at: now, reason: 'heartbeat' });
        return snapshot(rec);
      }
      rec.lastHeartbeatAt = now;
      rec.lastSeenAt = now;
      if (meta !== undefined) {
        rec.meta = { ...meta };
      }
      if (state !== undefined && state !== rec.state) {
        return transition(rec, state, 'heartbeat');
      }
      return snapshot(rec);
    },

    /**
     * Set an agent's state explicitly. Validates the state and throws
     * AP_NOT_FOUND for unknown agents.
     */
    setState(agentId, state) {
      assertState(state);
      const rec = getRecordOrThrow(agentId);
      return transition(rec, state, 'setState');
    },

    /** Read-only snapshot of an agent's record (throws AP_NOT_FOUND). */
    get(agentId) {
      return snapshot(getRecordOrThrow(agentId));
    },

    /**
     * List snapshots for all tracked agents, optionally filtered by state.
     * The filter state is validated (AP_INVALID_STATE).
     */
    list({ state } = {}) {
      if (state !== undefined) assertState(state);
      const out = [];
      for (const rec of agents.values()) {
        if (state === undefined || rec.state === state) {
          out.push(snapshot(rec));
        }
      }
      return out;
    },

    /**
     * Mark agents stale. Agents (not already offline) whose last heartbeat is
     * older than `staleAfterMs` go to `offline`; agents still `online` whose
     * last heartbeat is older than the injected `awayAfterMs` go to `away`.
     * Every transition lands in the audit log and notifies subscribers.
     * Returns { offline: [agentIds], away: [agentIds] }.
     */
    sweep(staleAfterMs, now = clock()) {
      assertMs(staleAfterMs, 'staleAfterMs');
      const offline = [];
      const away = [];
      for (const rec of agents.values()) {
        const silentFor = now - rec.lastHeartbeatAt;
        if (rec.state !== 'offline' && silentFor > staleAfterMs) {
          transition(rec, 'offline', 'heartbeat stale');
          offline.push(rec.agentId);
        } else if (rec.state === 'online' && silentFor > awayAfterMs) {
          transition(rec, 'away', 'away timeout');
          away.push(rec.agentId);
        }
      }
      return { offline, away };
    },

    /**
     * True when the agent's recorded state is not `offline` AND its last
     * heartbeat is within `staleAfterMs` of `now`. Throws AP_NOT_FOUND for
     * unknown agents.
     */
    isOnline(agentId, { staleAfterMs, now = clock() } = {}) {
      assertMs(staleAfterMs, 'staleAfterMs');
      const rec = getRecordOrThrow(agentId);
      if (rec.state === 'offline') return false;
      return now - rec.lastHeartbeatAt <= staleAfterMs;
    },

    /**
     * Count of agents per state. The `away` auto-transition is projected here
     * (online + no heartbeat for awayAfterMs reads as away) without mutating
     * state; use sweep() to persist offline markings.
     */
    stats({ now = clock() } = {}) {
      const counts = { online: 0, away: 0, busy: 0, offline: 0 };
      for (const rec of agents.values()) {
        let projected = rec.state;
        if (projected === 'online' && now - rec.lastHeartbeatAt > awayAfterMs) {
          projected = 'away';
        }
        counts[projected] += 1;
      }
      return counts;
    },

    /**
     * Subscribe to state changes. The callback receives
     * {agentId, from, to, at, reason} for every transition (heartbeat-created
     * agents, setState, and sweep). Returns an unsubscribe function.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw presenceError('AP_INVALID_ARG', 'subscribe requires a function', {});
      }
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };

  return Object.freeze(tracker);
}
