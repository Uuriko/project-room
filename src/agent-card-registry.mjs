/**
 * agent-card-registry.mjs — Pure in-memory registry of A2A-style agent cards.
 *
 * Cards describe agents for agent-to-agent discovery: who they are, what they
 * can do, and where to reach them. Nothing here touches the network, the DOM,
 * localStorage, or any secret — it is a pure in-memory registry.
 *
 * Card shape:
 *   {
 *     agentId:      string   (required, ^[a-z][a-z0-9-]*$)
 *     name:         string   (required, non-empty)
 *     description:  string   (required)
 *     url:          string   (optional — the agent's A2A endpoint)
 *     capabilities: string[] (required, non-empty strings)
 *     skills:       string[] (required, non-empty strings)
 *     version:      string   (required, semver-ish: major.minor.patch[-suffix])
 *     publishedAt:  number   (optional; defaults to the injected clock)
 *     signature:    string   (optional)
 *   }
 *
 * Dependency injection (all via the `deps` parameter of createAgentCardRegistry):
 *   - clock: () => number  (ms epoch; default: Date.now)
 *
 * Versioning: republishing an agentId with a strictly higher version replaces
 * the stored card; equal-or-lower versions are rejected as stale.
 *
 * Withdrawal leaves a tombstone: the card stays out of list() and search(),
 * and get() throws ACR_WITHDRAWN. Republishing with a higher version after a
 * withdraw resurrects the card.
 *
 * SIGNATURE NOTE: verify() only checks structure — it notes whether a
 * signature string is present but never cryptographically verifies it. Real
 * signature verification is the caller's responsibility (out of scope here:
 * this module does no crypto and reads no keys).
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   ACR_INVALID_CARD    — card fails structural validation
 *   ACR_STALE_VERSION   — republish with a version not strictly higher
 *   ACR_NOT_FOUND       — unknown agentId
 *   ACR_WITHDRAWN       — card exists but was withdrawn
 * Failures are never silent.
 */

const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Throw a coded registry error (never silent failures). */
function registryError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Compare two semver-ish versions: -1, 0, or 1. */
function compareVersions(a, b) {
  const core = (v) => v.split('-')[0].split('.').map(Number);
  const ac = core(a);
  const bc = core(b);
  for (let i = 0; i < 3; i += 1) {
    if (ac[i] !== bc[i]) return ac[i] < bc[i] ? -1 : 1;
  }
  const as = a.includes('-');
  const bs = b.includes('-');
  if (as === bs) return 0;
  return as ? -1 : 1; // release > prerelease
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0);
}

/**
 * Structural validation. Returns an array of human-readable problems
 * (empty when the card is valid).
 */
function validateCardStructure(card) {
  const problems = [];
  if (card === null || typeof card !== 'object') return ['card must be an object'];
  if (typeof card.agentId !== 'string' || !AGENT_ID_PATTERN.test(card.agentId)) {
    problems.push('agentId must match ^[a-z][a-z0-9-]*$');
  }
  if (typeof card.name !== 'string' || card.name.length === 0) {
    problems.push('name must be a non-empty string');
  }
  if (typeof card.description !== 'string') {
    problems.push('description must be a string');
  }
  if (card.url !== undefined && typeof card.url !== 'string') {
    problems.push('url must be a string when present');
  }
  if (!isStringArray(card.capabilities)) {
    problems.push('capabilities must be an array of non-empty strings');
  }
  if (!isStringArray(card.skills)) {
    problems.push('skills must be an array of non-empty strings');
  }
  if (typeof card.version !== 'string' || !VERSION_PATTERN.test(card.version)) {
    problems.push('version must be semver-ish (major.minor.patch[-suffix])');
  }
  if (card.publishedAt !== undefined && (typeof card.publishedAt !== 'number' || card.publishedAt < 0)) {
    problems.push('publishedAt must be a non-negative number when present');
  }
  if (card.signature !== undefined && typeof card.signature !== 'string') {
    problems.push('signature must be a string when present');
  }
  return problems;
}

/** Return a deep-frozen snapshot copy of a stored card. */
function freezeCard(card) {
  return Object.freeze({
    agentId: card.agentId,
    name: card.name,
    description: card.description,
    url: card.url,
    capabilities: Object.freeze([...card.capabilities]),
    skills: Object.freeze([...card.skills]),
    version: card.version,
    publishedAt: card.publishedAt,
    signature: card.signature,
  });
}

