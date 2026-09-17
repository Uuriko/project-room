/**
 * handoff-store.mjs — Pure work-handoff record store for agent-to-agent
 * work handoffs (task B048-2, [quill-s2] 100-task program).
 *
 * Pure handoff store: NO network, NO DOM, NO secrets. Persistence goes only
 * through the injected `storage` dependency (write-through on every mutation).
 *
 * A handoff is a work handoff record between two agents:
 *   { id, fromAgent, toAgent, taskId?, summary, context?, createdAt,
 *     state, decidedAt?, decidedBy?, rejectReason?, completeNote? }
 *
 * States:
 *   proposed → accepted → completed
 *   proposed → rejected | cancelled
 * `rejected`, `completed`, `cancelled` are terminal.
 *
 * Authority rules:
 *   - accept / reject: only the recipient (toAgent), from `proposed`
 *   - complete: only the recipient (toAgent), from `accepted`
 *   - cancel: only the originator (fromAgent), from `proposed` (before accept)
 *
 * Dependency injection (all via the `deps` parameter of createHandoffStore):
 *   - clock:    () => number  (ms epoch; default: Date.now)
 *   - id:       () => string  (handoff id generator; default: per-store counter)
 *   - storage:  { load(): object|null, save(snapshot): void }
 *               (default: in-memory, non-persistent; production wiring MUST
 *               inject a real backing store)
 *
 * Subscribers: subscribe(fn) receives {type, actor, at, handoff} on every
 * state transition ('proposed' | 'accepted' | 'rejected' | 'completed' |
 * 'cancelled' | 'restored'). Returns an unsubscribe function.
 *
 * Error contract: every failure throws an Error with a `code` property:
 *   HO_NOT_FOUND         — unknown handoff id
 *   HO_INVALID_STATE     — operation not allowed from the current state
 *   HO_INVALID_HANDOFF   — handoff arguments failed validation (from === to,
 *                          bad agent ids, summary out of 1..2000, bad snapshot
 *                          shape at propose time)
 *   HO_UNAUTHORIZED      — `by` is not the agent allowed to act
 *   HO_STORAGE_ERROR     — the injected storage threw
 *   HO_CORRUPT_SNAPSHOT  — restore()/load() snapshot is malformed or has a
 *                          wrong schema version
 * Failures are never silent.
 */

export const HANDOFF_STATES = Object.freeze([
  'proposed',
  'accepted',
  'rejected',
  'completed',
  'cancelled',
]);

export const SCHEMA_VERSION = 1;

export const MAX_SUMMARY_LENGTH = 2000;

const TERMINAL_STATES = new Set(['rejected', 'completed', 'cancelled']);

/** Throw a coded handoff-store error (never silent failures). */
function handoffError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail !== undefined) err.detail = detail;
  return err;
}

/** Default in-memory storage: satisfies the dep contract, persists nothing. */
function memoryStorage() {
  let held = null;
  return {
    load: () => held,
    save: (snapshot) => {
      held = snapshot;
    },
  };
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validateProposeArgs({ fromAgent, toAgent, taskId, summary, context }) {
  const bad = (message, detail) =>
    handoffError('HO_INVALID_HANDOFF', message, detail);
  if (!isNonEmptyString(fromAgent)) {
    throw bad('fromAgent must be a non-empty string', { fromAgent });
  }
  if (!isNonEmptyString(toAgent)) {
    throw bad('toAgent must be a non-empty string', { toAgent });
  }
  if (fromAgent.trim() === toAgent.trim()) {
    throw bad('fromAgent and toAgent must differ', { fromAgent, toAgent });
  }
  if (taskId !== undefined && taskId !== null && !isNonEmptyString(taskId)) {
    throw bad('taskId must be a non-empty string when provided', { taskId });
  }
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw bad('summary must be a non-empty string', { summary });
  }
  if (summary.trim().length > MAX_SUMMARY_LENGTH) {
    throw bad(`summary must be at most ${MAX_SUMMARY_LENGTH} characters`, {
      length: summary.trim().length,
      max: MAX_SUMMARY_LENGTH,
    });
  }
  if (context !== undefined && context !== null && typeof context !== 'object') {
    throw bad('context must be an object when provided', { context });
  }
}

