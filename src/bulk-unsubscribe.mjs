/**
 * bulk-unsubscribe.mjs — Pure one-click unsubscribe execution planner.
 *
 * Plans and executes bulk unsubscribes across a sender's mailing lists.
 * Nothing here touches the network, the DOM, localStorage, or any secret —
 * it is a pure execution planner. Actual unsubscribe work happens through the
 * injected `unsubscriber` dependency, which production wiring connects to
 * the real List-Unsubscribe / List-Unsubscribe-Post transport.
 *
 * Job shape: { id, sender, listIds[], method: 'one-click'|'http'|'mailto', state }
 *
 * States:
 *   queued → executing → done
 *   Side states: failed, partial, skipped
 *     (done = every list unsubscribed OK; partial = some failed; failed = none
 *      succeeded. `skipped` is reserved for a future confirmed-skip path and is
 *      never entered by this implementation.)
 *
 * Method resolution: prefer one-click (List-Unsubscribe-Post) → http → mailto.
 * Each queued list declares its supported methods (`supports`); the job's
 * method is the most-preferred method supported by EVERY list in the job, so
 * one method executes the whole job. BU_NO_METHOD if no method is common.
 *
 * Execution: per list, the injected `unsubscriber.unsubscribe(listId, method)`
 * is called. It returns `{ ok: true }` on success or throws on failure. A
 * failure whose error has `transient === true` (or `code === 'BU_TRANSIENT'`)
 * is retried exactly once; the second failure is recorded as final. Per-list
 * results are collected — never silent.
 *
 * Never auto-unsubscribes: execute() requires an explicit per-sender
 * confirmation flag ({ confirmed: true }); anything else throws
 * BU_NOT_CONFIRMED. dryRun() plans (method + list count) without executing.
 *
 * Dependency injection (all via the `deps` parameter of createBulkUnsubscriber):
 *   - clock:        () => number  (ms epoch; default: Date.now)
 *   - id:           () => string  (job id generator; default: per-planner counter)
 *   - unsubscriber: { unsubscribe(listId: string, method: string) =>
 *                     { ok: true } | throws }  (REQUIRED — the real transport)
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   BU_NO_UNSUBSCRIBER   — createBulkUnsubscriber called without an unsubscriber dep
 *   BU_NOT_FOUND         — unknown job id
 *   BU_INVALID_TRANSITION — operation not allowed from the current state
 *   BU_NO_LISTS          — queue() called with no lists
 *   BU_NO_METHOD         — no unsubscribe method common to all lists
 *   BU_NOT_CONFIRMED     — execute() without { confirmed: true }
 *   BU_UNSUB_FAILED      — execute() finished with every list failed (job → failed)
 * Failures are never silent.
 */

export const STATES = Object.freeze([
  'queued',
  'executing',
  'done',
  'failed',
  'partial',
  'skipped',
]);

export const METHODS = Object.freeze(['one-click', 'http', 'mailto']);

const METHOD_PREFERENCE = ['one-click', 'http', 'mailto'];

/** Throw a coded bulk-unsubscribe error (never silent failures). */
function buError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/**
 * Resolve the job method: most-preferred method supported by every list.
 * Throws BU_NO_METHOD when no method is common to all lists.
 */
function resolveMethod(lists) {
  for (const method of METHOD_PREFERENCE) {
    if (lists.every((list) => (list.supports ?? []).includes(method))) {
      return method;
    }
  }
  return null;
}

/** A failure is transient (retry-once eligible) when marked transient by the dep. */
function isTransient(err) {
  return err != null && (err.transient === true || err.code === 'BU_TRANSIENT');
}

/**
 * Create a new bulk-unsubscribe execution planner.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ unsubscribe: (listId: string, method: string) => { ok: true } }} [deps.unsubscriber]
 */
