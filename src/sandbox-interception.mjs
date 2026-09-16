/**
 * sandbox-interception.mjs — Pure dry-run interception planner for agent sandbox actions.
 *
 * Nothing here executes anything real. An agent proposes an action, the planner
 * decides a verdict — allow, deny, or modify — and records the interception in
 * an append-only ledger. Production wiring would run the verdict through a real
 * executor; this module only plans verdicts.
 *
 * Action shape:
 *   { id, agentId, kind, target, args, proposedAt }
 *   - id / agentId / kind / target: non-empty strings
 *   - args: plain object (action parameters, e.g. { limit, items, channel })
 *   - proposedAt: number (ms epoch; optional — falls back to the injected clock)
 *
 * Injected policy (`deps.policy`):
 *   - allowlist:   { [agentId]: string[] }   — kinds each agent may perform
 *   - denylist:    (RegExp | string)[]       — target patterns that always deny
 *   - constraints: { [kind]: ArgConstraints } — arg limits per kind
 *       ArgConstraints: { maxItems?: number, allowedChannels?: string[] }
 *
 * Evaluation order per intercept(action):
 *   1. Denylist: target matches a denylist pattern        → deny
 *   2. Allowlist: kind not on the agent's allowlist        → deny (deny-by-default)
 *   3. Arg constraints: allowedChannels violated          → deny
 *      maxItems exceeded → modify (args.items clamped to maxItems, audit note)
 *   4. Otherwise                                          → allow
 *
 * Verdict shape:
 *   { verdict: 'allow' | 'deny' | 'modify',
 *     modifiedAction?: object,  // present only on 'modify'
 *     reason: string,
 *     matchedRule: { type: 'denylist' | 'allowlist' | 'constraint', ... } | null }
 *
 * Ledger: every interception is recorded as
 *   { ledgerId, action, verdict, reason, matchedRule, modifiedAction, at, replayOf }
 * The ledger is append-only — entries are frozen and never mutated or removed.
 * replay(ledgerId) re-evaluates the recorded action against the CURRENT policy
 * and records the result as a new entry linked via replayOf.
 *
 * Dependency injection (all via the `deps` parameter of createSandboxInterceptor):
 *   - clock:  () => number  (ms epoch; default: Date.now)
 *   - id:     () => string  (ledger entry id generator; default: per-interceptor counter)
 *   - policy: { allowlist, denylist, constraints } (default: empty — deny everything)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   SB_INVALID_ACTION — action is missing required fields or has a bad shape
 *   SB_NOT_FOUND      — replay() given an unknown ledger id
 *   SB_ACTION_DENIED  — thrown only by interceptStrict() when the verdict is deny
 * Failures are never silent.
 */

const VERDICTS = Object.freeze(['allow', 'deny', 'modify']);

export { VERDICTS };

