/**
 * agent-reputation.mjs — Pure agent reputation scoring engine.
 *
 * Each agent starts at a score of 500 on a 0..1000 scale. Signed reputation
 * events move the score; idle scores decay back toward 500 so stale standing
 * fades. Nothing here touches the network, the DOM, localStorage, or any
 * secret — it is a pure scoring engine.
 *
 * Scoring:
 *   - Event deltas: completed +10, helpful +5, failed -20, harmful -50,
 *     timeout -15. A validated weight (0.1..10, default 1) multiplies the
 *     delta. Scores clamp to [0, 1000].
 *   - Decay: applied lazily on read/record. score(t) = 500 + (score - 500) *
 *     (1 - decayRate)^daysElapsed. Default decayRate 1%/day (0.01).
 *   - Tiers: excellent >= 800, good >= 600, fair >= 400, poor >= 200,
 *     bad < 200.
 *   - Anti-gaming: at most one recorded event per type per agent per minute;
 *     extras are rejected (and noted in the audit log).
 *
 * Dependency injection (all via the `deps` parameter of createAgentReputation):
 *   - clock:     () => number  (ms epoch; default: Date.now)
 *   - decayRate: number        (fraction of deviation erased per day;
 *                              default: 0.01, must be in [0, 1])
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   AR_INVALID_AGENT_ID   — agentId missing or not a non-empty string
 *   AR_NOT_FOUND          — unknown agent id (score/history/reset)
 *   AR_INVALID_EVENT_TYPE — type not in completed|failed|helpful|harmful|timeout
 *   AR_INVALID_WEIGHT     — weight not a finite number in [0.1, 10]
 *   AR_INVALID_TIMESTAMP  — event `at` not a finite non-negative number
 *   AR_DUPLICATE_EVENT    — same type already recorded for the agent < 1 min ago
 *   AR_INVALID_REASON     — reset reason missing or not a non-empty string
 *   AR_INVALID_LIMIT      — limit not a positive integer
 *   AR_INVALID_SCORE      — tier() called with a non-finite score
 *   AR_INVALID_DECAY_RATE — decayRate not a number in [0, 1]
 * Failures are never silent.
 */

export const EVENT_TYPES = Object.freeze(['completed', 'failed', 'helpful', 'harmful', 'timeout']);

export const EVENT_DELTAS = Object.freeze({
  completed: 10,
  helpful: 5,
  failed: -20,
  harmful: -50,
  timeout: -15,
});

export const START_SCORE = 500;
export const MIN_SCORE = 0;
export const MAX_SCORE = 1000;
export const DEFAULT_DECAY_RATE = 0.01;
export const DUPLICATE_WINDOW_MS = 60 * 1000;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Throw a coded reputation error (never silent failures). */
function repError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Reputation tier for a score.
 * @param {number} score finite score, typically 0..1000
 * @returns {'excellent'|'good'|'fair'|'poor'|'bad'}
 */
export function tier(score) {
  if (!Number.isFinite(score)) {
    throw repError('AR_INVALID_SCORE', `tier() requires a finite score, got: ${score}`, { score });
  }
  if (score >= 800) return 'excellent';
  if (score >= 600) return 'good';
  if (score >= 400) return 'fair';
  if (score >= 200) return 'poor';
  return 'bad';
}

/**
 * Create a new agent reputation engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {number} [deps.decayRate]
 */
