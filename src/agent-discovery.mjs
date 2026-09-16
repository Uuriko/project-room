/**
 * agent-discovery.mjs — Pure A2A agent discovery planner (B029-2, quill-s2).
 *
 * Discovers candidate agents for a task from an injected capability-card
 * registry. Nothing here touches the network, the DOM, localStorage, or any
 * secret — it is a pure planning/ranking function over registry data.
 *
 * Discovery model:
 *   - Query: { capabilities: string[], skills?: string[], excludeAgentIds?: string[], limit?: number }
 *   - Every card is duck-typed: capabilities come from `card.capabilities` when
 *     present, otherwise from the union of `card.lanes` and `card.tools`
 *     (the server/cap-cards.mjs card shape). Skills come from `card.skills`
 *     when present, otherwise [].
 *   - score = matched required capabilities / total required capabilities
 *     (capability coverage ratio). An agent needs at least one capability
 *     match to be eligible; when `skills` is given, the agent must hold ALL
 *     requested skills to be eligible.
 *   - Ranked: score descending, then card version descending, then agentId
 *     ascending. `limit` caps the returned list.
 *
 * Dependency injection (all via the `deps` parameter of createAgentDiscovery):
 *   - cardRegistry: the B028-2 registry shape, duck-typed — never imported.
 *     Enumeration tries, in order: registry.list(), registry.all(),
 *     registry as a Map, registry.cards as a Map.
 *   - clock:       () => number  (ms epoch; default: Date.now)
 *   - cacheTtlMs:  number        (query-result cache TTL; default: 60_000)
 *
 * Cache: query results are cached per canonicalized query and invalidated on
 * TTL expiry. When the registry emits change events (duck-typed as
 * registry.on?.('change', ...)), the cache is invalidated on every change
 * event; registries without `on` (e.g. server/cap-cards.mjs) degrade
 * gracefully to TTL-only invalidation.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   AD_NO_REGISTRY        — createAgentDiscovery called without a cardRegistry
 *   AD_INVALID_QUERY      — malformed query or taskDescription
 *   AD_REGISTRY_UNSUPPORTED — cardRegistry cannot enumerate cards
 *   AD_NO_MATCH           — no agent matched at least one required capability
 * Failures are never silent.
 */

export const DEFAULT_CACHE_TTL_MS = 60 * 1000;

export const DISCOVERY_ERROR_CODES = Object.freeze([
  'AD_NO_REGISTRY',
  'AD_INVALID_QUERY',
  'AD_REGISTRY_UNSUPPORTED',
  'AD_NO_MATCH',
]);

/** Throw a coded discovery error (never silent failures). */
function discoveryError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Duck-typed enumeration of every card in the injected registry. */
function getAllCards(cardRegistry) {
  if (cardRegistry == null || typeof cardRegistry !== 'object') {
    throw discoveryError(
      'AD_REGISTRY_UNSUPPORTED',
      'cardRegistry must be an object that can enumerate capability cards',
    );
  }
  if (typeof cardRegistry.list === 'function') return [...cardRegistry.list()];
  if (typeof cardRegistry.all === 'function') return [...cardRegistry.all()];
  if (cardRegistry instanceof Map) return [...cardRegistry.values()];
  if (cardRegistry.cards instanceof Map) return [...cardRegistry.cards.values()];
  throw discoveryError(
    'AD_REGISTRY_UNSUPPORTED',
    'cardRegistry exposes no card enumeration (tried list(), all(), Map, cards Map)',
  );
}

/** Capability set of a card, duck-typed across card shapes. */
function cardCapabilities(card) {
  if (Array.isArray(card.capabilities)) return new Set(card.capabilities);
  const caps = new Set();
  for (const field of ['lanes', 'tools']) {
    if (Array.isArray(card[field])) {
      for (const cap of card[field]) caps.add(cap);
    }
  }
  return caps;
}

/** Skill set of a card, duck-typed (defaults to empty). */
function cardSkills(card) {
  return Array.isArray(card.skills) ? new Set(card.skills) : new Set();
}

/** Card version for tie-breaking (defaults to 0). */
function cardVersion(card) {
  const v = Number(card.version);
  return Number.isFinite(v) ? v : 0;
}

function assertNonEmptyStringArray(value, name) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v === '')) {
    throw discoveryError(
      'AD_INVALID_QUERY',
      `${name} must be an array of non-empty strings`,
      { [name]: value },
    );
  }
}

/** Canonicalize + validate a discover() query; throws AD_INVALID_QUERY. */
function normalizeQuery(query) {
  if (query == null || typeof query !== 'object') {
    throw discoveryError('AD_INVALID_QUERY', 'query must be an object', { query });
  }
  assertNonEmptyStringArray(query.capabilities, 'capabilities');
  if (query.capabilities.length === 0) {
    throw discoveryError('AD_INVALID_QUERY', 'query.capabilities must list at least one capability');
  }
  const skills = query.skills ?? [];
  assertNonEmptyStringArray(skills, 'skills');
  const excludeAgentIds = query.excludeAgentIds ?? [];
  assertNonEmptyStringArray(excludeAgentIds, 'excludeAgentIds');
  let limit = null;
  if (query.limit !== undefined && query.limit !== null) {
    if (!Number.isInteger(query.limit) || query.limit < 1) {
      throw discoveryError(
        'AD_INVALID_QUERY',
        'query.limit must be a positive integer when given',
        { limit: query.limit },
      );
    }
    limit = query.limit;
  }
  return Object.freeze({
    capabilities: Object.freeze([...query.capabilities]),
    skills: Object.freeze([...skills]),
    excludeAgentIds: Object.freeze([...excludeAgentIds]),
    limit,
  });
}