/** Throw a coded sandbox error (never silent failures). */
function sandboxError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    return Object.freeze(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function cloneForLedger(value) {
  // Ledger snapshots must be immune to later caller mutation; the module is
  // pure, so a JSON round-trip is sufficient (actions are JSON-shaped).
  return JSON.parse(JSON.stringify(value));
}

function validateAction(action) {
  if (!isPlainObject(action)) {
    throw sandboxError('SB_INVALID_ACTION', 'Action must be a plain object', { action });
  }
  for (const field of ['id', 'agentId', 'kind', 'target']) {
    if (!isNonEmptyString(action[field])) {
      throw sandboxError(
        'SB_INVALID_ACTION',
        `Action.${field} must be a non-empty string`,
        { action: { id: action.id ?? null, agentId: action.agentId ?? null, kind: action.kind ?? null } },
      );
    }
  }
  if (!isPlainObject(action.args ?? {})) {
    throw sandboxError('SB_INVALID_ACTION', 'Action.args must be a plain object when present', {
      actionId: action.id,
    });
  }
  if (action.proposedAt !== undefined && typeof action.proposedAt !== 'number') {
    throw sandboxError('SB_INVALID_ACTION', 'Action.proposedAt must be a number when present', {
      actionId: action.id,
    });
  }
}

function normalizeDenylist(denylist) {
  if (denylist === undefined) return [];
  if (!Array.isArray(denylist)) {
    throw sandboxError('SB_INVALID_ACTION', 'Policy.denylist must be an array', {});
  }
  return denylist.map((pattern) => {
    if (pattern instanceof RegExp) return pattern;
    if (typeof pattern === 'string') return new RegExp(pattern);
    throw sandboxError('SB_INVALID_ACTION', 'Policy denylist patterns must be RegExp or string', {});
  });
}

/**
 * Create a dry-run sandbox interception planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {object} [deps.policy]
 * @param {object} [deps.policy.allowlist]   — { [agentId]: string[] }
 * @param {Array} [deps.policy.denylist]     — (RegExp | string)[]
 * @param {object} [deps.policy.constraints] — { [kind]: { maxItems?, allowedChannels? } }
 */
export function createSandboxInterceptor(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const policy = deps.policy ?? {};
  const allowlist = policy.allowlist ?? {};
  const denylist = normalizeDenylist(policy.denylist);
  const constraints = policy.constraints ?? {};

  let idCounter = 0;
  const newId = deps.id ?? (() => `sb-${(idCounter += 1)}`);

  /** Append-only interception ledger; entries are frozen. */
  const ledger = [];

  /** Per-agent counters: { [agentId]: { allowed, denied, modified } }. */
  const statsByAgent = new Map();

  function bumpStat(agentId, verdict) {
    let entry = statsByAgent.get(agentId);
    if (!entry) {
      entry = { allowed: 0, denied: 0, modified: 0 };
      statsByAgent.set(agentId, entry);
    }
    if (verdict === 'allow') entry.allowed += 1;
    else if (verdict === 'deny') entry.denied += 1;
    else entry.modified += 1;
  }

  function matchDenylist(target) {
    for (const pattern of denylist) {
      if (pattern.test(target)) return pattern;
    }
    return null;
  }

  function evaluate(action) {
    const args = action.args ?? {};

    // 1. Denylist: target patterns always deny, regardless of allowlist.
    const deniedPattern = matchDenylist(action.target);
    if (deniedPattern) {
      return {
        verdict: 'deny',
        reason: `target matched denylist pattern ${deniedPattern}`,
        matchedRule: { type: 'denylist', pattern: String(deniedPattern) },
      };
    }

    // 2. Allowlist: unknown kinds are denied by default.
    const allowedKinds = allowlist[action.agentId];
    if (!Array.isArray(allowedKinds) || !allowedKinds.includes(action.kind)) {
      return {
        verdict: 'deny',
        reason: `kind '${action.kind}' is not allowlisted for agent '${action.agentId}' (deny-by-default)`,
        matchedRule: { type: 'allowlist', agentId: action.agentId, kind: action.kind },
      };
    }

    // 3. Arg constraints.
    const constraint = constraints[action.kind];
    if (constraint) {
      const allowedChannels = constraint.allowedChannels;
      if (
        Array.isArray(allowedChannels) &&
        args.channel !== undefined &&
        !allowedChannels.includes(args.channel)
      ) {
        return {
          verdict: 'deny',
          reason: `channel '${args.channel}' is not in allowedChannels for kind '${action.kind}'`,
          matchedRule: {
            type: 'constraint',
            constraint: 'allowedChannels',
            kind: action.kind,
            allowedChannels: [...allowedChannels],
          },
        };
      }

      const maxItems = constraint.maxItems;
      const items = args.items;
      if (typeof maxItems === 'number' && Array.isArray(items) && items.length > maxItems) {
        const modifiedAction = {
          ...action,
          args: { ...args, items: items.slice(0, maxItems) },
        };
        return {
          verdict: 'modify',
          modifiedAction,
          reason: `items clamped from ${items.length} to maxItems=${maxItems} for kind '${action.kind}' (audit note: arg constraint applied in dry-run)`,
          matchedRule: { type: 'constraint', constraint: 'maxItems', kind: action.kind, maxItems },
        };
      }
    }

    // 4. Nothing matched: allow.
    return {
      verdict: 'allow',
      reason: `kind '${action.kind}' allowlisted for agent '${action.agentId}' and no policy rule blocked it`,
      matchedRule: null,
    };
  }

  function recordInterception({ action, verdict, reason, matchedRule, modifiedAction, replayOf }) {
    const entry = deepFreeze({
      ledgerId: newId(),
      action: cloneForLedger(action),
      verdict,
      reason,
      matchedRule: matchedRule ? cloneForLedger(matchedRule) : null,
      modifiedAction: modifiedAction ? cloneForLedger(modifiedAction) : null,
      at: clock(),
      replayOf: replayOf ?? null,
    });
    ledger.push(entry);
    bumpStat(action.agentId, verdict);
    return entry;
  }

  const interceptor = {
    /** Append-only interception ledger: {ledgerId, action, verdict, reason, matchedRule, modifiedAction, at, replayOf}. */
    get ledger() {
      return [...ledger];
    },

    /**
     * Intercept a proposed action in dry-run mode. Returns the verdict object
     * { verdict, modifiedAction?, reason, matchedRule }. Nothing is executed.
     * Every call is recorded in the ledger.
     */
    intercept(action) {
      validateAction(action);
      const result = evaluate(action);
      const entry = recordInterception({ action, ...result });
      return {
        ledgerId: entry.ledgerId,
        verdict: entry.verdict,
        ...(entry.modifiedAction ? { modifiedAction: entry.modifiedAction } : {}),
        reason: entry.reason,
        matchedRule: entry.matchedRule,
        at: entry.at,
      };
    },

    /**
     * Strict variant of intercept(): throws SB_ACTION_DENIED when the verdict
     * is deny, so callers that cannot proceed on a denial fail loudly.
     */
    interceptStrict(action) {
      const result = this.intercept(action);
      if (result.verdict === 'deny') {
        throw sandboxError(
          'SB_ACTION_DENIED',
          `Action ${action.id} denied by sandbox policy: ${result.reason}`,
          { actionId: action.id, ledgerId: result.ledgerId, reason: result.reason },
        );
      }
      return result;
    },

    /**
     * Re-evaluate a previously recorded action against the CURRENT policy.
     * Returns the fresh verdict object and records it as a new ledger entry
     * linked via replayOf. Deterministic when the policy is unchanged.
     */
    replay(ledgerId) {
      const original = ledger.find((entry) => entry.ledgerId === ledgerId);
      if (!original) {
        throw sandboxError('SB_NOT_FOUND', `Unknown ledger id: ${ledgerId}`, { ledgerId });
      }
      const result = evaluate(original.action);
      const entry = recordInterception({
        action: original.action,
        ...result,
        replayOf: ledgerId,
      });
      return {
        ledgerId: entry.ledgerId,
        replayOf: ledgerId,
        verdict: entry.verdict,
        ...(entry.modifiedAction ? { modifiedAction: entry.modifiedAction } : {}),
        reason: entry.reason,
        matchedRule: entry.matchedRule,
        at: entry.at,
      };
    },

    /** Per-agent counters: { [agentId]: { allowed, denied, modified } }. */
    stats() {
      const out = {};
      for (const [agentId, counts] of statsByAgent) {
        out[agentId] = { ...counts };
      }
      return out;
    },

    /** Counters for one agent (zeroed shape when the agent has no interceptions). */
    statsFor(agentId) {
      const counts = statsByAgent.get(agentId);
      return counts ? { ...counts } : { allowed: 0, denied: 0, modified: 0 };
    },

    /** Read-only copy of a ledger entry by id (null if unknown). */
    get(ledgerId) {
      const entry = ledger.find((e) => e.ledgerId === ledgerId);
      return entry ?? null;
    },
  };

  return Object.freeze(interceptor);
}
