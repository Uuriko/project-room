/**
 * triage-execution.mjs — Pure execution engine for inbox.triage runs.
 *
 * Model: a run holds an ordered list of inbox items. Starting a run walks the
 * items in order:
 *   1. Evaluate every rule from the injected ruleStore against the item
 *      (rule.match(item) → boolean); matching rules apply in priority order
 *      (lower `priority` number first; ties broken by rule id).
 *   2. If two rules at the SAME priority match the same item with
 *      contradictory actions (same action `type`, differing payload), the item
 *      is skipped: a `TE_RULE_CONFLICT` decision + audit entry is recorded and
 *      the run continues with the next item. It is never executed silently.
 *   3. Otherwise the rule actions are executed in order via the injected
 *      actionRunner. Transient action failures (err.transient === true or
 *      err.code === 'TE_ACTION_TRANSIENT') are retried exactly once; other
 *      failures, or an exhausted retry, fail the item (the run continues).
 *   4. dryRun mode evaluates rules and records decisions without executing
 *      any action — the actionRunner is never called.
 *
 * States:
 *   idle → running → completed
 *   Side states: failed (fatal internal error), cancelled (cancel mid-run)
 *
 * A run record: { id, startedAt, items[], decisions[] }.
 * A decision record: { itemId, matchedRuleIds, actions, results, status } where
 * status is 'done' | 'failed' | 'skipped', and results entries carry
 * { action, ok, result?, error?, errorCode?, retried?, dryRun? }.
 * Progress: { total, done, failed } — 'done' counts fully executed (or
 * evaluated, in dryRun) items; 'failed' counts items failed by action errors
 * plus conflict-skipped items.
 *
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * actions reach the outside world only through the injected actionRunner.
 *
 * Dependency injection (all via the `deps` parameter of createTriageExecution):
 *   - clock:        () => number  (ms epoch; default: Date.now)
 *   - id:           () => string  (run id generator; default: per-engine counter)
 *   - actionRunner: { run(action, item) => { ok } | throws }
 *                   (required for non-dryRun runs; never called in dryRun)
 *   - ruleStore:    { listRules() => [{ id, priority, match, actions }] }
 *                   Rule: { id: string, priority?: number (default 0),
 *                           match: (item) => boolean, actions: [action] }.
 *                   Action: { type: string, ...payload }.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   TE_NOT_FOUND          — unknown run id
 *   TE_INVALID_TRANSITION — operation not allowed from the current state
 *                           (e.g. start a non-idle run, cancel a non-running run)
 *   TE_ACTION_FAILED      — an action could not be executed (missing runner,
 *                           rule-store failure, malformed rule); per-item action
 *                           failures are recorded on the decision instead and
 *                           the run continues
 *   TE_RULE_CONFLICT      — two same-priority rules matched the same item with
 *                           contradictory actions; the item is skipped (recorded
 *                           on the decision + audit, run continues)
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'idle',
  'running',
  'completed',
  'failed',
  'cancelled',
]);

export const ERROR_CODES = Object.freeze([
  'TE_NOT_FOUND',
  'TE_INVALID_TRANSITION',
  'TE_ACTION_FAILED',
  'TE_RULE_CONFLICT',
]);

/** Throw a coded triage error (never silent failures). */
function triageError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** True when an action failure is transient and deserves exactly one retry. */
function isTransient(err) {
  return !!err && (err.transient === true || err.code === 'TE_ACTION_TRANSIENT');
}

/** Canonical payload comparison for actions of the same type (key-order safe). */
function canonicalPayload(action) {
  const entries = Object.entries(action ?? {})
    .filter(([key]) => key !== 'type')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Two actions are contradictory when they share a `type` but carry different
 * payloads (e.g. {type:'label', label:'a'} vs {type:'label', label:'b'}).
 */
function actionsConflict(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  return canonicalPayload(a) !== canonicalPayload(b);
}

/**
 * Find a contradiction between actions of different rules that share a
 * priority. Returns { ruleIds, actions } or null.
 */
function findConflict(matched) {
  const byPriority = new Map();
  for (const rule of matched) {
    const group = byPriority.get(rule.priority) ?? [];
    group.push(rule);
    byPriority.set(rule.priority, group);
  }
  for (const group of byPriority.values()) {
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        for (const a of group[i].actions) {
          for (const b of group[j].actions) {
            if (actionsConflict(a, b)) {
              return {
                ruleIds: [group[i].id, group[j].id],
                priority: group[i].priority,
                actions: [a, b],
              };
            }
          }
        }
      }
    }
  }
  return null;
}

/**
 * Create a new inbox.triage execution engine.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ run: (action: object, item: object) => object }} [deps.actionRunner]
 * @param {{ listRules: () => Array }} [deps.ruleStore]
 */
