/**
 * mcp-scope-enforcement.mjs — Pure per-agent MCP auth scope enforcement engine.
 *
 * Policy model:
 *   Each agent holds a scope grant:
 *     { agentId, tools: [{ tool, allow: true|false, constraints? }], grantedAt, expiresAt? }
 *   Constraints (optional, per tool entry):
 *     - channels:  string[]   — allowlist; calls carrying a `channel` arg must
 *                                 name a channel on the list.
 *     - maxLimit:   number     — cap; calls carrying a numeric `limit` arg are
 *                                 denied when limit > maxLimit.
 *     - readOnly:   boolean    — when true, write tools are blocked (see
 *                                 WRITE_VERBS below; always includes `room.post`).
 *
 *   check(agentId, tool, args) → { allowed: boolean, reason: string }
 *     Evaluation order (deny by default, never silent):
 *       1. Unknown agent                → denied ('unknown-agent')
 *       2. Expired grant                → denied ('grant-expired')
 *       3. Explicit deny entry matches  → denied ('explicit-deny') — deny BEATS allow
 *       4. No allow entry matches      → denied ('no-scope-for-tool')
 *       5. Any matching allow entry's constraint violated → denied
 *          ('channel-not-allowed' | 'limit-exceeded' | 'read-only')
 *       6. Otherwise                    → allowed ('ok')
 *     Tool matching: exact tool name, or a grant entry with tool '*' which
 *     matches any tool name. Constraints from every matching allow entry apply
 *     (strictest wins).
 *
 *   enforce(agentId, tool, args) — same evaluation, but throws on denial
 *     instead of returning { allowed: false }.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret — it
 * is a pure in-memory policy engine. Grant records are never written to disk
 * by this module; snapshot()/restore() provide pure state capture/replay for
 * testability and operator tooling.
 *
 * Dependency injection (all via the `deps` parameter of createScopeEnforcer):
 *   - clock: () => number  (ms epoch; default: Date.now)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   SE_UNKNOWN_AGENT      — grant/revoke/update/get on an agent with no grant
 *   SE_GRANT_EXISTS       — grant() called for an agent that already has one
 *   SE_INVALID_GRANT      — malformed grant descriptor or update patch
 *   SE_SCOPE_DENIED       — enforce() policy denial (check() instead returns
 *                           { allowed: false, reason })
 *   SE_GRANT_EXPIRED      — enforce() against an expired grant (check() instead
 *                           returns { allowed: false, reason: 'grant-expired' })
 *   SE_INVALID_INPUT      — malformed check() input (empty agentId/tool)
 * Failures are never silent: policy denies default to { allowed: false }.
 */

/** Tool-name tail segments that count as a write for readOnly grants. */
const WRITE_VERBS = new Set([
  'post',
  'write',
  'create',
  'update',
  'delete',
  'remove',
  'edit',
  'reply',
  'send',
  'publish',
]);