export function createAgentReputation(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const decayRate = deps.decayRate ?? DEFAULT_DECAY_RATE;
  if (typeof decayRate !== 'number' || !Number.isFinite(decayRate) || decayRate < 0 || decayRate > 1) {
    throw repError(
      'AR_INVALID_DECAY_RATE',
      `decayRate must be a finite number in [0, 1], got: ${decayRate}`,
      { decayRate },
    );
  }

  /** Internal agent records, keyed by agentId. */
  const agents = new Map();

  /** Append-only audit log: records, rejections, and resets land here. */
  const audit = [];

  function auditNote(entry) {
    const note = Object.freeze({ at: clock(), ...entry });
    audit.push(note);
    return note;
  }

  function assertAgentId(agentId) {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      throw repError(
        'AR_INVALID_AGENT_ID',
        `agentId must be a non-empty string, got: ${String(agentId)}`,
        { agentId },
      );
    }
  }

  function getAgentOrThrow(agentId) {
    const agent = agents.get(agentId);
    if (!agent) {
      throw repError('AR_NOT_FOUND', `Unknown agent id: ${agentId}`, { agentId });
    }
    return agent;
  }

  /** Lazily decay an agent's score toward 500 using the injected clock. */
  function applyDecay(agent) {
    const now = clock();
    const elapsedMs = now - agent.lastDecayAt;
    if (elapsedMs <= 0 || agent.score === START_SCORE) {
      agent.lastDecayAt = Math.max(agent.lastDecayAt, now);
      return;
    }
    const days = elapsedMs / MS_PER_DAY;
    const factor = Math.pow(1 - decayRate, days);
    agent.score = round2(START_SCORE + (agent.score - START_SCORE) * factor);
    agent.lastDecayAt = now;
  }

  function snapshot(agent) {
    return Object.freeze({
      agentId: agent.agentId,
      score: agent.score,
      tier: tier(agent.score),
      events: agent.events.length,
      lastActiveAt: agent.lastActiveAt,
    });
  }

  function assertLimit(limit, name) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw repError(
        'AR_INVALID_LIMIT',
        `${name} must be a positive integer, got: ${String(limit)}`,
        { [name]: limit },
      );
    }
  }

  const rep = {
    /** Append-only audit trail: {at, action, agentId, detail}. */
    get audit() {
      return [...audit];
    },

    get decayRate() {
      return decayRate;
    },

    /**
     * Record a reputation event for an agent (creates the agent at 500 on
     * first record). Returns the frozen post-event snapshot.
     */
    record(agentId, event) {
      assertAgentId(agentId);
      const type = event?.type;
      if (!EVENT_TYPES.includes(type)) {
        throw repError(
          'AR_INVALID_EVENT_TYPE',
          `Unknown event type: ${String(type)} (expected one of ${EVENT_TYPES.join('|')})`,
          { agentId, type },
        );
      }
      const weight = event?.weight ?? 1;
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0.1 || weight > 10) {
        throw repError(
          'AR_INVALID_WEIGHT',
          `weight must be a finite number in [0.1, 10], got: ${String(weight)}`,
          { agentId, weight },
        );
      }
      const at = event?.at ?? clock();
      if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) {
        throw repError(
          'AR_INVALID_TIMESTAMP',
          `event 'at' must be a finite non-negative ms timestamp, got: ${String(at)}`,
          { agentId, at },
        );
      }

      let agent = agents.get(agentId);
      if (!agent) {
        agent = {
          agentId,
          score: START_SCORE,
          events: [],
          lastActiveAt: null,
          lastDecayAt: at,
          lastEventAtByType: new Map(),
        };
        agents.set(agentId, agent);
      }

      applyDecay(agent);

      // Anti-gaming: at most one event of a given type per agent per minute.
      const lastOfType = agent.lastEventAtByType.get(type);
      if (lastOfType !== undefined && at - lastOfType >= 0 && at - lastOfType < DUPLICATE_WINDOW_MS) {
        auditNote({
          action: 'record-rejected',
          agentId,
          detail: { type, reason: 'duplicate event within one minute', at },
        });
        throw repError(
          'AR_DUPLICATE_EVENT',
          `Duplicate ${type} event for agent ${agentId} within one minute`,
          { agentId, type, at },
        );
      }

      const delta = round2(EVENT_DELTAS[type] * weight);
      agent.score = round2(Math.min(MAX_SCORE, Math.max(MIN_SCORE, agent.score + delta)));
      agent.lastEventAtByType.set(type, at);
      agent.lastActiveAt = at;
      agent.events.push(Object.freeze({ type, delta, weight, at }));
      auditNote({ action: 'record', agentId, detail: { type, delta, weight, at } });
      return snapshot(agent);
    },

    /**
     * Read an agent's current score (decay applied lazily to now). Throws
     * AR_NOT_FOUND for unknown agents.
     */
    score(agentId) {
      assertAgentId(agentId);
      const agent = getAgentOrThrow(agentId);
      applyDecay(agent);
      return snapshot(agent);
    },

    /**
     * Leaderboard sorted by score descending. Ties break by agentId ascending
     * for determinism.
     */
    leaderboard({ limit = 10, minEvents = 0 } = {}) {
      assertLimit(limit, 'limit');
      if (!Number.isInteger(minEvents) || minEvents < 0) {
        throw repError(
          'AR_INVALID_LIMIT',
          `minEvents must be a non-negative integer, got: ${String(minEvents)}`,
          { minEvents },
        );
      }
      const rows = [];
      for (const agent of agents.values()) {
        applyDecay(agent);
        if (agent.events.length >= minEvents) rows.push(agent);
      }
      rows.sort((a, b) => b.score - a.score || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
      return rows.slice(0, limit).map(snapshot);
    },

    /**
     * Reset an agent to the starting score of 500, clearing its event history.
     * A reason is required and the reset is written to the audit log.
     */
    reset(agentId, reason) {
      assertAgentId(agentId);
      if (typeof reason !== 'string' || reason.length === 0) {
        throw repError(
          'AR_INVALID_REASON',
          'reset() requires a non-empty reason',
          { agentId, reason },
        );
      }
      const agent = getAgentOrThrow(agentId);
      const before = agent.score;
      agent.score = START_SCORE;
      agent.events = [];
      agent.lastEventAtByType = new Map();
      agent.lastDecayAt = clock();
      auditNote({ action: 'reset', agentId, detail: { reason, scoreBefore: before } });
      return snapshot(agent);
    },

    /**
     * Event history for an agent, newest first. Throws AR_NOT_FOUND for
     * unknown agents.
     */
    history(agentId, limit = 50) {
      assertAgentId(agentId);
      assertLimit(limit, 'limit');
      const agent = getAgentOrThrow(agentId);
      return agent.events.slice(-limit).reverse();
    },

    /** True when the engine has ever seen this agent id. */
    has(agentId) {
      assertAgentId(agentId);
      return agents.has(agentId);
    },
  };

  return Object.freeze(rep);
}
