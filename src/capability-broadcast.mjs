/**
 * capability-broadcast.mjs — Pure capability broadcast planner with debounce.
 *
 * Agents broadcast capability changes; rapid successive changes within the
 * debounce window (default 5s, injected) coalesce into a single announcement
 * carrying the latest capability set. Fan-out goes through an injected
 * `announce` dep, so this module never touches the network, the DOM, or any
 * transport of its own — it is a pure planner.
 *
 * Agent capability record: { agentId, capabilities: string[], version, announcedAt }.
 * `version` increments once per actual announce (debounced calls that coalesce
 * share one version bump). `announcedAt` is the injected-clock time of the
 * actual announce.
 *
 * Debounce mechanics (trailing edge, driven by the injected clock — no timers):
 *   - announceCaps() records the latest set as pending, due at clock() + debounceMs.
 *   - Pending is announced when the window lapses (checked at the top of every
 *     announceCaps / flush / prune call) or when flush() forces it.
 *   - Successive announceCaps calls for the same agent within the window replace
 *     the pending set and extend the window (classic trailing debounce).
 *   - A set identical to the last announced set is a no-op: any pending is
 *     cleared and nothing is announced (dedupe).
 *
 * Dependency injection (all via the `deps` parameter of createCapabilityBroadcast):
 *   - clock:       () => number  (ms epoch; default: Date.now)
 *   - announce:    (payload) => void  (fan-out sink; default: no-op)
 *   - debounceMs:  number  (coalescing window; default: 5000)
 *
 * The `announce` dep receives the frozen record
 * { agentId, capabilities, version, announcedAt } on each actual announce.
 * If it throws, the broadcast record still advances (the announcement logically
 * happened) and a CB_ANNOUNCE_FAILED error is thrown — never silent.
 * Subscriber listeners receive { agentId, capabilities, version } after a
 * successful announce.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   CB_INVALID_AGENT_ID — agentId is not a non-empty string
 *   CB_INVALID_CAPS     — capabilities is not an array of non-empty strings
 *                         (also used by diff() for non-array inputs)
 *   CB_INVALID_SUBSCRIBER — subscribe() listener is not a function
 *   CB_INVALID_DEBOUNCE — debounceMs is not a positive finite number
 *   CB_INVALID_PRUNE    — prune() staleAfterMs is not a positive finite number
 *   CB_NOT_FOUND        — view() of an unknown agentId
 *   CB_ANNOUNCE_FAILED  — the injected announce dep threw
 * Failures are never silent.
 */

export const DEFAULT_DEBOUNCE_MS = 5_000;

/** Throw a coded broadcast error (never silent failures). */
function cbError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw cbError(
      'CB_INVALID_AGENT_ID',
      `agentId must be a non-empty string, got: ${JSON.stringify(agentId)}`,
      { agentId },
    );
  }
}

/**
 * Canonicalize a capability list: must be an array of non-empty strings;
 * duplicates removed, first-seen order preserved.
 */
function canonicalCaps(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw cbError(
      'CB_INVALID_CAPS',
      `capabilities must be an array of strings, got: ${typeof capabilities}`,
      { capabilities },
    );
  }
  const seen = new Set();
  const out = [];
  for (const cap of capabilities) {
    if (typeof cap !== 'string' || cap.length === 0) {
      throw cbError(
        'CB_INVALID_CAPS',
        'every capability must be a non-empty string',
        { capabilities },
      );
    }
    if (!seen.has(cap)) {
      seen.add(cap);
      out.push(cap);
    }
  }
  return out;
}

/** Set-equality over canonical (deduped, ordered) capability lists. */
function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((cap) => set.has(cap));
}

/**
 * Create a capability broadcast planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {(payload: object) => void} [deps.announce]
 * @param {number} [deps.debounceMs]
 */