/**
 * Create a new work-handoff record store.
 * @param {object} [deps]
 * @param {() => number} [deps.clock]
 * @param {() => string} [deps.id]
 * @param {{ load(): object|null, save(object): void }} [deps.storage]
 */
export function createHandoffStore(deps = {}) {
  const clock = deps.clock ?? (() => Date.now());
  const storage = deps.storage ?? memoryStorage();

  let idCounter = 0;
  const newId = deps.id ?? (() => `ho-${(idCounter += 1)}`);

  /** Internal handoff records, keyed by id. */
  const handoffs = new Map();

  /** Append-only audit log: every transition lands here, never removed. */
  const audit = [];

  /** Subscriber notifications: Set of (event) => void. */
  const subscribers = new Set();

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

  function notify(type, handoffSnapshot, actor) {
    const event = Object.freeze({
      type,
      actor,
      at: clock(),
      handoff: handoffSnapshot,
    });
    for (const sub of subscribers) {
      sub(event);
    }
  }

  function getHandoffOrThrow(id) {
    const handoff = handoffs.get(id);
    if (!handoff) {
      throw handoffError('HO_NOT_FOUND', `Unknown handoff id: ${id}`, {
        handoffId: id,
      });
    }
    return handoff;
  }

  function snapshot(handoff) {
    return Object.freeze({
      id: handoff.id,
      fromAgent: handoff.fromAgent,
      toAgent: handoff.toAgent,
      taskId: handoff.taskId,
      summary: handoff.summary,
      context: handoff.context === undefined ? undefined : { ...handoff.context },
      createdAt: handoff.createdAt,
      state: handoff.state,
      decidedAt: handoff.decidedAt,
      decidedBy: handoff.decidedBy,
      rejectReason: handoff.rejectReason,
      completeNote: handoff.completeNote,
    });
  }

  /**
   * Persist the full store to the injected storage (write-through). Throws
   * HO_STORAGE_ERROR when the storage dep fails.
   */
  function persist() {
    const data = Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      savedAt: clock(),
      handoffs: handoffs.size === 0 ? [] : [...handoffs.values()].map(snapshot),
      audit: [...audit],
    });
    try {
      storage.save(data);
    } catch (err) {
      throw handoffError(
        'HO_STORAGE_ERROR',
        `Storage save failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    return data;
  }

  /**
   * Run mutate(), then persist. If persistence throws, roll back with undo()
   * so a failed write never leaves half-applied state behind.
   */
  function writeThrough({ mutate, undo }) {
    mutate();
    try {
      return persist();
    } catch (err) {
      undo();
      throw err;
    }
  }

  function assertState(handoff, allowed, op) {
    if (!allowed.includes(handoff.state)) {
      throw handoffError(
        'HO_INVALID_STATE',
        `Cannot ${op} handoff ${handoff.id} from state '${handoff.state}'`,
        { handoffId: handoff.id, state: handoff.state, op },
      );
    }
  }

  function assertActor(handoff, by, which, op) {
    const expected = which === 'from' ? handoff.fromAgent : handoff.toAgent;
    if (by !== expected) {
      throw handoffError(
        'HO_UNAUTHORIZED',
        `Cannot ${op} handoff ${handoff.id}: '${by}' is not the ${which === 'from' ? 'originator' : 'recipient'} (${expected})`,
        { handoffId: handoff.id, by, expected },
      );
    }
  }

  /**
   * Apply a state transition: record audit, notify subscribers, and
   * write-through to storage. Returns the fresh handoff snapshot.
   */
  function transition(handoff, to, by, extra) {
    const from = handoff.state;
    const prev = { ...handoff };
    const prevAuditLength = audit.length;
    writeThrough({
      mutate: () => {
        handoff.state = to;
        handoff.decidedAt = clock();
        handoff.decidedBy = by;
        Object.assign(handoff, extra);
        record({
          at: clock(),
          from,
          to,
          actor: by,
          detail: { handoffId: handoff.id, ...extra },
        });
      },
      undo: () => {
        Object.assign(handoff, prev);
        audit.length = prevAuditLength;
      },
    });
    notify(to, snapshot(handoff), by);
    return snapshot(handoff);
  }

  /** Validate a raw snapshot object before restore(); throws HO_CORRUPT_SNAPSHOT. */
  function validateSnapshot(data) {
    const bad = (reason, detail) =>
      handoffError('HO_CORRUPT_SNAPSHOT', `Corrupt snapshot: ${reason}`, detail);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw bad('snapshot must be an object', { data });
    }
    if (data.schemaVersion !== SCHEMA_VERSION) {
      throw bad(`unsupported schemaVersion ${data.schemaVersion}`, {
        schemaVersion: data.schemaVersion,
        expected: SCHEMA_VERSION,
      });
    }
    if (!Array.isArray(data.handoffs)) {
      throw bad('handoffs must be an array', { handoffs: data.handoffs });
    }
    for (const h of data.handoffs) {
      if (!h || typeof h !== 'object') throw bad('handoff must be an object', { handoff: h });
      if (typeof h.id !== 'string' || h.id === '') throw bad('handoff.id missing', { handoff: h });
      if (!isNonEmptyString(h.fromAgent)) throw bad('handoff.fromAgent missing', { handoff: h });
      if (!isNonEmptyString(h.toAgent)) throw bad('handoff.toAgent missing', { handoff: h });
      if (h.fromAgent === h.toAgent) throw bad('handoff fromAgent === toAgent', { handoff: h });
      if (!HANDOFF_STATES.includes(h.state)) {
        throw bad(`unknown handoff state '${h.state}'`, { handoff: h });
      }
      if (typeof h.summary !== 'string' || h.summary === '') {
        throw bad('handoff.summary missing', { handoff: h });
      }
      if (typeof h.createdAt !== 'number') {
        throw bad('handoff.createdAt malformed', { handoff: h });
      }
    }
    const ids = data.handoffs.map((h) => h.id);
    if (new Set(ids).size !== ids.length) {
      throw bad('duplicate handoff ids in snapshot', { ids });
    }
    if (!Array.isArray(data.audit)) {
      throw bad('audit must be an array', { audit: data.audit });
    }
  }

  const store = {
    /** Append-only audit trail of every transition: {at, from, to, actor, detail}. */
    get audit() {
      return [...audit];
    },

    /**
     * Subscribe to handoff events: {type, actor, at, handoff}. type is one of
     * 'proposed' | 'accepted' | 'rejected' | 'completed' | 'cancelled' |
     * 'restored'. Returns an unsubscribe function.
     */
    subscribe(fn) {
      if (typeof fn !== 'function') {
        throw handoffError('HO_INVALID_HANDOFF', 'subscriber must be a function', {});
      }
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    /**
     * Propose a new handoff from one agent to another. Validates: from !== to,
     * both agent ids non-empty, summary 1..2000 characters. Starts in
     * `proposed` state.
     */
    propose({ fromAgent, toAgent, taskId, summary, context }, actor) {
      validateProposeArgs({ fromAgent, toAgent, taskId, summary, context });
      const handoff = {
        id: newId(),
        fromAgent: fromAgent.trim(),
        toAgent: toAgent.trim(),
        taskId: taskId ?? null,
        summary: summary.trim(),
        context: context === undefined || context === null ? undefined : { ...context },
        createdAt: clock(),
        state: 'proposed',
        decidedAt: null,
        decidedBy: null,
        rejectReason: null,
        completeNote: null,
      };
      const prevAuditLength = audit.length;
      writeThrough({
        mutate: () => {
          handoffs.set(handoff.id, handoff);
          record({
            at: clock(),
            from: null,
            to: 'proposed',
            actor: actor ?? fromAgent,
            detail: {
              handoffId: handoff.id,
              fromAgent: handoff.fromAgent,
              toAgent: handoff.toAgent,
            },
          });
        },
        undo: () => {
          handoffs.delete(handoff.id);
          audit.length = prevAuditLength;
        },
      });
      notify('proposed', snapshot(handoff), actor ?? fromAgent);
      return snapshot(handoff);
    },

    /**
     * Accept a proposed handoff. Only the recipient (toAgent) may accept,
     * and only from `proposed`.
     */
    accept(handoffId, by) {
      const handoff = getHandoffOrThrow(handoffId);
      assertState(handoff, ['proposed'], 'accept');
      assertActor(handoff, by, 'to', 'accept');
      return transition(handoff, 'accepted', by, {});
    },

    /**
     * Reject a proposed handoff with an optional reason. Only the recipient
     * (toAgent) may reject, and only from `proposed`.
     */
    reject(handoffId, by, reason) {
      const handoff = getHandoffOrThrow(handoffId);
      assertState(handoff, ['proposed'], 'reject');
      assertActor(handoff, by, 'to', 'reject');
      return transition(handoff, 'rejected', by, {
        rejectReason: reason ?? '',
      });
    },

    /**
     * Mark an accepted handoff completed with an optional note. Only the
     * recipient (toAgent) may complete, and only from `accepted`.
     */
    complete(handoffId, by, note) {
      const handoff = getHandoffOrThrow(handoffId);
      assertState(handoff, ['accepted'], 'complete');
      assertActor(handoff, by, 'to', 'complete');
      return transition(handoff, 'completed', by, {
        completeNote: note ?? '',
      });
    },

    /**
     * Cancel a proposed handoff. Only the originator (fromAgent) may cancel,
     * and only before it is accepted (from `proposed`).
     */
    cancel(handoffId, by) {
      const handoff = getHandoffOrThrow(handoffId);
      assertState(handoff, ['proposed'], 'cancel');
      assertActor(handoff, by, 'from', 'cancel');
      return transition(handoff, 'cancelled', by, {});
    },

    /** Read-only snapshot of a handoff (null if unknown). */
    get(id) {
      const handoff = handoffs.get(id);
      return handoff ? snapshot(handoff) : null;
    },

    /**
     * List handoff snapshots, optionally filtered by agentId (matches either
     * fromAgent or toAgent), state, and/or taskId.
     */
    list({ agentId, state, taskId } = {}) {
      return [...handoffs.values()]
        .filter((h) => agentId === undefined || h.fromAgent === agentId || h.toAgent === agentId)
        .filter((h) => state === undefined || h.state === state)
        .filter((h) => taskId === undefined || h.taskId === taskId)
        .map(snapshot);
    },

    /**
     * Append-only per-handoff transition history: the audit entries for this
     * handoff (including its proposal) in chronological order. Throws
     * HO_NOT_FOUND for unknown ids.
     */
    history(handoffId) {
      getHandoffOrThrow(handoffId);
      return audit
        .filter(
          (entry) =>
            entry.detail &&
            entry.detail.handoffId === handoffId,
        )
        .map((entry) => ({ ...entry }));
    },

    /** Full store snapshot: {schemaVersion, savedAt, handoffs, audit}. */
    snapshot() {
      return persist();
    },

    /**
     * Replace the store contents from a snapshot. Validates schema version
     * and shape first — anything malformed throws HO_CORRUPT_SNAPSHOT and the
     * current state is left untouched.
     */
    restore(data, actor = 'agent') {
      validateSnapshot(data);
      const previous = [...handoffs.values()];
      const prevAuditLength = audit.length;
      writeThrough({
        mutate: () => {
          handoffs.clear();
          for (const h of data.handoffs) {
            handoffs.set(h.id, {
              id: h.id,
              fromAgent: h.fromAgent,
              toAgent: h.toAgent,
              taskId: h.taskId ?? null,
              summary: h.summary,
              context: h.context === undefined ? undefined : { ...h.context },
              createdAt: h.createdAt,
              state: h.state,
              decidedAt: h.decidedAt ?? null,
              decidedBy: h.decidedBy ?? null,
              rejectReason: h.rejectReason ?? null,
              completeNote: h.completeNote ?? null,
            });
          }
          audit.length = 0;
          for (const entry of data.audit) {
            audit.push(Object.freeze({ ...entry }));
          }
          record({
            at: clock(),
            from: null,
            to: 'restored',
            actor,
            detail: {
              handoffCount: data.handoffs.length,
              schemaVersion: data.schemaVersion,
            },
          });
        },
        undo: () => {
          handoffs.clear();
          for (const h of previous) handoffs.set(h.id, h);
          audit.length = prevAuditLength;
        },
      });
      notify('restored', null, actor);
      return data.handoffs.length;
    },
  };

  // Load persisted state through the injected storage on creation, so a
  // process restart rehydrates without losing handoffs.
  try {
    const loaded = storage.load();
    if (loaded != null) store.restore(loaded, 'system');
  } catch (err) {
    if (err instanceof Error && err.code === 'HO_CORRUPT_SNAPSHOT') throw err;
    throw handoffError(
      'HO_STORAGE_ERROR',
      `Storage load failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error ? err.message : String(err) },
    );
  }

  return Object.freeze(store);
}