/** Throw a coded scope-enforcement error (never silent failures). */
function scopeError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Validate one tool-entry descriptor; returns a normalized copy. */
function normalizeToolEntry(entry, index) {
  if (!isPlainObject(entry)) {
    throw scopeError('SE_INVALID_GRANT', `tools[${index}] must be an object`, { index });
  }
  if (!isNonEmptyString(entry.tool)) {
    throw scopeError('SE_INVALID_GRANT', `tools[${index}].tool must be a non-empty string`, {
      index,
    });
  }
  if (typeof entry.allow !== 'boolean') {
    throw scopeError('SE_INVALID_GRANT', `tools[${index}].allow must be a boolean`, { index });
  }
  let constraints;
  if (entry.constraints !== undefined) {
    if (!isPlainObject(entry.constraints)) {
      throw scopeError('SE_INVALID_GRANT', `tools[${index}].constraints must be an object`, {
        index,
      });
    }
    const { channels, maxLimit, readOnly } = entry.constraints;
    constraints = {};
    if (channels !== undefined) {
      if (!Array.isArray(channels) || !channels.every(isNonEmptyString)) {
        throw scopeError(
          'SE_INVALID_GRANT',
          `tools[${index}].constraints.channels must be an array of non-empty strings`,
          { index },
        );
      }
      constraints.channels = [...channels];
    }
    if (maxLimit !== undefined) {
      if (typeof maxLimit !== 'number' || !Number.isFinite(maxLimit) || maxLimit < 0) {
        throw scopeError(
          'SE_INVALID_GRANT',
          `tools[${index}].constraints.maxLimit must be a finite number >= 0`,
          { index },
        );
      }
      constraints.maxLimit = maxLimit;
    }
    if (readOnly !== undefined) {
      if (typeof readOnly !== 'boolean') {
        throw scopeError(
          'SE_INVALID_GRANT',
          `tools[${index}].constraints.readOnly must be a boolean`,
          { index },
        );
      }
      constraints.readOnly = readOnly;
    }
  }
  return {
    tool: entry.tool,
    allow: entry.allow,
    ...(constraints ? { constraints } : {}),
  };
}