/** Deterministic cache key for a normalized query (field order fixed). */
function cacheKey(normalized) {
  return JSON.stringify({
    capabilities: normalized.capabilities,
    skills: [...normalized.skills].sort(),
    excludeAgentIds: [...normalized.excludeAgentIds].sort(),
    limit: normalized.limit,
  });
}

/**
 * Create an A2A agent discovery planner.
 * @param {object} [deps]
 * @param {object} [deps.cardRegistry]  injected capability-card registry (required)
 * @param {() => number} [deps.clock]   ms epoch source (default: Date.now)
 * @param {number} [deps.cacheTtlMs]    query-result cache TTL (default: 60_000)
 */
export function createAgentDiscovery(deps = {}) {
  const { cardRegistry = null, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = deps;
  if (cardRegistry == null) {
    throw discoveryError('AD_NO_REGISTRY', 'createAgentDiscovery requires deps.cardRegistry');
  }
  const clock = deps.clock ?? (() => Date.now());

  /** Query-result cache: key → { cachedAt, result }. */
  const cache = new Map();
  const stats = { queries: 0, hits: 0, misses: 0 };

  function clearCache() {
    cache.clear();
  }

  // Invalidate on registry change events when the registry emits them.
  // Registries without `on` (e.g. server/cap-cards.mjs) degrade gracefully
  // to TTL-only invalidation; a throwing `on` never breaks discovery.
  try {
    if (typeof cardRegistry.on === 'function') {
      cardRegistry.on('change', clearCache);
    }
  } catch {
    // Degrade to TTL-only invalidation.
  }

  /**
   * Rank agents for a query: [{ agentId, score, matchedCapabilities, card }].
   * Throws AD_NO_MATCH when no agent matches at least one required
   * capability; throws AD_INVALID_QUERY / AD_REGISTRY_UNSUPPORTED otherwise.
   */
  function discover(query) {
    const normalized = normalizeQuery(query);
    stats.queries += 1;
    const key = cacheKey(normalized);
    const now = clock();
    const entry = cache.get(key);
    if (entry && now - entry.cachedAt <= cacheTtlMs) {
      stats.hits += 1;
      return [...entry.result];
    }

    let cards;
    try {
      cards = getAllCards(cardRegistry);
    } catch (err) {
      // Keep the coded-error contract even when a registry's list() misbehaves.
      if (err instanceof Error && typeof err.code === 'string') throw err;
      throw discoveryError('AD_REGISTRY_UNSUPPORTED', 'cardRegistry enumeration failed', {
        cause: String(err && err.message ? err.message : err),
      });
    }
    const excluded = new Set(normalized.excludeAgentIds);
    const ranked = [];
    for (const card of cards) {
      if (card == null || typeof card !== 'object') continue;
      const agentId = card.agentId;
      if (typeof agentId !== 'string' || agentId === '') continue;
      if (excluded.has(agentId)) continue;
      const matched = normalized.capabilities.filter((cap) => cardCapabilities(card).has(cap));
      if (matched.length === 0) continue;
      if (normalized.skills.length > 0) {
        const have = cardSkills(card);
        if (!normalized.skills.every((skill) => have.has(skill))) continue;
      }
      ranked.push(Object.freeze({
        agentId,
        score: matched.length / normalized.capabilities.length,
        matchedCapabilities: Object.freeze([...matched].sort()),
        card,
      }));
    }

    if (ranked.length === 0) {
      throw discoveryError(
        'AD_NO_MATCH',
        `No agent matched any of the required capabilities: ${normalized.capabilities.join(', ')}`,
        { capabilities: [...normalized.capabilities] },
      );
    }

    // Rank: coverage score desc, then card version desc, then agentId asc.
    ranked.sort((a, b) => (
      b.score - a.score
      || cardVersion(b.card) - cardVersion(a.card)
      || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0)
    ));

    const result = Object.freeze(
      normalized.limit == null ? ranked : ranked.slice(0, normalized.limit),
    );
    cache.set(key, { cachedAt: now, result });
    stats.misses += 1;
    return [...result];
  }

  /**
   * Convenience wrapper: discover agents for a natural-language task
   * description given the required capability list.
   */
  function findForTask(taskDescription, requiredCaps) {
    if (typeof taskDescription !== 'string' || taskDescription.trim() === '') {
      throw discoveryError(
        'AD_INVALID_QUERY',
        'findForTask requires a non-empty taskDescription string',
        { taskDescription },
      );
    }
    return discover({ capabilities: requiredCaps });
  }

  const discovery = {
    /** Ranked agent discovery for a capability query (throws coded errors). */
    discover,
    /** Convenience wrapper: discover agents for a task description. */
    findForTask,
    /** Drop every cached query result. */
    clearCache,
    /** Lifetime counters: { queries, hits, misses }. */
    stats() {
      return { ...stats };
    },
    /** Current number of cached query results. */
    get cacheSize() {
      return cache.size;
    },
    get cacheTtlMs() {
      return cacheTtlMs;
    },
  };

  return Object.freeze(discovery);
}