export function createCapabilityBroadcast(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const announce = deps.announce ?? (() => {});
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  if (typeof debounceMs !== 'number' || !Number.isFinite(debounceMs) || debounceMs <= 0) {
    throw cbError(
      'CB_INVALID_DEBOUNCE',
      `debounceMs must be a positive finite number, got: ${debounceMs}`,
      { debounceMs },
    );
  }

  /** Last announced record per agentId: frozen { agentId, capabilities, version, announcedAt }. */
  const agents = new Map();
  /** Pending (debounced, not yet announced) per agentId: { latest: string[], dueAt: number }. */
  const pending = new Map();
  /** Subscriber listeners, in subscription order. */
  const listeners = new Set();

  function record(agentId, latest) {
    return Object.freeze({
      agentId,
      capabilities: Object.freeze([...latest]),
      version: (agents.get(agentId)?.version ?? 0) + 1,
      announcedAt: clock(),
    });
  }

  /** Emit one actual announce: store the record, fan out, notify subscribers. */
  function fire(agentId) {
    const entry = pending.get(agentId);
    if (!entry) return null;
    pending.delete(agentId);
    const rec = record(agentId, entry.latest);
    agents.set(agentId, rec);
    const payload = {
      agentId: rec.agentId,
      capabilities: [...rec.capabilities],
      version: rec.version,
      announcedAt: rec.announcedAt,
    };
    try {
      announce(payload);
    } catch (cause) {
      throw cbError(
        'CB_ANNOUNCE_FAILED',
        `announce dep threw for agent ${agentId} (record still advanced to version ${rec.version})`,
        { agentId, version: rec.version, cause: cause?.message ?? String(cause) },
      );
    }
    const subPayload = Object.freeze({
      agentId: rec.agentId,
      capabilities: Object.freeze([...rec.capabilities]),
      version: rec.version,
    });
    for (const listener of listeners) {
      listener(subPayload);
    }
    return agentId;
  }

  /** Announce every pending entry whose debounce window has lapsed. */
  function fireDue() {
    const now = clock();
    const fired = [];
    for (const [agentId, entry] of pending) {
      if (now >= entry.dueAt) {
        fire(agentId);
        fired.push(agentId);
      }
    }
    return fired;
  }

  const broadcast = {
    get debounceMs() {
      return debounceMs;
    },

    /** Number of agents with a pending (not yet announced) capability change. */
    get pendingCount() {
      return pending.size;
    },

    /**
     * Record a capability change for an agent (debounced). Rapid successive
     * calls within the window coalesce: only the latest set is announced.
     * A set identical to the last announced set is a no-op (dedupe).
     * Returns { agentId, announced, pending, version } where `announced` is
     * true if the call itself caused an actual announce (it fired due work),
     * `pending` is true if a change is now waiting, and `version` is the
     * current announced version (0 when never announced).
     */
    announceCaps(agentId, capabilities) {
      assertAgentId(agentId);
      const caps = canonicalCaps(capabilities);
      const fired = fireDue();
      const current = agents.get(agentId);
      if (current && sameSet(caps, current.capabilities)) {
        // Unchanged vs the last announced set: drop any pending, announce nothing.
        pending.delete(agentId);
        return {
          agentId,
          announced: fired.length > 0,
          pending: false,
          version: current.version,
        };
      }
      pending.set(agentId, { latest: caps, dueAt: clock() + debounceMs });
      return {
        agentId,
        announced: fired.length > 0,
        pending: true,
        version: current?.version ?? 0,
      };
    },

    /**
     * Force every pending change to announce immediately, regardless of the
     * window. Returns the agentIds announced, in pending order.
     */
    flush() {
      const announced = [];
      for (const agentId of [...pending.keys()]) {
        fire(agentId);
        announced.push(agentId);
      }
      return announced;
    },

    /** Latest known record for an agent (frozen); throws CB_NOT_FOUND if unknown. */
    view(agentId) {
      assertAgentId(agentId);
      const rec = agents.get(agentId);
      if (!rec) {
        throw cbError('CB_NOT_FOUND', `No announced capabilities for agent: ${agentId}`, {
          agentId,
        });
      }
      return rec;
    },

    /**
     * Subscribe a listener called with { agentId, capabilities, version } on
     * each actual announce. Returns an unsubscribe function (idempotent).
     */
    subscribe(listener) {
      if (typeof listener !== 'function') {
        throw cbError(
          'CB_INVALID_SUBSCRIBER',
          `subscribe listener must be a function, got: ${typeof listener}`,
          { listener },
        );
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        listeners.delete(listener);
        return true;
      };
    },

    /**
     * Drop agents whose last announced time is older than staleAfterMs
     * (per the injected clock). Never-announced pending entries count by
     * their scheduled time. Returns the dropped agentIds.
     */
    prune(staleAfterMs) {
      if (typeof staleAfterMs !== 'number' || !Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
        throw cbError(
          'CB_INVALID_PRUNE',
          `staleAfterMs must be a positive finite number, got: ${staleAfterMs}`,
          { staleAfterMs },
        );
      }
      fireDue();
      const now = clock();
      const dropped = [];
      for (const [agentId, rec] of agents) {
        if (now - rec.announcedAt > staleAfterMs) {
          agents.delete(agentId);
          pending.delete(agentId);
          dropped.push(agentId);
        }
      }
      for (const [agentId, entry] of pending) {
        if (!agents.has(agentId) && now - entry.dueAt > staleAfterMs) {
          pending.delete(agentId);
          dropped.push(agentId);
        }
      }
      return dropped;
    },
  };

  return Object.freeze(broadcast);
}

/**
 * Diff two capability lists: { added, removed }.
 * added   — in `next` but not in `prev` (next's order)
 * removed — in `prev` but not in `next` (prev's order)
 */
export function diffCaps(prev, next) {
  const a = canonicalCaps(prev);
  const b = canonicalCaps(next);
  const prevSet = new Set(a);
  const nextSet = new Set(b);
  return {
    added: b.filter((cap) => !prevSet.has(cap)),
    removed: a.filter((cap) => !nextSet.has(cap)),
  };
}