export function createTriageExecution(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const actionRunner = deps.actionRunner ?? null;
  const ruleStore = deps.ruleStore ?? null;

  let idCounter = 0;
  const newId = deps.id ?? (() => `triage-run-${(idCounter += 1)}`);

  /** Internal run records, keyed by id. */
  const runs = new Map();

  /** Append-only audit log: every event lands here, never removed. */
  const audit = [];

  function record({ at, event, runId, actor, detail }) {
    const entry = Object.freeze({
      at,
      event,
      runId,
      actor,
      detail: detail === undefined ? null : detail,
    });
    audit.push(entry);
    return entry;
  }

  function getRunOrThrow(id) {
    const run = runs.get(id);
    if (!run) {
      throw triageError('TE_NOT_FOUND', `Unknown triage run id: ${id}`, { runId: id });
    }
    return run;
  }

  function assertState(run, allowed, op) {
    if (!allowed.includes(run.state)) {
      throw triageError(
        'TE_INVALID_TRANSITION',
        `Cannot ${op} triage run ${run.id} from state '${run.state}'`,
        { runId: run.id, state: run.state, op },
      );
    }
  }

  function snapshot(run) {
    return Object.freeze({
      id: run.id,
      state: run.state,
      dryRun: run.dryRun,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      itemCount: run.items.length,
      decisions: Object.freeze(run.decisions.map((d) => Object.freeze({ ...d }))),
    });
  }

  function transition(run, to, actor, detail) {
    const from = run.state;
    run.state = to;
    record({
      at: clock(),
      event: 'run-transition',
      runId: run.id,
      actor,
      detail: { from, to, ...(detail ?? {}) },
    });
    return snapshot(run);
  }

  /** Fetch + validate rules for a run. Fatal: throws TE_ACTION_FAILED. */
  function loadRules(run) {
    if (!ruleStore || typeof ruleStore.listRules !== 'function') {
      throw triageError('TE_ACTION_FAILED', `Triage run ${run.id} has no ruleStore`, {
        runId: run.id,
      });
    }
    let rules;
    try {
      rules = ruleStore.listRules();
    } catch (err) {
      throw triageError(
        'TE_ACTION_FAILED',
        `ruleStore.listRules() failed for triage run ${run.id}: ${err?.message ?? String(err)}`,
        { runId: run.id },
      );
    }
    if (!Array.isArray(rules)) {
      throw triageError('TE_ACTION_FAILED', `ruleStore.listRules() must return an array`, {
        runId: run.id,
      });
    }
    for (const rule of rules) {
      if (
        !rule ||
        typeof rule.id !== 'string' ||
        typeof rule.match !== 'function' ||
        !Array.isArray(rule.actions)
      ) {
        throw triageError(
          'TE_ACTION_FAILED',
          `Malformed rule in ruleStore (needs { id, match, actions }): ${JSON.stringify(rule)}`,
          { runId: run.id },
        );
      }
    }
    return rules.map((rule) => ({
      ...rule,
      priority: typeof rule.priority === 'number' ? rule.priority : 0,
    }));
  }

  /** Execute one action with exactly one retry on transient failure. */
  function executeAction(action, item) {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const result = actionRunner.run(action, item);
        return { action, ok: true, result: result ?? null, retried: attempts > 1 };
      } catch (err) {
        if (isTransient(err) && attempts === 1) {
          continue; // exactly one retry on transient failure
        }
        return {
          action,
          ok: false,
          error: err?.message ?? String(err),
          errorCode: 'TE_ACTION_FAILED',
          retried: attempts > 1,
        };
      }
    }
  }

  /** Process a single item: evaluate rules, detect conflicts, execute actions. */
  function processItem(run, item, rules, actor) {
    const itemId = item?.id ?? `item-${run.decisions.length}`;
    let matched;
    try {
      matched = rules
        .filter((rule) => !!rule.match(item))
        .sort((a, b) =>
          a.priority === b.priority
            ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
            : a.priority - b.priority,
        );
    } catch (err) {
      // A rule's match() throwing is fatal for the whole run (not per-item).
      throw triageError(
        'TE_ACTION_FAILED',
        `Rule match() threw for triage run ${run.id}: ${err?.message ?? String(err)}`,
        { runId: run.id, itemId },
      );
    }
    const matchedRuleIds = matched.map((rule) => rule.id);

    const conflict = findConflict(matched);
    if (conflict) {
      const decision = Object.freeze({
        itemId,
        matchedRuleIds,
        actions: [],
        results: [],
        status: 'skipped',
        errorCode: 'TE_RULE_CONFLICT',
        conflict,
      });
      run.decisions.push(decision);
      record({
        at: clock(),
        event: 'item-decision',
        runId: run.id,
        actor,
        detail: { itemId, status: 'skipped', errorCode: 'TE_RULE_CONFLICT', conflict },
      });
      return;
    }

    const actions = matched.flatMap((rule) => rule.actions);
    if (run.dryRun) {
      const results = actions.map((action) =>
        Object.freeze({ action, ok: true, dryRun: true }),
      );
      run.decisions.push(
        Object.freeze({
          itemId,
          matchedRuleIds,
          actions: Object.freeze([...actions]),
          results: Object.freeze(results),
          status: 'done',
          dryRun: true,
        }),
      );
      record({
        at: clock(),
        event: 'item-decision',
        runId: run.id,
        actor,
        detail: { itemId, status: 'done', dryRun: true, matchedRuleIds },
      });
      return;
    }

    const results = [];
    for (const action of actions) {
      const res = executeAction(action, item);
      results.push(Object.freeze(res));
      if (!res.ok) break; // stop the item's remaining actions on first failure
    }
    const status = results.every((r) => r.ok) ? 'done' : 'failed';
    run.decisions.push(
      Object.freeze({
        itemId,
        matchedRuleIds,
        actions: Object.freeze([...actions]),
        results: Object.freeze(results),
        status,
        ...(status === 'failed' ? { errorCode: 'TE_ACTION_FAILED' } : {}),
      }),
    );
    record({
      at: clock(),
      event: 'item-decision',
      runId: run.id,
      actor,
      detail: {
        itemId,
        status,
        matchedRuleIds,
        ...(status === 'failed' ? { errorCode: 'TE_ACTION_FAILED' } : {}),
      },
    });
  }

  const engine = {
    /** Append-only audit trail: {at, event, runId, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Create a run over `items` in `idle` state.
     * @param {Array} items inbox items (each ideally has a stable `id`)
     * @param {object} [opts] { dryRun?: boolean }
     */
    createRun(items, opts = {}, actor = 'agent') {
      if (!Array.isArray(items)) {
        throw triageError('TE_ACTION_FAILED', 'createRun requires an items array', {
          items,
        });
      }
      const id = newId();
      const run = {
        id,
        state: 'idle',
        dryRun: opts.dryRun === true,
        items: [...items],
        decisions: [],
        startedAt: null,
        completedAt: null,
        cancelRequested: false,
      };
      runs.set(id, run);
      record({
        at: clock(),
        event: 'run-created',
        runId: id,
        actor,
        detail: { itemCount: items.length, dryRun: run.dryRun },
      });
      return snapshot(run);
    },

    /**
     * Start a run: evaluate rules and execute actions for every item in order.
     * The run moves idle → running → completed. A mid-run cancelRun() call
     * (e.g. from the actionRunner) ends the run as `cancelled`. Fatal internal
     * errors move it to `failed` and throw TE_ACTION_FAILED.
     */
    startRun(id, actor = 'agent') {
      const run = getRunOrThrow(id);
      assertState(run, ['idle'], 'start');
      if (!run.dryRun && (!actionRunner || typeof actionRunner.run !== 'function')) {
        throw triageError(
          'TE_ACTION_FAILED',
          `Triage run ${run.id} needs an actionRunner (non-dryRun)`,
          { runId: run.id },
        );
      }
      run.startedAt = clock();
      transition(run, 'running', actor, { itemCount: run.items.length });
      try {
        const rules = loadRules(run);
        for (const item of run.items) {
          if (run.cancelRequested) break;
          processItem(run, item, rules, actor);
        }
      } catch (err) {
        run.completedAt = clock();
        transition(run, 'failed', actor, {
          reason: err?.message ?? String(err),
          code: err?.code ?? 'TE_ACTION_FAILED',
        });
        throw err;
      }
      run.completedAt = clock();
      const to = run.cancelRequested ? 'cancelled' : 'completed';
      return transition(run, to, actor, {
        decided: run.decisions.length,
        ...(run.cancelRequested ? { reason: 'cancel requested mid-run' } : {}),
      });
    },

    /**
     * Cancel a running run. Takes effect between items: the current item
     * finishes, remaining items are not processed.
     */
    cancelRun(id, actor = 'agent') {
      const run = getRunOrThrow(id);
      assertState(run, ['running'], 'cancel');
      run.cancelRequested = true;
      record({
        at: clock(),
        event: 'cancel-requested',
        runId: run.id,
        actor,
        detail: null,
      });
      return snapshot(run);
    },

    /** Progress accounting: { total, done, failed }. */
    progress(id) {
      const run = getRunOrThrow(id);
      return Object.freeze({
        total: run.items.length,
        done: run.decisions.filter((d) => d.status === 'done').length,
        failed: run.decisions.filter((d) => d.status === 'failed' || d.status === 'skipped')
          .length,
      });
    },

    /** Read-only snapshot of a run (null if unknown). */
    get(id) {
      const run = runs.get(id);
      return run ? snapshot(run) : null;
    },
  };

  return Object.freeze(engine);
}