export function createBulkUnsubscriber(deps = {}) {
  if (deps.unsubscriber == null || typeof deps.unsubscriber.unsubscribe !== 'function') {
    throw buError(
      'BU_NO_UNSUBSCRIBER',
      'createBulkUnsubscriber requires deps.unsubscriber.unsubscribe(listId, method)',
      { hasUnsubscriber: deps.unsubscriber != null },
    );
  }
  const clock = deps.clock ?? (() => Date.now());
  const unsubscriber = deps.unsubscriber;

  let idCounter = 0;
  const newId = deps.id ?? (() => `unsub-${(idCounter += 1)}`);

  /** Internal job records, keyed by id. */
  const jobs = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

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

  function snapshot(job) {
    return Object.freeze({
      id: job.id,
      sender: job.sender,
      listIds: Object.freeze([...job.listIds]),
      method: job.method,
      state: job.state,
      results: Object.freeze(job.results.map((r) => Object.freeze({ ...r }))),
      createdAt: job.createdAt,
      executedAt: job.executedAt,
      finishedAt: job.finishedAt,
    });
  }

  function transition(job, to, actor, detail) {
    const from = job.state;
    job.state = to;
    record({
      at: clock(),
      from,
      to,
      actor,
      detail: { jobId: job.id, sender: job.sender, ...(detail ?? {}) },
    });
    return snapshot(job);
  }

  function getJobOrThrow(id) {
    const job = jobs.get(id);
    if (!job) {
      throw buError('BU_NOT_FOUND', `Unknown unsubscribe job id: ${id}`, { jobId: id });
    }
    return job;
  }

  function assertState(job, allowed, op) {
    if (!allowed.includes(job.state)) {
      throw buError(
        'BU_INVALID_TRANSITION',
        `Cannot ${op} job ${job.id} from state '${job.state}'`,
        { jobId: job.id, state: job.state, op },
      );
    }
  }

  /**
   * Execute one list: call the injected unsubscriber, retrying exactly once
   * on a transient failure. Returns a result record, never throws.
   */
  function executeList(listId, method, actor, jobId) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const res = unsubscriber.unsubscribe(listId, method);
        record({
          at: clock(),
          from: 'executing',
          to: 'executing',
          actor,
          detail: { jobId, listId, method, attempt, outcome: 'ok', returned: res?.ok ?? null },
        });
        return { listId, method, ok: true, attempts: attempt };
      } catch (err) {
        record({
          at: clock(),
          from: 'executing',
          to: 'executing',
          actor,
          detail: {
            jobId,
            listId,
            method,
            attempt,
            outcome: 'error',
            transient: isTransient(err),
            errorCode: err?.code ?? null,
            errorMessage: err?.message ?? String(err),
          },
        });
        if (!isTransient(err) || attempt === 2) {
          return {
            listId,
            method,
            ok: false,
            attempts: attempt,
            errorCode: err?.code ?? 'BU_UNSUB_FAILED',
            errorMessage: err?.message ?? String(err),
          };
        }
        // transient on attempt 1: fall through and retry exactly once
      }
    }
    // Unreachable: the loop always returns. Guards against logic drift.
    throw buError('BU_UNSUB_FAILED', `Unsubscribe exhausted for list ${listId}`, { listId });
  }

  const planner = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Queue an unsubscribe job for one sender.
     * @param {string} sender — sender identity (e.g. domain or display name)
     * @param {Array<{ id: string, supports?: string[] }>} lists — lists with
     *        their supported unsubscribe methods (subset of METHODS)
     * @param {string} [actor]
     */
    queue(sender, lists, actor = 'agent') {
      const listArray = Array.isArray(lists) ? lists : [];
      if (listArray.length === 0) {
        throw buError(
          'BU_NO_LISTS',
          `Cannot queue unsubscribe job for sender '${sender}': no lists provided`,
          { sender },
        );
      }
      const method = resolveMethod(listArray);
      if (!method) {
        throw buError(
          'BU_NO_METHOD',
          `Cannot queue unsubscribe job for sender '${sender}': no unsubscribe method is common to all ${listArray.length} lists`,
          { sender, listIds: listArray.map((l) => l.id) },
        );
      }
      const job = {
        id: newId(),
        sender,
        listIds: listArray.map((l) => l.id),
        method,
        state: 'queued',
        results: [],
        createdAt: clock(),
        executedAt: null,
        finishedAt: null,
      };
      jobs.set(job.id, job);
      record({
        at: clock(),
        from: null,
        to: 'queued',
        actor,
        detail: { jobId: job.id, sender, listIds: job.listIds, method },
      });
      return snapshot(job);
    },

    /**
     * Plan without executing: resolve the method and count lists for a sender.
     * Pure — creates no job, touches no unsubscriber, needs no confirmation.
     */
    dryRun(sender, lists) {
      const listArray = Array.isArray(lists) ? lists : [];
      if (listArray.length === 0) {
        throw buError(
          'BU_NO_LISTS',
          `Cannot dry-run unsubscribe for sender '${sender}': no lists provided`,
          { sender },
        );
      }
      const method = resolveMethod(listArray);
      if (!method) {
        throw buError(
          'BU_NO_METHOD',
          `Cannot dry-run unsubscribe for sender '${sender}': no unsubscribe method is common to all ${listArray.length} lists`,
          { sender, listIds: listArray.map((l) => l.id) },
        );
      }
      return Object.freeze({
        sender,
        method,
        listCount: listArray.length,
        listIds: Object.freeze(listArray.map((l) => l.id)),
      });
    },

    /**
     * Execute a queued job. Requires explicit per-sender confirmation:
     * opts.confirmed === true, otherwise BU_NOT_CONFIRMED.
     * Returns the final snapshot for done/partial; throws BU_UNSUB_FAILED
     * when every list failed (job → failed), with per-list results in detail.
     */
    execute(id, opts = {}, actor = 'agent') {
      const job = getJobOrThrow(id);
      assertState(job, ['queued'], 'execute');
      if (opts?.confirmed !== true) {
        throw buError(
          'BU_NOT_CONFIRMED',
          `Refusing to unsubscribe sender '${job.sender}' without explicit per-sender confirmation (opts.confirmed must be true)`,
          { jobId: job.id, sender: job.sender },
        );
      }
      job.executedAt = clock();
      transition(job, 'executing', actor, { listCount: job.listIds.length });

      const results = job.listIds.map((listId) =>
        executeList(listId, job.method, actor, job.id),
      );
      job.results = results;
      job.finishedAt = clock();

      const succeeded = results.filter((r) => r.ok).length;
      if (succeeded === results.length) {
        return transition(job, 'done', actor, {
          listCount: results.length,
          succeeded,
        });
      }
      if (succeeded === 0) {
        transition(job, 'failed', actor, {
          listCount: results.length,
          succeeded,
          results: results.map((r) => ({ listId: r.listId, errorCode: r.errorCode })),
        });
        throw buError(
          'BU_UNSUB_FAILED',
          `Unsubscribe job ${job.id} failed: all ${results.length} lists failed for sender '${job.sender}'`,
          { jobId: job.id, sender: job.sender, results },
        );
      }
      return transition(job, 'partial', actor, {
        listCount: results.length,
        succeeded,
        results: results.map((r) => ({ listId: r.listId, ok: r.ok })),
      });
    },

    /** Read-only snapshot of a job (null if unknown). */
    get(id) {
      const job = jobs.get(id);
      return job ? snapshot(job) : null;
    },
  };

  return Object.freeze(planner);
}