/** Validate a full grant descriptor; returns a normalized copy. */
function normalizeGrant(agentId, grant) {
  if (!isPlainObject(grant)) {
    throw scopeError('SE_INVALID_GRANT', `Grant for agent '${agentId}' must be an object`);
  }
  if (!Array.isArray(grant.tools) || grant.tools.length === 0) {
    throw scopeError('SE_INVALID_GRANT', `Grant for agent '${agentId}' needs a non-empty tools array`);
  }
  const tools = grant.tools.map((entry, index) => normalizeToolEntry(entry, index));
  const grantedAt = grant.grantedAt;
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) {
    throw scopeError('SE_INVALID_GRANT', `Grant for agent '${agentId}' needs a numeric grantedAt`);
  }
  let expiresAt;
  if (grant.expiresAt !== undefined) {
    if (typeof grant.expiresAt !== 'number' || !Number.isFinite(grant.expiresAt)) {
      throw scopeError('SE_INVALID_GRANT', `Grant for agent '${agentId}' has a non-numeric expiresAt`);
    }
    if (grant.expiresAt <= grantedAt) {
      throw scopeError(
        'SE_INVALID_GRANT',
        `Grant for agent '${agentId}': expiresAt must be after grantedAt`,
      );
    }
    expiresAt = grant.expiresAt;
  }
  return {
    agentId,
    tools,
    grantedAt,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

/** Last dotted/colon/slash segment of a tool name, lower-cased. */
function toolVerb(tool) {
  return String(tool).split(/[.:/]/).pop().toLowerCase();
}

/** Does a grant entry's tool pattern match the requested tool? */
function entryMatches(entryTool, tool) {
  return entryTool === '*' || entryTool === tool;
}

/**
 * Create a new per-agent MCP auth scope enforcement engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 */
export function createScopeEnforcer(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());

  /** Grant records keyed by agentId. */
  const grants = new Map();

  /** Append-only audit log: every check() lands here, never removed. */
  const audit = [];

  function auditCheck({ agentId, tool, allowed, reason }) {
    const entry = Object.freeze({
      agentId,
      tool,
      allowed,
      reason,
      at: clock(),
    });
    audit.push(entry);
    return entry;
  }

  function getGrantOrThrow(agentId) {
    const grant = grants.get(agentId);
    if (!grant) {
      throw scopeError('SE_UNKNOWN_AGENT', `No scope grant for agent: ${agentId}`, { agentId });
    }
    return grant;
  }

  function isExpired(grant) {
    return grant.expiresAt !== undefined && clock() > grant.expiresAt;
  }

  /** Evaluate one constraint set against args; returns a deny reason or null. */
  function constraintViolation(constraints, tool, args) {
    if (!constraints) return null;
    if (constraints.readOnly && WRITE_VERBS.has(toolVerb(tool))) {
      return 'read-only';
    }
    if (constraints.channels !== undefined) {
      const channel = args?.channel;
      if (!isNonEmptyString(channel) || !constraints.channels.includes(channel)) {
        return 'channel-not-allowed';
      }
    }
    if (constraints.maxLimit !== undefined) {
      const limit = args?.limit;
      if (typeof limit === 'number' && limit > constraints.maxLimit) {
        return 'limit-exceeded';
      }
    }
    return null;
  }

  /** Core evaluation: returns { allowed, reason }, never throws for policy. */
  function evaluate(agentId, tool, args) {
    const grant = grants.get(agentId);
    if (!grant) return { allowed: false, reason: 'unknown-agent' };
    if (isExpired(grant)) return { allowed: false, reason: 'grant-expired' };

    const matching = grant.tools.filter((entry) => entryMatches(entry.tool, tool));

    // Explicit deny beats allow — checked first.
    if (matching.some((entry) => entry.allow === false)) {
      return { allowed: false, reason: 'explicit-deny' };
    }

    const allowing = matching.filter((entry) => entry.allow === true);
    if (allowing.length === 0) {
      return { allowed: false, reason: 'no-scope-for-tool' };
    }

    // Constraints from every matching allow entry apply (strictest wins).
    for (const entry of allowing) {
      const violation = constraintViolation(entry.constraints, tool, args);
      if (violation) return { allowed: false, reason: violation };
    }

    return { allowed: true, reason: 'ok' };
  }

  function grantSnapshot(grant) {
    return Object.freeze({
      agentId: grant.agentId,
      tools: Object.freeze(
        grant.tools.map((entry) =>
          Object.freeze({
            tool: entry.tool,
            allow: entry.allow,
            ...(entry.constraints
              ? { constraints: Object.freeze({ ...entry.constraints }) }
              : {}),
          }),
        ),
      ),
      grantedAt: grant.grantedAt,
      ...(grant.expiresAt !== undefined ? { expiresAt: grant.expiresAt } : {}),
    });
  }

  const enforcer = {
    /** Append-only audit trail of every check(): {agentId, tool, allowed, reason, at}. */
    get audit() {
      return [...audit];
    },

    /**
     * Record a scope grant for an agent. Throws SE_GRANT_EXISTS if the agent
     * already holds a grant (use update()), SE_INVALID_GRANT on bad input.
     */
    grant(agentId, grant) {
      if (!isNonEmptyString(agentId)) {
        throw scopeError('SE_INVALID_GRANT', 'grant() requires a non-empty agentId');
      }
      if (grants.has(agentId)) {
        throw scopeError('SE_GRANT_EXISTS', `Agent '${agentId}' already has a grant (use update())`, {
          agentId,
        });
      }
      const normalized = normalizeGrant(agentId, grant);
      grants.set(agentId, normalized);
      return grantSnapshot(normalized);
    },

    /**
     * Remove an agent's grant entirely. Throws SE_UNKNOWN_AGENT when the
     * agent holds no grant.
     */
    revoke(agentId) {
      const grant = getGrantOrThrow(agentId);
      grants.delete(agentId);
      return grantSnapshot(grant);
    },

    /**
     * Replace parts of an agent's grant: { tools?, expiresAt? } (expiresAt may
     * be set to null to remove expiry). Throws SE_UNKNOWN_AGENT when the
     * agent holds no grant, SE_INVALID_GRANT on bad input.
     */
    update(agentId, patch) {
      const current = getGrantOrThrow(agentId);
      if (!isPlainObject(patch)) {
        throw scopeError('SE_INVALID_GRANT', `Update patch for agent '${agentId}' must be an object`);
      }
      const next = {
        agentId: current.agentId,
        tools: patch.tools !== undefined ? patch.tools : current.tools,
        grantedAt: current.grantedAt,
      };
      if (patch.expiresAt !== undefined) {
        if (patch.expiresAt !== null) next.expiresAt = patch.expiresAt;
      } else if (current.expiresAt !== undefined) {
        next.expiresAt = current.expiresAt;
      }
      const normalized = normalizeGrant(agentId, next);
      grants.set(agentId, normalized);
      return grantSnapshot(normalized);
    },

    /** Read-only snapshot of an agent's grant (null when unknown). */
    get(agentId) {
      const grant = grants.get(agentId);
      return grant ? grantSnapshot(grant) : null;
    },

    /** Agent ids that currently hold a grant. */
    listAgents() {
      return [...grants.keys()];
    },

    /**
     * Evaluate a tool call against the agent's grant. Never throws for policy
     * outcomes — every evaluation (allowed or denied) is appended to the audit
     * log and returned as a frozen { allowed, reason }. Throws SE_INVALID_INPUT
     * for malformed inputs.
     */
    check(agentId, tool, args) {
      if (!isNonEmptyString(agentId)) {
        throw scopeError('SE_INVALID_INPUT', 'check() requires a non-empty agentId string');
      }
      if (!isNonEmptyString(tool)) {
        throw scopeError('SE_INVALID_INPUT', 'check() requires a non-empty tool string');
      }
      const { allowed, reason } = evaluate(agentId, tool, args);
      const result = Object.freeze({ allowed, reason });
      auditCheck({ agentId, tool, allowed, reason });
      return result;
    },

    /**
     * Like check(), but throws SE_SCOPE_DENIED (or SE_GRANT_EXPIRED) on denial
     * instead of returning { allowed: false }. Returns the frozen result on
     * allowance.
     */
    enforce(agentId, tool, args) {
      const result = this.check(agentId, tool, args);
      if (!result.allowed) {
        if (result.reason === 'grant-expired') {
          throw scopeError(
            'SE_GRANT_EXPIRED',
            `Scope grant for agent '${agentId}' has expired`,
            { agentId, tool },
          );
        }
        throw scopeError(
          'SE_SCOPE_DENIED',
          `Agent '${agentId}' is denied tool '${tool}' (${result.reason})`,
          { agentId, tool, reason: result.reason },
        );
      }
      return result;
    },

    /**
     * Pure state capture: frozen plain-data snapshot of all grants and the
     * audit log. No storage dependency — the engine stays in-memory.
     */
    snapshot() {
      return Object.freeze({
        grants: Object.freeze([...grants.values()].map((grant) => grantSnapshot(grant))),
        audit: Object.freeze(audit.map((entry) => Object.freeze({ ...entry }))),
      });
    },

    /**
     * Restore engine state from a snapshot() payload. Replaces all grants and
     * the audit log. Throws SE_INVALID_GRANT when any grant entry is malformed.
     */
    restore(state) {
      if (!isPlainObject(state) || !Array.isArray(state.grants) || !Array.isArray(state.audit)) {
        throw scopeError('SE_INVALID_GRANT', 'restore() requires { grants: [], audit: [] }');
      }
      const nextGrants = new Map();
      for (const grant of state.grants) {
        if (!isPlainObject(grant) || !isNonEmptyString(grant.agentId)) {
          throw scopeError('SE_INVALID_GRANT', 'restore() grant entry needs an agentId');
        }
        nextGrants.set(grant.agentId, normalizeGrant(grant.agentId, grant));
      }
      const nextAudit = state.audit.map((entry) => {
        if (!isPlainObject(entry)) {
          throw scopeError('SE_INVALID_GRANT', 'restore() audit entry must be an object');
        }
        return Object.freeze({
          agentId: entry.agentId ?? null,
          tool: entry.tool ?? null,
          allowed: entry.allowed === true,
          reason: entry.reason ?? 'unknown',
          at: entry.at ?? 0,
        });
      });
      grants.clear();
      for (const [agentId, grant] of nextGrants) grants.set(agentId, grant);
      audit.length = 0;
      audit.push(...nextAudit);
    },
  };

  return Object.freeze(enforcer);
}