/**
 * Create a new agent card registry.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 */
export function createAgentCardRegistry(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());

  /** Internal records keyed by agentId: {card, withdrawn, withdrawnAt}. */
  const records = new Map();

  function getRecordOrThrow(agentId) {
    const record = records.get(agentId);
    if (!record) {
      throw registryError('ACR_NOT_FOUND', `Unknown agentId: ${agentId}`, { agentId });
    }
    return record;
  }

  function assertCardValid(card) {
    const problems = validateCardStructure(card);
    if (problems.length > 0) {
      throw registryError('ACR_INVALID_CARD', `Invalid agent card: ${problems.join('; ')}`, {
        agentId: card?.agentId,
        problems,
      });
    }
  }

  const registry = {
    /**
     * Publish (or republish) an agent card. A republish with a strictly
     * higher version replaces the stored card (and resurrects a withdrawn
     * one); an equal-or-lower version throws ACR_STALE_VERSION.
     */
    publish(card) {
      assertCardValid(card);
      const existing = records.get(card.agentId);
      if (existing && compareVersions(card.version, existing.card.version) <= 0) {
        throw registryError(
          'ACR_STALE_VERSION',
          `Card for ${card.agentId} at version ${card.version} is not newer than stored version ${existing.card.version}`,
          { agentId: card.agentId, presented: card.version, stored: existing.card.version },
        );
      }
      const stored = {
        agentId: card.agentId,
        name: card.name,
        description: card.description,
        url: card.url,
        capabilities: [...card.capabilities],
        skills: [...card.skills],
        version: card.version,
        publishedAt: card.publishedAt ?? clock(),
        signature: card.signature,
      };
      records.set(card.agentId, {
        card: stored,
        withdrawn: false,
        withdrawnAt: null,
      });
      return freezeCard(stored);
    },

    /** Fetch a card by agentId. Withdrawn cards throw ACR_WITHDRAWN. */
    get(agentId) {
      const record = getRecordOrThrow(agentId);
      if (record.withdrawn) {
        throw registryError('ACR_WITHDRAWN', `Card for ${agentId} was withdrawn`, { agentId });
      }
      return freezeCard(record.card);
    },

    /**
     * List all live cards, optionally filtered to one capability.
     * Withdrawn cards are hidden.
     */
    list({ capability } = {}) {
      const out = [];
      for (const record of records.values()) {
        if (record.withdrawn) continue;
        if (capability !== undefined && !record.card.capabilities.includes(capability)) continue;
        out.push(freezeCard(record.card));
      }
      return Object.freeze(out);
    },

    /**
     * Withdraw a card: leaves a tombstone so get() throws ACR_WITHDRAWN and
     * the card disappears from list() and search().
     */
    withdraw(agentId) {
      const record = getRecordOrThrow(agentId);
      if (record.withdrawn) {
        throw registryError('ACR_WITHDRAWN', `Card for ${agentId} was already withdrawn`, { agentId });
      }
      record.withdrawn = true;
      record.withdrawnAt = clock();
      return { agentId, withdrawnAt: record.withdrawnAt };
    },

    /**
     * Structural check only. Returns {valid, problems, signaturePresent,
     * signatureVerified: false}. The signature is NEVER cryptographically
     * verified here — presence is only noted.
     */
    verify(card) {
      const problems = validateCardStructure(card);
      return {
        valid: problems.length === 0,
        problems,
        signaturePresent: typeof card === 'object' && card !== null && typeof card.signature === 'string',
        signatureVerified: false,
      };
    },

    /**
     * Case-insensitive substring search across agentId, name, description,
     * capabilities, and skills. Withdrawn cards are excluded.
     */
    search(query) {
      const q = String(query ?? '').toLowerCase();
      if (q.length === 0) return Object.freeze([]);
      const out = [];
      for (const record of records.values()) {
        if (record.withdrawn) continue;
        const card = record.card;
        const haystack = [card.agentId, card.name, card.description, ...card.capabilities, ...card.skills]
          .join('\n')
          .toLowerCase();
        if (haystack.includes(q)) out.push(freezeCard(card));
      }
      return Object.freeze(out);
    },
  };

  return Object.freeze(registry);
}
